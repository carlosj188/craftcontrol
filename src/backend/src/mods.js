import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";

import { identificar, escolherPerfil, PREFERENCIA } from "./modmeta.js";
import { avaliar } from "./compat.js";
import { erro400, erro404, erro409, erro422, erro429 } from "./erros.js";

/**
 * Mods de um servidor: listar, ativar/desativar, remover, instalar e atualizar.
 *
 * Lista o que está em `<dados>/mods` e `<dados>/mods-off`, abre cada .jar para
 * saber quem ele é de verdade (nome e versão do arquivo raramente batem com o
 * mod) e, se estiver ligado, pergunta ao Modrinth pelo SHA1 de cada um: dá o
 * nome bonito, a página, se roda no servidor e se existe versão mais nova.
 *
 * Decisões que valem lembrar:
 *
 * - **Cache por arquivo, chaveado por mtime+tamanho.** Abrir 57 jars e passar SHA1
 *   em 168 MB leva tempo; do segundo carregamento em diante só o que mudou é
 *   relido. O painel tem `mem_limit: 256m`, então o cache guarda metadado, nunca
 *   conteúdo de jar.
 * - **O cache do Modrinth invalida pela assinatura, não por decreto.** A chave é
 *   sha1(hashes ordenados + carregador + versão): mudou um jar, muda a assinatura
 *   e a consulta refaz sozinha; mover entre mods/ e mods-off não muda o conjunto
 *   e o cache continua valendo. Não zere `online` nas operações — já custou uma
 *   rodada inteira de Modrinth por clique de Desativar.
 * - **A consulta ao Modrinth é opcional e nunca bloqueia o resultado.** Sem
 *   internet, com a API fora do ar ou com `MODS_ONLINE=false`, a lista aparece
 *   igual — só sem o enriquecimento. É o que mantém o painel utilizável em
 *   servidor isolado, e isso importa porque o projeto vai ser compartilhado.
 */

const ONLINE = process.env.MODS_ONLINE !== "false";
const API = "https://api.modrinth.com/v2";
// a API do Modrinth exige User-Agent que identifique quem chama; quem hospeda pode
// trocar por um com contato próprio, como a documentação deles pede
const UA = process.env.MODRINTH_UA || "CraftControl/1.0 (painel Minecraft auto-hospedado)";
const TIMEOUT_MS = Number(process.env.MODRINTH_TIMEOUT_MS || 8000);
const TTL_MS = Number(process.env.MODS_CACHE_MS || 30 * 60 * 1000);
const MAX_JARS = 400;

/* ---------------- Modrinth ---------------- */

