import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import * as servers from "./servers.js";
import * as sysinfo from "./sysinfo.js";
import {
  issueToken, verifyToken,
  tooManyAttempts, registerFailure, clearFailures,
} from "./auth.js";
import * as usuariosMod from "./usuarios.js";
import * as eventosMod from "./eventos.js";
import { regraDe, servidorDaUrl } from "./permissoes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8095);

/**
 * Onde ficam os dados do PAINEL (usuários, eventos), que não são de um servidor
 * específico. Sem `PANEL_DATA`, usa o volume do primeiro servidor configurado:
 * ele é obrigatório e gravável, então a instalação existente não precisa de
 * volume novo nenhum para ganhar multiusuário.
 */
const PAINEL_DADOS = process.env.PANEL_DATA || servers.lista()[0]?.cfg.dados || "/mcdata";

const registroLog = (lvl, msg) => console.warn(`[painel] ${msg}`);
const usuarios = usuariosMod.criar({ dados: PAINEL_DADOS, log: registroLog });
const eventos = eventosMod.criar({ dados: PAINEL_DADOS, log: registroLog });

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || "warn" } });

// DELETE chega sem corpo; o parser padrão do Fastify trata isso como erro
app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  if (!body || !body.trim()) return done(null, {});
  try { done(null, JSON.parse(body)); } catch (err) { err.statusCode = 400; done(err); }
});

// o corpo do restore é o .tar.gz cru: entregue como stream, sem nunca passar pela memória.
// Vários tipos porque o navegador rotula .tar.gz de jeitos diferentes conforme o SO.
// idem para o .jar do upload de mod: o navegador rotula de várias formas
for (const tipo of [
  "application/gzip", "application/x-gzip", "application/octet-stream", "application/x-compressed-tar",
  "application/java-archive", "application/x-java-archive", "application/zip",
]) {
  app.addContentTypeParser(tipo, (req, payload, done) => done(null, payload));
}

/* ---------------- helpers ---------------- */

const NICK_RE = /^[A-Za-z0-9_]{1,16}$/;

class BadRequest extends Error {
  constructor(msg) { super(msg); this.statusCode = 400; }
}

function nick(value) {
  const v = String(value ?? "").trim();
  if (!NICK_RE.test(v)) throw new BadRequest("nick inválido");
  return v;
}

function text(value, max = 256) {
  // \p{Cc} = caracteres de controle; quebra de linha viraria um comando extra no RCON
  const v = String(value ?? "").replace(/\p{Cc}/gu, " ").trim();
  if (!v) throw new BadRequest("mensagem vazia");
  return v.slice(0, max);
}

const conflito = (msg) => Object.assign(new Error(msg), { statusCode: 409 });

/* ---------------- auth ---------------- */

app.post("/api/auth/login", async (req, reply) => {
  const ip = req.ip;
  if (tooManyAttempts(ip)) return reply.code(429).send({ error: "muitas tentativas, espere 15 min" });
  const { user, password } = req.body ?? {};
  const conta = usuarios.autenticar(user, password);
  if (!conta) {
    registerFailure(ip);
    // guarda a tentativa com o nome digitado, que é o que denuncia acesso indevido
    req.eventoLogin = { user: String(user ?? "").slice(0, 32), ok: false };
    return reply.code(401).send({ error: "usuário ou senha inválidos" });
  }
  clearFailures(ip);
  req.eventoLogin = { user: conta.user, ok: true };
  return { token: issueToken(conta.user), user: conta.user, papel: conta.papel };
});

// defesa barata: ninguém emoldura o painel, nada é interpretado fora do tipo declarado.
// CSP completo não: o frontend é um HTML único com script/style inline — exigiria
// unsafe-inline, que anularia o ganho. frame-ancestors já cobre clickjacking.
app.addHook("onSend", async (req, reply) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Content-Security-Policy", "frame-ancestors 'none'");
  reply.header("Referrer-Policy", "no-referrer");
  if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
});

