import * as rconMod from "./rcon.js";
import * as mcdata from "./mcdata.js";
import * as historyMod from "./history.js";
import * as backupMod from "./backup.js";
import * as restoreMod from "./restore.js";
import * as dockerMod from "./docker.js";
import * as tpsMod from "./tps.js";
import * as agendaMod from "./agenda.js";
import * as modsMod from "./mods.js";
import * as aplicarMod from "./aplicar.js";
import * as backupAutoMod from "./backupauto.js";
import * as tpsHistMod from "./tpshist.js";

/**
 * Um painel, vários servidores.
 *
 * Cada servidor é um conjunto próprio de instâncias (RCON, leitura do volume,
 * histórico, backup, restauração, energia, TPS e agenda) — nada é compartilhado,
 * então um servidor fora do ar não segura a fila nem o console do outro. O que é
 * do host (CPU/RAM/disco em sysinfo.js) fica de fora daqui: é um só para todos.
 *
 * A lista vem do env `MC_SERVERS` (JSON). Sem ele, monta um servidor a partir das
 * variáveis avulsas de sempre — é o que faz o painel continuar de pé com o compose
 * antigo, sem precisar editar nada para subir esta versão.
 */

const POLL_MS = Number(process.env.POLL_MS || 5000);
const RING_MAX = 500;

/* ---------------- configuração ---------------- */

const ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

function lerConfig() {
  const bruto = (process.env.MC_SERVERS || "").trim();
  if (!bruto) return [legado()];

  let lista;
  try {
    lista = JSON.parse(bruto);
  } catch (err) {
    throw new Error(`MC_SERVERS não é um JSON válido: ${err.message}`);
  }
  if (!Array.isArray(lista) || !lista.length) throw new Error("MC_SERVERS precisa ser uma lista com pelo menos um servidor");

  const vistos = new Set();
  return lista.map((s, i) => {
    const id = String(s.id ?? "").trim();
    if (!ID_RE.test(id)) throw new Error(`servidor #${i + 1}: id inválido ("${id}") — use letras minúsculas, números e hífen`);
    if (vistos.has(id)) throw new Error(`servidor "${id}": id repetido`);
    vistos.add(id);
    if (!s.dados) throw new Error(`servidor "${id}": falta "dados" (o caminho do volume dentro do painel)`);

    // a senha nunca vem no JSON: vem o NOME da variável de ambiente que a guarda,
    // pra que o segredo continue só no .env (chmod 600) e fora de qualquer log
    const senhaEnv = String(s.senhaEnv || "RCON_PASSWORD");
    const senha = process.env[senhaEnv] || "";
    if (!senha) throw new Error(`servidor "${id}": a variável ${senhaEnv} está vazia`);

    return {
      id,
      nome: String(s.nome || id),
      endereco: String(s.endereco || ""),
      rconHost: String(s.rconHost || "mc"),
      rconPorta: Number(s.rconPorta || 25575),
      senha,
      dados: String(s.dados),
      mundo: String(s.mundo || "world"),
      backups: s.backups ? String(s.backups) : null,
      container: s.container ? String(s.container) : null,
      versaoPadrao: s.versao ? String(s.versao) : null,
    };
  });
}

/** Compatibilidade: o compose de antes do multi-servidor. */
function legado() {
  return {
    id: "principal",
    nome: process.env.MC_NAME || "MeuServidor",
    endereco: process.env.MC_ADDRESS || "",
    rconHost: process.env.RCON_HOST || "mc",
    rconPorta: Number(process.env.RCON_PORT || 25575),
    senha: process.env.RCON_PASSWORD || "",
    dados: process.env.MC_DATA || "/mcdata",
    mundo: process.env.MC_WORLD || "world",
    backups: process.env.MC_BACKUPS || null,
    container: process.env.MC_CONTAINER || "minecraft",
    versaoPadrao: process.env.MC_VERSION || null,
  };
}

/* ---------------- um servidor ---------------- */

function parseList(out) {
  const clean = out.replace(/§[0-9a-fk-or]/gi, "").trim();
  const m = /There are (\d+)[^\d]+(\d+) players online:?\s*(.*)$/s.exec(clean);
  if (!m) return null;
  const nicks = m[3].split(",").map((s) => s.trim()).filter(Boolean);
  return { count: Number(m[1]), max: Number(m[2]), nicks };
}