async function pedir(caminho, corpo) {
  const res = await fetch(API + caminho, {
    method: corpo ? "POST" : "GET",
    headers: { "User-Agent": UA, ...(corpo ? { "Content-Type": "application/json" } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // 404 e 429 são respostas legítimas sobre o pedido, não pane do painel: viram
    // 4xx com texto que explica, em vez do 502 genérico do handler de erro
    if (res.status === 404) throw erro404("esse mod não existe no Modrinth");
    if (res.status === 429) throw erro429("o Modrinth pediu para esperar um pouco (limite de consultas)");
    throw new Error(`Modrinth respondeu ${res.status}`);
  }
  return res.json();
}

/** Divide em blocos para não montar URL gigante nem payload fora do limite deles. */
const emBlocos = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/** Busca no catálogo, já cercada pelo carregador e pela versão deste servidor. */
export async function buscar({ termo, carregador, versaoJogo, limite = 20 }) {
  const facetas = [["project_type:mod"]];
  if (carregador) facetas.push([`categories:${carregador}`]);
  if (versaoJogo) facetas.push([`versions:${versaoJogo}`]);
  const q = new URLSearchParams({
    query: termo || "",
    facets: JSON.stringify(facetas),
    limit: String(Math.min(50, limite)),
    index: termo ? "relevance" : "downloads",
  });
  const r = await pedir(`/search?${q}`);
  return (r.hits || []).map((h) => ({
    id: h.project_id,
    slug: h.slug,
    titulo: h.title,
    descricao: h.description,
    autor: h.author,
    downloads: h.downloads,
    icone: h.icon_url || null,
    clienteSo: h.server_side === "unsupported",
  }));
}

/** A versão mais recente de um projeto que serve este servidor. */
export async function versaoParaInstalar({ projeto, carregador, versaoJogo }) {
  const q = new URLSearchParams();
  if (carregador) q.set("loaders", JSON.stringify([carregador]));
  if (versaoJogo) q.set("game_versions", JSON.stringify([versaoJogo]));
  const versoes = await pedir(`/project/${encodeURIComponent(projeto)}/version?${q}`);
  if (!versoes?.length) return null;
  // o Modrinth já devolve da mais nova para a mais velha
  const v = versoes[0];
  const arquivo = v.files.find((f) => f.primary) || v.files[0];
  if (!arquivo) return null;
  return {
    nomeVersao: v.version_number || v.name,
    url: arquivo.url,
    arquivo: arquivo.filename,
    bytes: arquivo.size,
    sha1: arquivo.hashes?.sha1 || null,
    loaders: v.loaders,
    game_versions: v.game_versions,
    dependencias: (v.dependencies || [])
      .filter((d) => d.dependency_type === "required" && d.project_id)
      .map((d) => d.project_id),
  };
}

/** Nome e lado de vários projetos de uma vez — usado no aviso de dependência. */
export async function projetos(ids) {
  if (!ids?.length) return [];
  return pedir(`/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`);
}

async function consultarModrinth(hashes, carregador, versaoJogo) {
  // os dois lookups por hash são independentes; só o /projects depende do primeiro.
  // Atualização sem carregador+versão não faz sentido: o Modrinth devolveria a
  // versão mais nova de qualquer coisa, inclusive incompatível.
  const [atuaisCru, novasCru] = await Promise.all([
    pedir("/version_files", { hashes, algorithm: "sha1" }),
    carregador && versaoJogo
      ? pedir("/version_files/update", {
          hashes, algorithm: "sha1", loaders: [carregador], game_versions: [versaoJogo],
        }).catch(() => ({}))
      : Promise.resolve({}),
  ]);

  const ids = [...new Set(Object.values(atuaisCru).map((v) => v.project_id).filter(Boolean))];
  const projs = {};
  for (const bloco of emBlocos(ids, 100)) {
    for (const p of await projetos(bloco).catch(() => [])) projs[p.id] = p;
  }

  // guarda só o que montar() lê: a resposta crua traz o changelog de cada versão
  // e o corpo em markdown de cada projeto — alguns MB presos por 30 min à toa
  const enxuto = (obj, fn) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
  return {
    atuais: enxuto(atuaisCru, (v) => ({ id: v.id, project_id: v.project_id })),
    novas: enxuto(novasCru, (v) => ({ id: v.id, versao: v.version_number || v.name, em: v.date_published || null })),
    projetos: enxuto(projs, (p) => ({ slug: p.slug, title: p.title, server_side: p.server_side })),
  };
}

/* ---------------- um servidor ---------------- */

export function criar({ dados, versao, iniciadoEm, ocupado = () => false }) {
  const PASTA = path.join(dados, "mods");
  // Fica dentro do volume de propósito: o painel só enxerga `<dados>`, então uma
  // pasta de desativados fora dele seria invisível.
  // O servidor não lê esta pasta — é exatamente isso que "desativado" significa.
  const OFF = path.join(dados, "mods-off");
  // Nada é apagado na hora: remover e atualizar largam o jar velho aqui, e a lixeira
  // só é esvaziada quando um boot saudável confirma que a mudança prestou. É o que
  // permite desfazer tudo automaticamente se o servidor não subir.
  const LIXO = path.join(dados, "mods-lixo");
  const PENDENTE = path.join(dados, "mcpanel", "mods-pendente.json");

  /** "on:"/"off:"+arquivo -> { mtimeMs, size, sha1, lido } */
  const cache = new Map();
  /** resultado do Modrinth, guardado por assinatura do acervo */
  let online = { assinatura: null, em: 0, dados: null, erro: null };
  let rodando = null;

  const existe = () => { try { return fs.statSync(PASTA).isDirectory(); } catch { return false; } };
  const carimboBoot = () => iniciadoEm() || null;
  /** Tira um nome do cache de jars — dos dois lados, porque rename não muda mtime. */
  const esquecer = (n) => { cache.delete("on:" + n); cache.delete("off:" + n); };

  function sha1(arquivo) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash("sha1");
      const s = fs.createReadStream(arquivo);
      s.on("error", reject);
      s.on("data", (d) => h.update(d));
      s.on("end", () => resolve(h.digest("hex")));
    });
  }

  /** Passa por cada .jar das duas pastas; só relê o que mudou desde a última vez. */
  async function varrer() {
    const listar = (dir) => {
      try {
        return fs.readdirSync(dir)
          .filter((n) => n.toLowerCase().endsWith(".jar") && !n.startsWith("."))
          .sort((a, b) => a.localeCompare(b, "pt-BR"));
      } catch { return []; }
    };
    // a chave do cache leva a pasta: o mesmo nome existe dos dois lados durante
    // a vida de um mod, e trocar de pasta não muda mtime nem tamanho
    const alvos = [
      ...listar(PASTA).map((n) => ({ nome: n, dir: PASTA, ativo: true })),
      ...listar(OFF).map((n) => ({ nome: n, dir: OFF, ativo: false })),
    ].slice(0, MAX_JARS);

    const vivos = new Set(alvos.map((a) => (a.ativo ? "on:" : "off:") + a.nome));
    for (const k of cache.keys()) if (!vivos.has(k)) cache.delete(k);

    const saida = [];
    for (const { nome, dir, ativo } of alvos) {
      const arquivo = path.join(dir, nome);
      let st;
      try { st = fs.statSync(arquivo); } catch { continue; }

      const chave = (ativo ? "on:" : "off:") + nome;
      let item = cache.get(chave);
      if (!item || item.mtimeMs !== st.mtimeMs || item.size !== st.size) {
        item = {
          mtimeMs: st.mtimeMs,
          size: st.size,
          lido: identificar(arquivo),
          sha1: await sha1(arquivo).catch(() => null),
        };
        cache.set(chave, item);
      }
      saida.push({ arquivo: nome, ativo, bytes: st.size, sha1: item.sha1, lido: item.lido });
    }
    return saida;
  }

  /**
   * Qual carregador este servidor usa.
   *
   * Só conta jar que declara **um** carregador: os multi-loader (fabric + forge +
   * neoforge no mesmo arquivo, comum em mod publicado pelo Modrinth) servem a
   * todos e por isso não são pista de nada — deixá-los votar faria uma pasta
   * Fabric parecer NeoForge só porque os jars genéricos estavam em maioria.
   */
  function carregadorDominante(lista) {
    const conta = {};
    for (const m of lista) {
      const cs = m.lido.carregadores;
      if (cs.length === 1) conta[cs[0]] = (conta[cs[0]] || 0) + 1;
    }
    let vencedor = Object.entries(conta).sort((a, b) => b[1] - a[1])[0]?.[0];
    // pasta só de mod multi-loader: cai para o que todos eles têm em comum
    if (!vencedor) {
      const comuns = lista.map((m) => m.lido.carregadores).filter((c) => c.length);
      if (comuns.length) {
        vencedor = PREFERENCIA.find((c) => comuns.every((cs) => cs.includes(c)));
      }
    }
    return PREFERENCIA.includes(vencedor) ? vencedor : null;
  }

  async function montar() {
    if (!existe()) {
      return {
        temPasta: false, carregador: null, versaoJogo: null,
        total: 0, desativados: 0, bytes: 0, pendente: null, mods: [],
        online: { ligado: ONLINE, ok: false, erro: null },
      };
    }

    const cru = await varrer();
    // duas passadas: primeiro descobre o carregador do servidor, só então escolhe
    // qual perfil de cada jar vale — um jar multi-loader tem um perfil por carregador
    const carregador = carregadorDominante(cru);
    const lista = cru.map(({ lido, ...resto }) => ({ ...resto, ...escolherPerfil(lido, carregador) }));
    const versaoJogo = versao() || null;

    let mr = null, erro = null;
    const hashes = lista.map((m) => m.sha1).filter(Boolean);
    if (ONLINE && hashes.length) {
      const assinatura = crypto.createHash("sha1")
        .update(hashes.slice().sort().join(",") + "|" + carregador + "|" + versaoJogo).digest("hex");
      if (online.assinatura === assinatura && Date.now() - online.em < TTL_MS) {
        mr = online.dados; erro = online.erro;
      } else {
        try {
          mr = await consultarModrinth(hashes, carregador, versaoJogo);
          online = { assinatura, em: Date.now(), dados: mr, erro: null };
        } catch (err) {
          erro = err.name === "TimeoutError" ? "o Modrinth demorou demais para responder" : err.message;
          // guarda o erro pelo TTL curto pra não repetir a espera a cada abertura da aba
          online = { assinatura, em: Date.now() - TTL_MS + 60000, dados: null, erro };
        }
      }
    }

    const mods = lista.map((m) => {
      const atual = mr?.atuais?.[m.sha1];
      const nova = mr?.novas?.[m.sha1];
      const proj = atual ? mr.projetos[atual.project_id] : null;
      const temAtualizacao = Boolean(atual && nova && nova.id !== atual.id);

      return {
        ...m,
        // o Modrinth conhece o nome de verdade; o jar às vezes só traz o modId
        nome: proj?.title || m.nome || m.arquivo.replace(/\.jar$/i, ""),
        modrinth: proj ? {
          slug: proj.slug,
          url: `https://modrinth.com/mod/${proj.slug}`,
          clienteSo: proj.server_side === "unsupported",
        } : null,
        atualizacao: temAtualizacao ? { versao: nova.versao, em: nova.em } : null,
      };
    });

    // Quem quebra se este mod sair do ar. Só conta dependente ATIVO: um mod já
    // desativado não vai reclamar de nada, e listá-lo assustaria à toa.
    //
    // Aqui vale `depende` inteiro, não o `dependeDeVerdade` que a interface usa
    // para contar: aquele esconde de propósito o que é onipresente (minecraft,
    // java, o próprio loader e a fabric-api), e é exatamente a fabric-api que
    // precisa aparecer neste aviso — é o mod cuja saída derruba o resto. Ids que
    // não são jar instalado (minecraft, java) simplesmente não casam com ninguém.
    const porId = new Map();
    for (const m of mods) if (m.id) porId.set(m.id, m);
    for (const m of mods) m.usadoPor = [];
    for (const m of mods) {
      if (!m.ativo) continue;
      for (const dep of m.depende) {
        const alvo = porId.get(dep);
        if (alvo && alvo !== m) alvo.usadoPor.push(m.nome);
      }
    }

    const ativos = mods.filter((m) => m.ativo);

    return {
      temPasta: true,
      carregador,
      versaoJogo,
      total: ativos.length,
      desativados: mods.length - ativos.length,
      bytes: ativos.reduce((s, m) => s + m.bytes, 0),
      pendente: pendenciaAtual(),
      mods,
      online: { ligado: ONLINE, ok: Boolean(mr), erro },
    };
  }

  /* ---------------- escrita ---------------- */

  /**
   * Resolve o caminho de um jar e recusa qualquer coisa que escape da pasta.
   *
   * O nome vem do cliente, então vale a paranoia: barra, `..` e caminho absoluto
   * saem fora, e depois disso o resultado ainda é conferido contra o prefixo da
   * pasta — `path.join` sozinho não protege, `resolve` + prefixo protege.
   */
  function caminhoSeguro(dir, nome) {
    const n = String(nome ?? "").trim();
    if (!n || n.length > 200) throw erro400("nome de arquivo inválido");
    if (n.includes("/") || n.includes("\\") || n.includes("\0") || n === "." || n === "..") {
      throw erro400("nome de arquivo inválido");
    }
    if (!/\.jar$/i.test(n)) throw erro400("só arquivo .jar");
    const cheio = path.resolve(dir, n);
    if (cheio !== path.join(path.resolve(dir), n)) throw erro400("nome de arquivo inválido");
    return cheio;
  }

  /**
   * Mudança em mods só vale no próximo boot — nenhum dos carregadores recarrega
   * jar a quente. O registro fica no volume (o painel é `read_only`) e guarda o
   * `iniciadoEm` de quando a mudança foi feita: quando o servidor sobe de novo,
   * esse carimbo muda e a pendência se resolve sozinha, inclusive se o painel
   * tiver sido reiniciado no meio.
   */
  function lerPendencia() {
    try { return JSON.parse(fs.readFileSync(PENDENTE, "utf8")); } catch { return null; }
  }

  function anotarPendencia(acao, arquivo, extra = {}) {
    const carimbo = carimboBoot();
    const atual = lerPendencia();
    const mudancas = (atual?.carimbo === carimbo ? atual.mudancas : []) || [];
    mudancas.push({ acao, arquivo, ...extra, em: new Date().toISOString() });
    try {
      fs.mkdirSync(path.dirname(PENDENTE), { recursive: true });
      // troca atômica, como o agenda.js faz: crash no meio nunca deixa o journal
      // pela metade — e é este arquivo que o desfazer() usa para reverter a pasta
      fs.writeFileSync(PENDENTE + ".tmp", JSON.stringify({ carimbo, mudancas: mudancas.slice(-50) }));
      fs.renameSync(PENDENTE + ".tmp", PENDENTE);
    } catch { /* sem o registro a interface só deixa de avisar; a ação já aconteceu */ }
  }

  const limparPendencia = () => { try { fs.unlinkSync(PENDENTE); } catch { /* já não existia */ } };

  /**
   * As mudanças ainda não confirmadas por um boot, em ordem. Carimbo antigo
   * significa que o servidor subiu depois delas — já valem, e o registro
   * obsoleto é descartado aqui mesmo.
   */
  function journal() {
    const p = lerPendencia();
    if (!p?.mudancas?.length) return [];
    if (p.carimbo !== carimboBoot()) { limparPendencia(); return []; }
    return p.mudancas;
  }

  function pendenciaAtual() {
    const m = journal();
    return m.length ? { desde: m[0].em, total: m.length } : null;
  }

  /** Guarda contra mexer na pasta enquanto o mundo está sendo trocado. */
  function exigirLivre() {
    if (ocupado()) throw erro409("backup ou restauração em andamento — espere terminar");
  }

  function mover(arquivo, paraAtivo, { anotar = true } = {}) {
    if (anotar) exigirLivre();
    const origem = caminhoSeguro(paraAtivo ? OFF : PASTA, arquivo);
    const destino = caminhoSeguro(paraAtivo ? PASTA : OFF, arquivo);
    if (!fs.existsSync(origem)) throw erro404(`${arquivo} não está ${paraAtivo ? "desativado" : "ativo"}`);
    if (fs.existsSync(destino)) throw erro409(`já existe um ${arquivo} do outro lado`);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    // rename dentro do mesmo volume é atômico: não existe instante com meio jar
    fs.renameSync(origem, destino);
    esquecer(arquivo);
    // reversão não vira mudança nova: senão o journal cresceria desfazendo a si mesmo
    if (anotar) anotarPendencia(paraAtivo ? "ativou" : "desativou", arquivo);
    return { arquivo, ativo: paraAtivo };
  }

  /** Tira o jar de circulação mandando para a lixeira; devolve de onde ele saiu. */
  function paraLixeira(arquivo) {
    let estava = null;
    for (const [dir, marca] of [[PASTA, "ativo"], [OFF, "off"]]) {
      if (fs.existsSync(caminhoSeguro(dir, arquivo))) { estava = marca; break; }
    }
    if (!estava) throw erro404(`${arquivo} não está na pasta`);
    const origem = caminhoSeguro(estava === "ativo" ? PASTA : OFF, arquivo);
    const destino = caminhoSeguro(LIXO, arquivo);
    fs.mkdirSync(LIXO, { recursive: true });
    // já ter homônimo na lixeira só acontece com atualização repetida: o novo manda
    if (fs.existsSync(destino)) fs.unlinkSync(destino);
    fs.renameSync(origem, destino);
    esquecer(arquivo);
    return estava;
  }

  /** Traz de volta da lixeira. */
  function daLixeira(arquivo, ativo) {
    const origem = caminhoSeguro(LIXO, arquivo);
    if (!fs.existsSync(origem)) throw erro404(`${arquivo} não está mais na lixeira`);
    const destino = caminhoSeguro(ativo ? PASTA : OFF, arquivo);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    if (fs.existsSync(destino)) fs.unlinkSync(origem);
    else fs.renameSync(origem, destino);
    esquecer(arquivo);
  }

  function apagar(arquivo) {
    exigirLivre();
    const estava = paraLixeira(arquivo);
    anotarPendencia("removeu", arquivo, { estava });
    return { arquivo, removido: true };
  }

  /**
   * Um boot saudável confirmou as mudanças: os jars antigos da lixeira podem ir
   * embora e o journal fecha. Devolve quantos foram descartados. É o par do
   * `desfazer` — quem aplica chama um dos dois, nunca meia cerimônia de cada.
   */
  function confirmar() {
    let n = 0;
    try {
      for (const f of fs.readdirSync(LIXO)) {
        try { fs.unlinkSync(path.join(LIXO, f)); n++; } catch { /* segue */ }
      }
    } catch { /* lixeira nem existe */ }
    limparPendencia();
    return n;
  }

  /**
   * Desfaz, de trás para frente, tudo o que ainda não foi confirmado por um boot.
   *
   * De trás para frente importa: se o usuário desativou A e depois instalou B que
   * substituía A, refazer na ordem direta deixaria os dois ativos. Cada passo que
   * falha é anotado e o resto continua — meio revertido é melhor que nada revertido,
   * e a lista de erros vai para o log do painel.
   */
  function desfazer(mudancas) {
    const erros = [];
    for (const m of [...mudancas].reverse()) {
      try {
        if (m.acao === "desativou") mover(m.arquivo, true, { anotar: false });
        else if (m.acao === "ativou") mover(m.arquivo, false, { anotar: false });
        else if (m.acao === "instalou") paraLixeira(m.arquivo);
        else if (m.acao === "removeu") daLixeira(m.arquivo, m.estava !== "off");
        else if (m.acao === "atualizou") {
          paraLixeira(m.arquivo);            // tira a versão nova
          daLixeira(m.de, m.estava !== "off"); // devolve a antiga
        }
      } catch (err) {
        erros.push(`${m.acao} ${m.arquivo}: ${err.message}`);
      }
    }
    limparPendencia();
    return erros;
  }

  /* ---------------- entrada de mod novo ---------------- */

  const MAX_JAR = Number(process.env.MODS_MAX_BYTES || 250 * 1024 * 1024);

  /** Uma varredura por vez: dois cliques seguidos compartilham o mesmo trabalho. */
  const listar = () => {
    if (!rodando) rodando = montar().finally(() => { rodando = null; });
    return rodando;
  };

  /** Contexto do servidor para o avaliador de compatibilidade. */
  async function alvoAtual() {
    const d = await listar();
    return { carregador: d.carregador, versaoJogo: d.versaoJogo, jaTem: new Set(d.mods.map((m) => m.arquivo)) };
  }

  /**
   * Grava um stream em `<dados>/mcpanel/tmp` e só move para `mods/` depois de
   * conferido. Assim jar recusado nunca chega a existir na pasta que o servidor
   * lê — nem por um instante, nem se o download cair no meio.
   */
  async function receber(stream, nomeSugerido, esperado = {}) {
    const tmpDir = path.join(dados, "mcpanel", "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `entrada-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.part`);

    const hash = crypto.createHash("sha1");
    let bytes = 0;
    await new Promise((resolve, reject) => {
      const saida = fs.createWriteStream(tmp);
      stream.on("data", (d) => {
        bytes += d.length;
        if (bytes > MAX_JAR) {
          stream.destroy();
          saida.destroy();
          reject(erro400(`arquivo passa de ${Math.round(MAX_JAR / 1048576)} MB`));
        }
        hash.update(d);
      });
      stream.on("error", reject);
      saida.on("error", reject);
      saida.on("finish", resolve);
      stream.pipe(saida);
    }).catch((err) => { try { fs.unlinkSync(tmp); } catch { /* ignora */ } throw err; });

    const sha1 = hash.digest("hex");
    const limpar = () => { try { fs.unlinkSync(tmp); } catch { /* ignora */ } };

    if (!bytes) { limpar(); throw erro400("arquivo vazio"); }
    if (esperado.sha1 && esperado.sha1 !== sha1) {
      limpar();
      throw erro400("o arquivo baixado não bate com o hash publicado — download corrompido");
    }

    const lido = identificar(tmp);
    return { tmp, sha1, bytes, lido, nome: nomeSugerido, limpar };
  }

  /** Baixa uma versão do catálogo e confere o SHA1 publicado. */
  async function baixarVersao(v) {
    const res = await fetch(v.url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120000) });
    if (!res.ok || !res.body) throw new Error(`o Modrinth respondeu ${res.status} ao baixar`);
    // `fetch` devolve stream web; o resto do painel fala stream do Node
    return receber(Readable.fromWeb(res.body), v.arquivo, { sha1: v.sha1 });
  }

  /** Move o temporário conferido para a pasta final, com o modo certo. */
  function assentar(tmp, dir, nome) {
    const destino = path.join(dir, nome);
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(tmp, destino);
    // o servidor roda com o mesmo uid do painel, mas o modo do temporário é 600
    try { fs.chmodSync(destino, 0o664); } catch { /* volume sem suporte: segue */ }
    esquecer(nome);
  }

  /**
   * Confere e põe na pasta. `forcar` guarda o jar **desativado** em vez de
   * recusar: o veredito pode errar (jar sem metadados legíveis), e é melhor
   * deixar o arquivo à mão desligado do que obrigar o usuário a subir de novo.
   */
  async function acomodar(recebido, { forcar = false, catalogo = null, alvo = null } = {}) {
    alvo = alvo || await alvoAtual();
    const destinoNome = recebido.nome;
    caminhoSeguro(PASTA, destinoNome); // recusa nome vindo do cliente ou do catálogo

    if (alvo.jaTem.has(destinoNome)) {
      recebido.limpar();
      throw erro409(`${destinoNome} já está na pasta`);
    }

    const perfil = escolherPerfil(recebido.lido, alvo.carregador);
    const veredito = avaliar({
      perfil,
      declarados: recebido.lido.carregadores,
      alvo: { carregador: alvo.carregador, versaoJogo: alvo.versaoJogo },
      catalogo,
    });

    if (veredito.ok === false && !forcar) {
      recebido.limpar();
      throw erro422(veredito.motivos.join("; "), {
        veredito, arquivo: destinoNome, nome: perfil.nome || destinoNome,
      });
    }

    // incompatível forçado nasce desligado: entra no disco sem entrar no boot
    const ativo = !(veredito.ok === false);
    assentar(recebido.tmp, ativo ? PASTA : OFF, destinoNome);
    anotarPendencia("instalou", destinoNome);

    return {
      arquivo: destinoNome,
      nome: perfil.nome || destinoNome,
      versao: perfil.versao,
      bytes: recebido.bytes,
      ativo,
      veredito,
    };
  }

  /** Upload manual: o corpo da requisição é o .jar cru. */
  async function enviar(stream, nomeArquivo, { forcar = false } = {}) {
    exigirLivre();
    caminhoSeguro(PASTA, nomeArquivo); // valida antes de gastar disco
    const recebido = await receber(stream, nomeArquivo);
    // o catálogo pode conhecer este arquivo pelo hash, e aí o veredito fica exato
    let catalogo = null;
    if (ONLINE) {
      catalogo = await pedir(`/version_file/${recebido.sha1}`).catch(() => null);
    }
    return acomodar(recebido, { forcar, catalogo });
  }

  /** Instalação pelo catálogo: o painel baixa, confere o hash e acomoda. */
  async function instalar(projeto, { forcar = false } = {}) {
    exigirLivre();
    if (!ONLINE) throw erro400("a consulta ao Modrinth está desligada neste painel");
    const alvo = await alvoAtual();
    const v = await versaoParaInstalar({ projeto, carregador: alvo.carregador, versaoJogo: alvo.versaoJogo });
    if (!v) {
      throw erro422(`nenhuma versão deste mod serve ${alvo.carregador || "este carregador"} ${alvo.versaoJogo || ""}`.trim());
    }
    if (v.bytes > MAX_JAR) throw erro400(`o arquivo tem ${Math.round(v.bytes / 1048576)} MB`);

    const recebido = await baixarVersao(v);
    const r = await acomodar(recebido, {
      forcar,
      catalogo: { loaders: v.loaders, game_versions: v.game_versions },
      alvo,
    });
    return { ...r, versaoModrinth: v.nomeVersao };
  }

  /**
   * Troca um mod instalado pela versão mais nova compatível.
   *
   * A ordem protege: baixa e confere primeiro, e só então tira o antigo — que vai
   * para a lixeira, não para o nada. Se o servidor não subir com a versão nova, o
   * `desfazer` devolve o jar velho de lá. O novo herda o estado do antigo: mod que
   * estava desativado continua desativado depois de atualizado.
   */
  async function atualizar(nomeArquivo, dConhecido = null) {
    exigirLivre();
    if (!ONLINE) throw erro400("a consulta ao Modrinth está desligada neste painel");

    // atualizarTodos passa a lista que já tem: os itens ainda não tocados não
    // mudaram, e reler tudo — com a rodada de Modrinth junto — a cada mod da
    // fila custava 4 chamadas HTTP extras por item
    const d = dConhecido || await listar();
    const atual = d.mods.find((m) => m.arquivo === nomeArquivo);
    if (!atual) throw erro404(`${nomeArquivo} não está na pasta`);
    if (!atual.modrinth) throw erro422("esse mod não está no Modrinth — atualize à mão");
    if (!atual.atualizacao) throw erro409("esse mod já está na versão mais nova compatível");

    const v = await versaoParaInstalar({
      projeto: atual.modrinth.slug, carregador: d.carregador, versaoJogo: d.versaoJogo,
    });
    if (!v) throw erro422("não achei versão compatível para atualizar");
    if (v.arquivo === nomeArquivo) throw erro409("a versão nova tem o mesmo arquivo da atual");

    const recebido = await baixarVersao(v);
    const perfil = escolherPerfil(recebido.lido, d.carregador);
    const veredito = avaliar({
      perfil, declarados: recebido.lido.carregadores,
      alvo: { carregador: d.carregador, versaoJogo: d.versaoJogo },
      catalogo: { loaders: v.loaders, game_versions: v.game_versions },
    });
    if (veredito.ok === false) {
      recebido.limpar();
      throw erro422(veredito.motivos.join("; "), { veredito });
    }

    const estava = paraLixeira(nomeArquivo);          // o antigo sai, mas fica guardado
    assentar(recebido.tmp, estava === "off" ? OFF : PASTA, v.arquivo);
    anotarPendencia("atualizou", v.arquivo, { de: nomeArquivo, estava });

    return {
      arquivo: v.arquivo, de: nomeArquivo, nome: atual.nome,
      versaoAntiga: atual.versao, versaoNova: v.nomeVersao,
      ativo: estava !== "off", bytes: recebido.bytes,
    };
  }

  /** Atualiza tudo o que tem versão nova; erro num mod não derruba os outros. */
  async function atualizarTodos() {
    const d = await listar();
    const alvos = d.mods.filter((m) => m.atualizacao).map((m) => m.arquivo);
    const feitos = [], falhos = [];
    for (const a of alvos) {
      try { feitos.push(await atualizar(a, d)); }
      catch (err) { falhos.push({ arquivo: a, erro: err.message }); }
    }
    return { feitos, falhos, total: alvos.length };
  }

  /** O que falta instalar para este projeto funcionar. */
  async function dependenciasFaltando(projeto) {
    if (!ONLINE) return [];
    const d = await listar();
    const v = await versaoParaInstalar({ projeto, carregador: d.carregador, versaoJogo: d.versaoJogo });
    if (!v?.dependencias?.length) return [];
    const instalados = new Set(d.mods.map((m) => m.modrinth?.slug).filter(Boolean));
    const infos = await projetos(v.dependencias).catch(() => []);
    return infos
      .filter((p) => !instalados.has(p.slug))
      .map((p) => ({ id: p.id, slug: p.slug, titulo: p.title }));
  }

  return {
    pasta: PASTA,
    pastaDesativados: OFF,
    listar,
    buscar: (termo) => listar().then((d) =>
      buscar({ termo, carregador: d.carregador, versaoJogo: d.versaoJogo })),
    enviar,
    instalar,
    atualizar,
    atualizarTodos,
    dependenciasFaltando,
    mover,
    apagar,
    // o ciclo de aplicar/reverter (aplicar.js) fala só com estes três
    journal,
    confirmar,
    desfazer,
  };
}