// baixar é navegação do navegador: não dá pra mandar header, vai de ticket.
// Cobre o backup ao vivo (/backup/world) e os arquivos já gravados em disco
// (/backup/arquivos/<nome>) — o POST que emite o ticket é autenticado.
const BACKUP_URL_RE = /^\/api\/servers\/([a-z0-9-]+)\/backup\/(?:world|arquivos\/[^/?]+)(?:\?|$)/;

app.addHook("onRequest", async (req, reply) => {
  if (!req.url.startsWith("/api/")) return;
  if (req.url.startsWith("/api/auth/login")) return;

  // só GET: o ticket serve para BAIXAR. Apagar continua exigindo token, senão
  // a mesma URL com DELETE apagaria backup com um ticket de download.
  const bk = req.method === "GET" && BACKUP_URL_RE.exec(req.url);
  if (bk) {
    const srv = servers.pegar(bk[1]);
    if (srv?.backup.useTicket(String(req.query?.ticket || ""))) return;
    return reply.code(401).send({ error: "ticket inválido ou expirado" });
  }

  const header = req.headers.authorization || "";
  const payload = verifyToken(header.startsWith("Bearer ") ? header.slice(7) : "");
  if (!payload) return reply.code(401).send({ error: "não autenticado" });
  req.user = payload.sub;

  // o papel vem do arquivo agora, não do token: tirar o acesso de alguém precisa
  // valer na hora, e não só quando o crachá dele vencer daqui a uma semana
  req.papel = usuarios.papelDe(payload.sub);
  if (!req.papel) return reply.code(401).send({ error: "este usuário não existe mais" });

  const regra = regraDe(req.method, req.url);
  req.regra = regra;
  if (!usuariosMod.podeMais(req.papel, regra.papel)) {
    return reply.code(403).send({ error: `esta ação é de ${regra.papel}; você é ${req.papel}` });
  }
});

/**
 * O histórico, num lugar só. Aqui já se sabe quem chamou, o que respondeu e se
 * deu certo — espalhar isso pelos ~45 handlers seria mais código e garantiria
 * esquecer algum. Só grava mutação e login; `GET` viraria ruído.
 */
app.addHook("onResponse", async (req, reply) => {
  try {
    if (req.eventoLogin) {
      eventos.registrar({
        quem: req.eventoLogin.user,
        papel: req.eventoLogin.ok ? usuarios.papelDe(req.eventoLogin.user) : null,
        acao: req.eventoLogin.ok ? "login" : "login.falhou",
        resumo: req.eventoLogin.ok ? "entrou no painel" : "errou usuário ou senha",
        ip: req.ip,
        ok: req.eventoLogin.ok,
      });
      return;
    }
    if (req.method === "GET" || !req.regra?.acao) return;
    // 4xx de validação não é ação: registrar tentativa inválida encheria o
    // arquivo de ruído. 403 de permissão importa e é gravado.
    const st = reply.statusCode;
    if (st >= 400 && st !== 403) return;
    // "ligou o backup automático" com ok=false lido rápido parece que ligou; o
    // prefixo deixa a linha honesta mesmo lendo o arquivo cru, sem a interface
    const base = req.regra.resumo?.(req, req.regra.m) ?? null;
    eventos.registrar({
      quem: req.user,
      papel: req.papel,
      acao: req.regra.acao,
      resumo: st === 403 && base ? `tentou: ${base}` : base,
      servidor: servidorDaUrl(req.url),
      ip: req.ip,
      ok: st < 400,
    });
  } catch (err) {
    registroLog("warn", `evento não registrado: ${err.message}`);
  }
});

/* ---------------- usuários do painel ---------------- */

app.get("/api/usuarios", async (req) => ({ usuarios: usuarios.listar(), eu: req.user }));

app.post("/api/usuarios", async (req) => usuarios.adicionar(req.body ?? {}, req.user));

app.put("/api/usuarios/:user", async (req) => usuarios.alterar(req.params.user, req.body ?? {}, req.user));

app.delete("/api/usuarios/:user", async (req) => usuarios.remover(req.params.user, req.user));

/* ---------------- histórico de eventos ---------------- */

app.get("/api/eventos", async (req) => ({
  ...eventos.ler({
    dias: req.query.dias,
    quem: req.query.quem,
    acao: req.query.acao,
    limite: req.query.limite,
  }),
  pessoas: eventos.quemJaApareceu(),
}));