function criarServidor(cfg) {
  const rcon = rconMod.criar({ host: cfg.rconHost, porta: cfg.rconPorta, senha: cfg.senha });
  const mc = mcdata.criar({ dados: cfg.dados, versaoPadrao: cfg.versaoPadrao });
  const history = historyMod.criar({ dados: cfg.dados });
  const backup = backupMod.criar({ dados: cfg.dados, mundo: cfg.mundo });
  const restore = restoreMod.criar({ dados: cfg.dados, mundo: cfg.mundo });
  const docker = dockerMod.criar({ container: cfg.container });

  /* ---------------- console: anel de linhas ---------------- */

  let seq = 0;
  const ring = [];

  function push(lvl, msg, src = "log", t = null) {
    const limpa = String(msg).replace(/§[0-9a-fk-or]/gi, ""); // tira códigos de cor
    const line = {
      seq: ++seq,
      t: t || new Date().toTimeString().slice(0, 8),
      lvl,
      msg: limpa,
      src,
    };
    // marca a linha se ela for conversa: a aba de chat é um filtro do console,
    // então o dado só percorre um caminho e nunca sai de sincronia
    const chat = src === "log" ? mcdata.parseChat(limpa) : null;
    if (chat) line.chat = chat;
    ring.push(line);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    return line;
  }

  /* ---------------- estado ---------------- */

  const state = {
    online: false,
    count: 0,
    max: Number(mc.properties()["max-players"] || 0) || null,
    players: [],       // [{nick, since}]
    bans: [],
    whitelist: [],
    whitelistEnabled: false,
    onlineMode: true,
    version: null,
    plataforma: null,
    startedAt: null,
    error: null,
  };

  const firstSeen = new Map(); // nick -> ISO (aproximado: desde que o painel viu)

  async function refresh() {
    try {
      const parsed = parseList(await rcon.send("list"));
      if (!parsed) throw new Error("resposta inesperada do comando list");
      const now = new Date().toISOString();
      for (const nick of parsed.nicks) if (!firstSeen.has(nick)) firstSeen.set(nick, now);
      for (const nick of firstSeen.keys()) if (!parsed.nicks.includes(nick)) firstSeen.delete(nick);

      state.online = true;
      state.error = null;
      state.count = parsed.count;
      state.max = parsed.max;
      // o log manda: ele tem a hora real do "joined". O `firstSeen` fica de reserva
      // para quem já estava dentro quando o painel subiu, ou quando a rotação do
      // log levou o join embora
      state.players = parsed.nicks.map((nick) => ({
        nick,
        since: history.sessaoAberta(nick) || firstSeen.get(nick),
      }));
    } catch (err) {
      state.online = false;
      state.error = err.message || String(err);
      state.count = 0;
      state.players = [];
      firstSeen.clear();
    }

    const props = mc.properties();
    state.bans = mc.bans();
    state.whitelist = mc.whitelist();
    state.whitelistEnabled = props["white-list"] === "true";
    // com o servidor em offline-mode a whitelist funciona igual, mas passa a ser
    // por nome: o painel precisa saber para não prometer o que ela não entrega
    state.onlineMode = props["online-mode"] !== "false";
    if (props["max-players"] && !state.max) state.max = Number(props["max-players"]);
    state.version = mc.version();
    state.plataforma = mc.plataforma();
    state.startedAt = mc.startedAt();
  }

  /** Motor único: todo botão do painel cai aqui. */
  async function run(command) {
    push("cmd", command, "panel");
    try {
      const out = await rcon.send(command);
      const clean = (out || "").trim();
      push("info", clean || "(sem resposta)", "panel");
      return clean;
    } catch (err) {
      push("err", `falha ao executar: ${err.message}`, "panel");
      throw err;
    }
  }

  // O histórico nasce antes do medidor porque é ele quem recebe cada amostra.
  // O medidor não sabe do arquivo; o coletor não sabe do RCON.
  const tpsHist = tpsHistMod.criar({
    dados: cfg.dados,
    estadoServidor: () => state,
    log: (lvl, msg) => push(lvl, msg, "panel"),
  });
  const tps = tpsMod.criar({
    rcon,
    online: () => state.online,
    registrar: tpsHist.registrar,
  });

  // depois do `state` de propósito: a versão do jogo sai do log e só existe a partir
  // do primeiro refresh, e o Modrinth precisa dela pra saber o que é atualização
  // compatível. Por isso vai como função, não como valor.
  const mods = modsMod.criar({
    dados: cfg.dados,
    versao: () => state.version || cfg.versaoPadrao,
    // idem: decide entre `mods/` e `plugins/`, e sai do log como a versão
    plataforma: () => state.plataforma,
    // carimbo do boot atual: é como a pendência de reinício sabe que já foi aplicada
    iniciadoEm: () => state.startedAt,
    // trocar jar no meio de uma troca de mundo é pedir para juntar dois problemas
    ocupado: () => backup.isBusy() || restore.ocupado(),
  });

  // reinicia, vigia o boot e desfaz sozinho se o servidor não voltar
  const aplicarMods = aplicarMod.criar({
    mods, docker,
    log: (lvl, msg) => push(lvl, msg, "panel"),
    estadoServidor: () => state,
    avisar: (msg) => run(`say ${msg}`),
  });

  // Backup automático. Sem MC_BACKUPS (ou "backups" no MC_SERVERS) o recurso
  // simplesmente não existe: é preciso um volume montado para gravar 500 MB,
  // e o painel não inventa um lugar para isso.
  const backupAuto = backupAutoMod.criar({
    dados: cfg.dados,
    destino: cfg.backups,
    backup, restore, run,
    log: (lvl, msg) => push(lvl, msg, "panel"),
    estadoServidor: () => state,
  });

  const agenda = agendaMod.criar({
    dados: cfg.dados,
    docker,
    run,
    log: (lvl, msg) => push(lvl, msg, "panel"),
    estadoServidor: () => state,
    backup,
    restore,
  });

  /** Sobe o histórico e começa a seguir o log. Chamado uma vez, no boot do painel. */
  async function iniciar() {
    // o histórico varre os arquivos até o fim do latest.log; o tail começa a ler
    // dali pra frente, então nenhum join/left é contado duas vezes nem se perde
    const conhecidos = history.build();
    console.log(`[${cfg.id}] histórico: ${conhecidos} jogador(es) reconstruído(s) do log`);

    mc.tail((raw, seeded) => {
      const { t, lvl, msg } = mcdata.parseLine(raw);
      // linha ao vivo chega em ~1s: carimba com o relógio do painel (fuso certo).
      // no histórico inicial não dá — usa o horário do próprio log.
      push(lvl, msg, "log", seeded ? t : null);
      if (seeded) return;
      history.feed(raw);
      // join/leave mexem na lista na hora, sem esperar o poll
      if (/(joined|left) the game$/.test(msg)) refresh().catch(() => {});
    });

    await refresh();
    setInterval(() => refresh().catch(() => {}), POLL_MS).unref();
  }

  return {
    id: cfg.id,
    nome: cfg.nome,
    endereco: cfg.endereco,
    cfg,
    rcon, mc, history, backup, restore, docker, tps, tpsHist, agenda, mods, aplicarMods, backupAuto,
    state,
    push,
    run,
    refresh,
    iniciar,
    consoleDesde: (desde) => (desde > 0 ? ring.filter((l) => l.seq > desde) : ring.slice(-120)),
    consoleSeq: () => seq,
  };
}

/* ---------------- registro ---------------- */

const servidores = new Map();
for (const cfg of lerConfig()) servidores.set(cfg.id, criarServidor(cfg));

export const lista = () => [...servidores.values()];
export const pegar = (id) => servidores.get(String(id)) || null;

/** Resumo para o seletor do topo — leve, cabe no polling. */
export const resumo = () => lista().map((s) => ({
  id: s.id,
  nome: s.nome,
  endereco: s.endereco,
  online: s.state.online,
  count: s.state.count,
  max: s.state.max,
}));

export async function iniciarTodos() {
  for (const s of lista()) await s.iniciar();
}
