import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

/**
 * Restaurar um backup do mundo, sem perder o que está lá.
 *
 * A ordem importa: o pacote é recebido, conferido e extraído com o servidor ainda
 * NO AR. Só depois de ter uma pasta pronta e válida é que o contêiner é parado —
 * assim um arquivo corrompido falha sem derrubar ninguém, e a janela de servidor
 * fora do ar é só a de dois `rename` (instantâneos, mesmo sistema de arquivos).
 *
 * O mundo atual nunca é apagado: vira `world.antes-de-AAAAMMDD-HHMMSS` ao lado.
 * Quem limpa isso é o Carlos pelo painel — some sozinho seria pior que ocupar disco.
 */

const PRESERVADO_RE = /^world\.antes-de-\d{8}-\d{6}$/;

function roda(cmd, args, { timeout = 600_000, env = null } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${cmd} demorou demais`)); }, timeout);
    p.stdout.on("data", (b) => { if (out.length < 1e6) out += b; });
    p.stderr.on("data", (b) => { if (err.length < 1e5) err += b; });
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} falhou (${code}): ${err.trim().slice(0, 300)}`));
    });
  });
}

const rmrf = (alvo) => fs.promises.rm(alvo, { recursive: true, force: true });

function carimbo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function esperarParado(docker, limiteMs = 150_000) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    const e = await docker.estado().catch(() => null);
    if (e && e.rodando === false) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("o contêiner não parou no tempo esperado");
}