/* ---------------- lista de servidores ---------------- */

app.get("/api/servers", async () => ({ servers: servers.resumo() }));

/* ---------------- tudo o que é de UM servidor ---------------- */

async function rotasServidor(app) {
  // o prefixo carrega o :id; resolver aqui deixa todo handler abaixo com req.srv pronto
  app.addHook("preHandler", async (req) => {
    const srv = servers.pegar(req.params.id);
    if (!srv) throw Object.assign(new Error("servidor desconhecido"), { statusCode: 404 });
    req.srv = srv;
  });

  /* ---------------- leitura ---------------- */

  app.get("/state", async (req) => {
    const { srv } = req;
    const since = Number(req.query.seq || 0);
    // alguém está olhando: acelera a medição de TPS (ela mede sempre, mas devagar)
    srv.tps.acordar();
    return {
      // O relógio do servidor. Todo tempo mostrado no painel ("online há", uptime,
      // "faltam X para o reinício") era calculado com o relógio de quem estava
      // olhando — e máquina com hora errada é comum: em dual boot, o Windows lê
      // como hora local o relógio que o Linux gravou em UTC, e fica adiantado
      // exatamente o fuso. Mandando o instante daqui, a interface mede pelo
      // servidor e o relógio do visitante deixa de importar.
      agora: Date.now(),
      // a interface esconde o que o papel não alcança; quem decide de verdade é
      // o hook de permissão, isto é só para não oferecer botão que dá 403
      eu: { user: req.user, papel: req.papel },
      server: {
        id: srv.id,
        name: srv.nome,
        address: srv.endereco,
        online: srv.state.online,
        count: srv.state.count,
        max: srv.state.max,
        version: srv.state.version,
        plataforma: srv.state.plataforma,
        startedAt: srv.state.startedAt,
        whitelistEnabled: srv.state.whitelistEnabled,
        onlineMode: srv.state.onlineMode,
        error: srv.state.error,
      },
      servers: servers.resumo(),
      host: sysinfo.read(),
      tps: srv.tps.estado(),
      agenda: srv.agenda.status(),
      power: { enabled: srv.docker.habilitado() },
      players: srv.state.players,
      bans: srv.state.bans,
      whitelist: srv.state.whitelist,
      console: { seq: srv.consoleSeq(), lines: srv.consoleDesde(since) },
    };
  });

  /** Conversa do dia — o ring do console só guarda as últimas 500 linhas de tudo. */
  app.get("/chat/history", async (req) => ({ lines: req.srv.mc.chatHistory() }));

  /**
   * Mods instalados. Fora do /state de propósito: a varredura abre dezenas de jars
   * e fala com o Modrinth, coisa que não pode entrar num polling de 2 segundos.
   * Carrega sob demanda, como o histórico e o backup.
   */
  app.get("/mods", async (req) => req.srv.mods.listar());

  /**
   * Ativar e desativar é mover o jar entre `mods/` e `mods-off/` — nenhum
   * carregador recarrega mod a quente, então isto só vale no próximo boot e a
   * interface diz isso. O nome do arquivo vai no corpo, não na URL: mod tem
   * espaço, parêntese e `+` no nome, e caminho em rota é onde mora o traversal.
   */
  app.post("/mods/estado", async (req) => {
    const { arquivo, ativo } = req.body ?? {};
    if (typeof ativo !== "boolean") throw new BadRequest("falta dizer se ativa ou desativa");
    const r = req.srv.mods.mover(arquivo, ativo);
    req.srv.push("info", `mod ${ativo ? "ativado" : "desativado"}: ${r.arquivo} (vale no próximo reinício)`, "panel");
    return r;
  });

  /** Apaga o jar de vez, esteja ele ativo ou desativado. Não tem desfazer. */
  app.post("/mods/remover", async (req) => {
    const r = req.srv.mods.apagar((req.body ?? {}).arquivo);
    req.srv.push("warn", `mod removido do disco: ${r.arquivo}`, "panel");
    return r;
  });

  /* ---------------- instalar mod (fase 3) ---------------- */

  /** Busca no Modrinth já cercada pelo carregador e pela versão deste servidor. */
  app.get("/mods/buscar", async (req) => ({
    resultados: await req.srv.mods.buscar(String(req.query.q || "").slice(0, 120)),
  }));

  /** O que mais precisa entrar junto para este mod funcionar. */
  app.get("/mods/dependencias", async (req) => ({
    faltando: await req.srv.mods.dependenciasFaltando(String(req.query.projeto || "")),
  }));

  /** O painel baixa do Modrinth, confere o hash publicado e acomoda. */
  app.post("/mods/instalar", async (req) => {
    const { projeto, forcar } = req.body ?? {};
    if (!projeto) throw new BadRequest("falta dizer qual mod");
    const r = await req.srv.mods.instalar(String(projeto), { forcar: forcar === true });
    req.srv.push("info", `mod instalado: ${r.arquivo}${r.ativo ? "" : " (desativado: incompatível)"}`, "panel");
    return r;
  });

  /**
   * Upload manual. O corpo é o .jar cru — sem multipart, sem dependência nova,
   * do mesmo jeito que o restore do mundo já faz. O nome vem na query porque o
   * corpo inteiro é o arquivo.
   */
  /* ---------------- atualizar e aplicar (fase 4) ---------------- */

  /** Troca um mod pela versão mais nova compatível; o jar velho vai para a lixeira. */
  app.post("/mods/atualizar", async (req) => {
    const { arquivo } = req.body ?? {};
    if (!arquivo) throw new BadRequest("falta dizer qual mod");
    const r = await req.srv.mods.atualizar(String(arquivo));
    req.srv.push("info", `mod atualizado: ${r.nome} ${r.versaoAntiga || "?"} → ${r.versaoNova}`, "panel");
    return r;
  });

  /** Atualiza tudo o que tem versão nova. Erro num mod não derruba os outros. */
  app.post("/mods/atualizar-todos", async (req) => {
    const r = await req.srv.mods.atualizarTodos();
    req.srv.push("info", `atualização em lote: ${r.feitos.length} de ${r.total} mod(s)`, "panel");
    return r;
  });

  /**
   * Reinicia para valer as mudanças e vigia o boot. Se o servidor não voltar, o
   * painel devolve os mods de antes e reinicia de novo — sozinho. Responde na
   * hora; o andamento sai em `/mods/aplicar/status`.
   */
  app.post("/mods/aplicar", async (req) => req.srv.aplicarMods.aplicar());
  app.get("/mods/aplicar/status", async (req) => req.srv.aplicarMods.status());

  app.put("/mods/arquivo", { bodyLimit: 256 * 1024 * 1024 }, async (req) => {
    const nome = String(req.query.nome || "").trim();
    if (!nome) throw new BadRequest("falta o nome do arquivo");
    const r = await req.srv.mods.enviar(req.body, nome, { forcar: req.query.forcar === "1" });
    req.srv.push("info", `mod enviado: ${r.arquivo}${r.ativo ? "" : " (desativado: incompatível)"}`, "panel");
    return r;
  });

  /** Quem já passou pelo servidor — reconstruído do log, não do RCON. */
  app.get("/history", async (req) => ({
    players: req.srv.history.list(req.srv.state.online ? req.srv.state.players : []),
    since: req.srv.history.oldest(),
  }));

  /* ---------------- backup do mundo ---------------- */

  app.get("/backup/info", async (req) => ({
    sizeBytes: await req.srv.backup.size(),
    busy: req.srv.backup.isBusy(),
  }));

  app.post("/backup/ticket", async (req) => {
    const { srv } = req;
    if (srv.backup.isBusy()) throw conflito("já existe um backup em andamento");
    if (srv.restore.ocupado()) throw conflito("há uma restauração em andamento — backup só depois");
    return srv.backup.issueTicket();
  });

  app.get("/backup/world", async (req, reply) => {
    const { srv } = req;
    // restauração para o contêiner no meio: o tar sairia truncado
    if (srv.restore.ocupado()) throw conflito("há uma restauração em andamento — backup só depois");
    const { stream, done, stderrRef } = await srv.backup.start(srv.run);
    srv.push("info", "backup do mundo iniciado — save-off até terminar", "panel");

    // fim normal, erro no meio ou aba fechada: sempre devolve o save-on
    reply.raw.on("close", () => {
      done().then(() => {
        const err = stderrRef().trim();
        srv.push(err ? "warn" : "info", err ? `backup terminou com aviso: ${err}` : "backup do mundo concluído — save-on", "panel");
      });
    });

    return reply
      .header("Content-Type", "application/gzip")
      .header("Content-Disposition", `attachment; filename="${srv.backup.filename()}"`)
      .header("Cache-Control", "no-store")
      .send(stream);
  });

  /* ---------------- restaurar o mundo ---------------- */

  app.get("/restore/status", async (req) => req.srv.restore.status());
  app.get("/restore/preserved", async (req) => ({ mundos: await req.srv.restore.preservados() }));

  app.delete("/restore/preserved/:nome", async (req) => {
    await req.srv.restore.apagarPreservado(String(req.params.nome));
    return { ok: true };
  });

  app.put("/restore/world", { bodyLimit: 16 * 1024 ** 3 }, async (req) => {
    const { srv } = req;
    if (!srv.docker.habilitado()) throw Object.assign(new Error("restaurar exige o controle do contêiner"), { statusCode: 501 });
    // o backup segura um save-off + tar em streaming; parar o servidor agora estragaria os dois
    if (srv.backup.isBusy()) throw conflito("há um backup em andamento — restaure depois que ele terminar");
    const tamanho = Number(req.headers["content-length"]) || null;
    srv.push("cmd", "restaurar mundo a partir de um backup enviado", "panel");
    return srv.restore.restaurar(req.body ?? req.raw, {
      tamanho,
      docker: srv.docker,
      run: srv.run,
      log: (lvl, msg) => srv.push(lvl, msg, "panel"),
    });
  });

  /* ---------------- energia do servidor ---------------- */

  app.get("/power", async (req) => req.srv.docker.estado());

  app.post("/power/:acao", async (req) => {
    const { srv } = req;
    const acao = String(req.params.acao);
    if (!["restart", "stop", "start"].includes(acao)) throw new BadRequest("ação inválida");
    // antes de qualquer efeito colateral (flush, linhas no console)
    if (!srv.docker.habilitado()) throw Object.assign(new Error("controle do contêiner não configurado"), { statusCode: 501 });

    // desligar leva o mundo junto: força um flush antes de o SIGTERM chegar.
    // Se o RCON já estiver fora do ar, segue mesmo assim — é o caso de reiniciar travado.
    if (acao !== "start") {
      await srv.run("save-all flush").catch(() => {});
    }

    srv.push("cmd", `docker ${acao} ${srv.cfg.container}`, "panel");
    try {
      if (acao === "restart") await srv.docker.reiniciar();
      else if (acao === "stop") await srv.docker.parar();
      else await srv.docker.iniciar();
    } catch (err) {
      srv.push("err", `falha no ${acao}: ${err.message}`, "panel");
      throw err;
    }
    srv.push("info", `contêiner: ${acao} concluído`, "panel");

    await srv.refresh().catch(() => {});
    return { ok: true, ...(await srv.docker.estado()) };
  });

  /* ---------------- reinício agendado ---------------- */

  /**
   * Histórico de desempenho para o gráfico. Fora do /state porque são 1.440
   * pontos: pesado demais para um polling de 2s, e muda devagar.
   */
  app.get("/tps/historico", async (req) => req.srv.tpsHist.ler(req.query.horas));

  /* ---------------- backup automático ---------------- */

  app.get("/backup/auto", async (req) => req.srv.backupAuto.status());
  app.put("/backup/auto", async (req) => req.srv.backupAuto.definir(req.body ?? {}));
  app.post("/backup/auto/agora", async (req) => req.srv.backupAuto.agora());

  /** Tudo que está na pasta de backups, inclusive o que o painel não gerencia. */
  app.get("/backup/arquivos", async (req) => ({ arquivos: req.srv.backupAuto.listar() }));

  app.delete("/backup/arquivos/:nome", async (req) => req.srv.backupAuto.apagar(req.params.nome));

  /** Ticket de uso único para baixar: GET de navegador não manda Authorization. */
  app.post("/backup/arquivos/:nome/ticket", async (req) => {
    req.srv.backupAuto.caminho(req.params.nome); // 404 antes de emitir ticket à toa
    return req.srv.backup.issueTicket();
  });

  /** Baixa um backup já gravado. Autenticado por ticket, no hook lá de cima. */
  app.get("/backup/arquivos/:nome", async (req, reply) => {
    const caminho = req.srv.backupAuto.caminho(req.params.nome);
    return reply
      .header("Content-Type", "application/gzip")
      .header("Content-Disposition", `attachment; filename="${path.basename(caminho)}"`)
      .header("Cache-Control", "no-store")
      .send(fs.createReadStream(caminho));
  });

  app.get("/agenda", async (req) => req.srv.agenda.status());
  app.put("/agenda", async (req) => req.srv.agenda.definir(req.body ?? {}));
  app.post("/agenda/pular", async (req) => req.srv.agenda.pularProxima());

  /* ---------------- ações ---------------- */

  app.post("/command", async (req) => {
    const cmd = text(req.body?.command, 512).replace(/^\//, "");
    return { output: await req.srv.run(cmd) };
  });

  app.post("/players/:nick/kick", async (req) => {
    const n = nick(req.params.nick);
    const reason = req.body?.reason ? text(req.body.reason) : "";
    return { output: await req.srv.run(`kick ${n}${reason ? ` ${reason}` : ""}`) };
  });

  app.post("/bans", async (req) => {
    const n = nick(req.body?.nick);
    const reason = req.body?.reason ? text(req.body.reason) : "";
    const output = await req.srv.run(`ban ${n}${reason ? ` ${reason}` : ""}`);
    await req.srv.refresh();
    return { output };
  });

  app.delete("/bans/:nick", async (req) => {
    const output = await req.srv.run(`pardon ${nick(req.params.nick)}`);
    await req.srv.refresh();
    return { output };
  });

  app.post("/whitelist", async (req) => {
    const output = await req.srv.run(`whitelist add ${nick(req.body?.nick)}`);
    await req.srv.refresh();
    return { output };
  });

  app.delete("/whitelist/:nick", async (req) => {
    const output = await req.srv.run(`whitelist remove ${nick(req.params.nick)}`);
    await req.srv.refresh();
    return { output };
  });

  app.post("/whitelist/toggle", async (req) => {
    const on = req.body?.on === true;
    const output = await req.srv.run(`whitelist ${on ? "on" : "off"}`);
    await req.srv.refresh();
    return { output };
  });

  app.post("/chat/broadcast", async (req) => {
    return { output: await req.srv.run(`say ${text(req.body?.message)}`) };
  });

  app.post("/chat/private", async (req) => {
    const n = nick(req.body?.nick);
    return { output: await req.srv.run(`tell ${n} ${text(req.body?.message)}`) };
  });
}

app.register(rotasServidor, { prefix: "/api/servers/:id" });

/* ---------------- erros + estáticos ---------------- */

app.setErrorHandler((err, req, reply) => {
  const code = err.statusCode && err.statusCode < 500 ? err.statusCode : 502;
  // a recusa por incompatibilidade carrega o porquê destrinchado: a interface
  // precisa dele para explicar e oferecer o "enviar mesmo assim"
  const extra = err.veredito ? { veredito: err.veredito, arquivo: err.arquivo, nome: err.nome } : {};
  reply.code(code).send({ error: err.message || "erro interno", ...extra });
});

app.register(fastifyStatic, { root: path.join(__dirname, "..", "public") });

app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "rota inexistente" });
  return reply.sendFile("index.html");
});

/* ---------------- boot ---------------- */

await servers.iniciarTodos();

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`CraftControl ouvindo em :${PORT} — ${servers.lista().map((s) => `${s.id}@${s.cfg.rconHost}:${s.cfg.rconPorta}`).join(", ")}`);