/** Uma restauração por servidor: cada uma com sua pasta de trabalho e seu estado. */
export function criar({ dados, mundo = "world" }) {
  const DATA = dados;
  const WORLD = mundo;
  const TRABALHO = path.join(DATA, ".mcpanel-restore");

  let estado = vazio();
  function vazio() {
    return { rodando: false, fase: null, detalhe: null, erro: null, ok: null, preservado: null, em: null };
  }

  function fase(nome, detalhe = null) {
    estado.fase = nome;
    estado.detalhe = detalhe;
  }

  /**
   * Confere a lista do pacote antes de gastar disco extraindo. Recusa qualquer coisa
   * que não seja exatamente uma pasta `world/` — caminho absoluto, `..` ou uma segunda
   * pasta no topo significam pacote de outra origem, e aí é melhor parar.
   *
   * Lista com `-v` para ver o TIPO de cada entrada: symlink/hardlink dentro do tar
   * permitiria escrever fora do staging na extração (link primeiro, arquivo através
   * dele depois). Mundo Minecraft legítimo não contém nenhum dos dois.
   * LC_ALL=C fixa o formato da listagem, que é o que o parse abaixo assume.
   */
  async function conferir(arquivo) {
    const lista = await roda("tar", ["-tvzf", arquivo], { env: { ...process.env, LC_ALL: "C" } });
    const linhas = lista.split("\n").map((s) => s.trimEnd()).filter(Boolean);
    // tar lê um .gz que não é tar sem reclamar e devolve lista vazia
    if (!linhas.length) throw new Error("não consegui ler nada dentro do arquivo — ele não parece um .tar.gz de mundo");

    const entradas = [];
    for (const linha of linhas) {
      const tipo = linha[0];
      if (tipo === "l" || tipo === "h") {
        throw new Error(`o pacote contém um ${tipo === "l" ? "symlink" : "hardlink"} — um mundo não tem isso: ${linha.slice(-80)}`);
      }
      // formato fixo (LC_ALL=C): perms dono tamanho data hora NOME; o nome é o resto
      const m = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(linha);
      if (!m) throw new Error(`não entendi uma linha da listagem do tar: ${linha.slice(0, 80)}`);
      const e = m[1];
      if (e.startsWith("/") || e.split("/").includes("..")) {
        throw new Error(`o pacote tem um caminho suspeito: ${e.slice(0, 80)}`);
      }
      if (e !== `${WORLD}/` && !e.startsWith(`${WORLD}/`)) {
        throw new Error(`o pacote precisa conter só a pasta ${WORLD}/ — achei "${e.slice(0, 60)}"`);
      }
      entradas.push(e);
    }
    if (!entradas.some((e) => e === `${WORLD}/level.dat`)) {
      throw new Error(`não achei ${WORLD}/level.dat no pacote — isso não parece um mundo`);
    }
    return entradas.length;
  }

  function livreEmDisco() {
    try {
      const s = fs.statfsSync(DATA);
      return s.bavail * s.bsize;
    } catch {
      return null;
    }
  }

  /**
   * @param stream  corpo da requisição (o .tar.gz cru)
   * @param tamanho Content-Length, quando o cliente informa
   * @param docker  módulo de energia, para parar/subir o contêiner
   * @param run     executor de RCON, para avisar e salvar antes
   * @param log     escreve no console do painel
   */
  async function restaurar(stream, { tamanho = null, docker, run, log }) {
    if (estado.rodando) throw Object.assign(new Error("já existe uma restauração em andamento"), { statusCode: 409 });
    estado = vazio();
    estado.rodando = true;
    estado.em = new Date().toISOString();

    const alvo = path.join(DATA, WORLD);
    const upload = path.join(TRABALHO, "upload.tar.gz");
    const staging = path.join(TRABALHO, "staging");
    let preservado = null;
    let paramos = false;

    try {
      // precisa caber o pacote + a extração dele; medido, o mundo cresce ~2,2x ao descompactar
      if (tamanho) {
        const livre = livreEmDisco();
        const preciso = tamanho * 3.5;
        if (livre != null && livre < preciso) {
          throw new Error(`não cabe: precisaria de ~${Math.ceil(preciso / 2 ** 30)} GB livres e há ${Math.floor(livre / 2 ** 30)} GB`);
        }
      }

      await rmrf(TRABALHO);
      await fs.promises.mkdir(staging, { recursive: true });

      fase("recebendo", "subindo o pacote para o servidor");
      await pipeline(stream, fs.createWriteStream(upload));
      const recebido = (await fs.promises.stat(upload)).size;
      if (!recebido) throw new Error("não chegou nada");
      log?.("info", `restauração: pacote recebido (${recebido} bytes)`);

      fase("conferindo", "olhando o conteúdo do pacote");
      const itens = await conferir(upload);
      log?.("info", `restauração: pacote válido, ${itens} arquivos`);

      fase("extraindo", `descompactando ${itens} arquivos`);
      // o painel roda como o MESMO uid do servidor (1000): o tar já extrai com o
      // dono certo e o chown que existia aqui deixou de ser necessário
      await roda("nice", ["-n", "10", "tar", "-xzf", upload, "-C", staging, "--no-same-owner"]);
      const novo = path.join(staging, WORLD);
      if (!fs.existsSync(path.join(novo, "level.dat"))) throw new Error("a extração não produziu um mundo utilizável");

      fase("parando", "desligando o servidor");
      await run?.("say [painel] restaurando um backup do mundo — o servidor volta já").catch(() => {});
      await run?.("save-all flush").catch(() => {});
      await docker.parar();
      paramos = true;
      await esperarParado(docker);
      log?.("info", "restauração: servidor parado, trocando o mundo");

      fase("trocando", "guardando o mundo atual e pondo o novo no lugar");
      preservado = path.join(DATA, `world.antes-de-${carimbo()}`);
      if (fs.existsSync(alvo)) await fs.promises.rename(alvo, preservado);
      try {
        await fs.promises.rename(novo, alvo);
      } catch (err) {
        // não deixa o servidor sem mundo nenhum
        if (fs.existsSync(preservado)) await fs.promises.rename(preservado, alvo).catch(() => {});
        preservado = null;
        throw err;
      }
      estado.preservado = path.basename(preservado);

      fase("subindo", "ligando o servidor de volta");
      await docker.iniciar();
      paramos = false;

      fase("limpando");
      await rmrf(TRABALHO);

      estado.ok = true;
      fase("pronto", `mundo restaurado; o anterior ficou em ${path.basename(preservado)}`);
      log?.("info", `restauração concluída — mundo anterior guardado em ${path.basename(preservado)}`);
      return { ok: true, preservado: path.basename(preservado) };
    } catch (err) {
      estado.ok = false;
      estado.erro = err.message || String(err);
      log?.("err", `restauração falhou: ${estado.erro}`);
      // se o servidor foi parado por nossa causa, ele não pode ficar caído por causa do erro
      if (paramos) {
        try { await docker.iniciar(); log?.("info", "servidor religado após a falha"); }
        catch (e2) { log?.("err", `não consegui religar o servidor: ${e2.message}`); }
      }
      await rmrf(TRABALHO).catch(() => {});
      throw err;
    } finally {
      estado.rodando = false;
    }
  }

  /* ---------------- mundos preservados ---------------- */

  let cacheTamanhos = { em: 0, mapa: {} };

  async function preservados() {
    let nomes = [];
    try {
      nomes = (await fs.promises.readdir(DATA)).filter((n) => PRESERVADO_RE.test(n));
    } catch {
      return [];
    }
    if (!nomes.length) return [];

    if (Date.now() - cacheTamanhos.em > 300_000) {
      const mapa = {};
      try {
        const saida = await roda("du", ["-sb", ...nomes.map((n) => path.join(DATA, n))], { timeout: 60_000 });
        for (const linha of saida.split("\n")) {
          const [b, caminho] = linha.split(/\t/);
          if (caminho) mapa[path.basename(caminho.trim())] = Number(b);
        }
      } catch { /* segue sem tamanho */ }
      cacheTamanhos = { em: Date.now(), mapa };
    }

    const out = [];
    for (const nome of nomes) {
      const st = await fs.promises.stat(path.join(DATA, nome)).catch(() => null);
      out.push({ nome, em: st ? st.mtime.toISOString() : null, bytes: cacheTamanhos.mapa[nome] ?? null });
    }
    return out.sort((a, b) => String(b.em).localeCompare(String(a.em)));
  }

  async function apagarPreservado(nome) {
    // o regex é a trava: só apaga o que o próprio painel criou, nunca o `world` de verdade
    if (!PRESERVADO_RE.test(nome)) throw Object.assign(new Error("nome inválido"), { statusCode: 400 });
    const alvo = path.join(DATA, nome);
    if (!fs.existsSync(alvo)) throw Object.assign(new Error("não existe mais"), { statusCode: 404 });
    await rmrf(alvo);
    cacheTamanhos = { em: 0, mapa: {} };
  }

  return {
    restaurar,
    preservados,
    apagarPreservado,
    status: () => estado,
    ocupado: () => estado.rodando,
  };
}
