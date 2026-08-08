import { lerEntradas } from "./jar.js";

/**
 * Quem é este .jar: carregador, id, nome, versão e de quem ele depende.
 *
 * Cada carregador guarda isso num arquivo diferente e num formato diferente, e é
 * a única parte do gerenciamento de mods que não é agnóstica — mover, apagar e
 * consultar o Modrinth funcionam igual para todos.
 *
 *   Fabric              mods/     fabric.mod.json                JSON
 *   Forge  (≤1.20.x)    mods/     META-INF/mods.toml             TOML
 *   NeoForge (1.20.5+)  mods/     META-INF/neoforge.mods.toml    TOML
 *   Bukkit e derivados  plugins/  plugin.yml                     YAML
 *   Paper moderno       plugins/  paper-plugin.yml               YAML
 *
 * Quilt ficou de fora de propósito; entra aqui sem mexer no resto quando for pedido.
 *
 * A família Bukkit é diferente das outras numa coisa: os carregadores **herdam**
 * uns dos outros. Fabric e Forge são mundos separados, mas Purpur roda plugin de
 * Paper, que roda plugin de Spigot, que roda plugin de Bukkit. Quem sabe disso é
 * a `cascata()` no fim deste arquivo, e é dela que sai tanto a escolha do perfil
 * quanto o veredito de compatibilidade.
 */

const ALVOS = [
  "META-INF/neoforge.mods.toml",
  "META-INF/mods.toml",
  "fabric.mod.json",
  "paper-plugin.yml",
  "plugin.yml",
  "META-INF/MANIFEST.MF",
];

/* ---------------- TOML (só o pedaço que estes arquivos usam) ---------------- */

/**
 * Parser de subconjunto: tabelas `[a.b]`, arrays de tabela `[[a.b]]`, chaves
 * simples, strings (aspas, apóstrofo e as duas variantes de três), booleanos,
 * números e listas de string. Não é TOML completo, e não precisa ser — mods.toml
 * é um arquivo declarativo raso. Qualquer coisa que ele não entenda vira valor
 * ausente, nunca exceção: metadado é enfeite, e jar estranho não pode derrubar a
 * listagem inteira.
 */
export function parseToml(texto) {
  const raiz = {};
  let atual = raiz;

  const linhas = texto.split(/\r?\n/);
  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i].trim();
    if (!linha || linha.startsWith("#")) continue;

    // [tabela] e [[array de tabela]]
    const tab = /^\[(\[?)([^\]]+)\]?\]$/.exec(linha);
    if (tab) {
      const array = tab[1] === "[";
      const caminho = tab[2].split(".").map((s) => s.trim().replace(/^["']|["']$/g, ""));
      let no = raiz;
      for (let k = 0; k < caminho.length; k++) {
        const chave = caminho[k];
        const ultimo = k === caminho.length - 1;
        if (ultimo && array) {
          if (!Array.isArray(no[chave])) no[chave] = [];
          const novo = {};
          no[chave].push(novo);
          no = novo;
        } else {
          if (Array.isArray(no[chave])) no = no[chave][no[chave].length - 1];
          else {
            if (typeof no[chave] !== "object" || no[chave] === null) no[chave] = {};
            no = no[chave];
          }
        }
      }
      atual = no;
      continue;
    }

    const eq = linha.indexOf("=");
    if (eq < 0) continue;
    const chave = linha.slice(0, eq).trim().replace(/^["']|["']$/g, "");
    let bruto = linha.slice(eq + 1).trim();

    // string de três aspas pode continuar nas linhas seguintes
    const tri = /^('''|""")/.exec(bruto);
    if (tri) {
      const fecha = tri[1];
      const corpo = bruto.slice(3);
      if (corpo.endsWith(fecha) && corpo.length >= 3) {
        atual[chave] = corpo.slice(0, -3).trim();
        continue;
      }
      const partes = [corpo];
      while (++i < linhas.length) {
        const l = linhas[i];
        const f = l.indexOf(fecha);
        if (f >= 0) { partes.push(l.slice(0, f)); break; }
        partes.push(l);
      }
      atual[chave] = partes.join("\n").trim();
      continue;
    }

    // valor inline com { } ou [ ] pode ocupar várias linhas: junta até fechar.
    // É assim que os mods gerados pelo Modrinth escrevem a lista de mods —
    // `mods = [ { modId = ... } ]` em vez de `[[mods]]`.
    if (/^[[{]/.test(bruto)) {
      while (!equilibrado(bruto) && i + 1 < linhas.length) bruto += "\n" + linhas[++i];
    }

    atual[chave] = valorToml(tirarComentario(bruto));
  }
  return raiz;
}

/** Comentário só conta fora de string. */
function tirarComentario(txt) {
  let aspas = null;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (aspas) { if (c === aspas) aspas = null; continue; }
    if (c === '"' || c === "'") { aspas = c; continue; }
    if (c === "#") return txt.slice(0, i).trim();
  }
  return txt.trim();
}

function equilibrado(txt) {
  let aspas = null, colch = 0, chaves = 0;
  for (const c of txt) {
    if (aspas) { if (c === aspas) aspas = null; continue; }
    if (c === '"' || c === "'") { aspas = c; continue; }
    if (c === "[") colch++; else if (c === "]") colch--;
    else if (c === "{") chaves++; else if (c === "}") chaves--;
  }
  return colch <= 0 && chaves <= 0;
}

/**
 * Divide por `sep` respeitando string, colchete e chave — `split(",")` cru
 * estilhaça descrição com vírgula, que é o caso comum.
 */
function fatiar(txt, sep) {
  const partes = [];
  let atual = "", aspas = null, prof = 0;
  for (const c of txt) {
    if (aspas) { atual += c; if (c === aspas) aspas = null; continue; }
    if (c === '"' || c === "'") { aspas = c; atual += c; continue; }
    if (c === "[" || c === "{") prof++;
    else if (c === "]" || c === "}") prof--;
    if (c === sep && prof === 0) { partes.push(atual); atual = ""; continue; }
    atual += c;
  }
  if (atual.trim()) partes.push(atual);
  return partes.map((s) => s.trim()).filter(Boolean);
}

/** Tabela inline: `{ a = 1, b = 'x' }` */
function tabelaInline(txt) {
  const obj = {};
  for (const par of fatiar(txt.slice(1, -1), ",")) {
    const eq = par.indexOf("=");
    if (eq < 0) continue;
    obj[par.slice(0, eq).trim().replace(/^["']|["']$/g, "")] = valorToml(par.slice(eq + 1).trim());
  }
  return obj;
}

function valorToml(bruto) {
  if (!bruto) return "";
  if (bruto === "true") return true;
  if (bruto === "false") return false;
  const s = /^"([\s\S]*)"$/.exec(bruto) || /^'([\s\S]*)'$/.exec(bruto);
  if (s) return s[1];
  if (bruto.startsWith("{") && bruto.endsWith("}")) return tabelaInline(bruto);
  if (bruto.startsWith("[") && bruto.endsWith("]")) {
    return fatiar(bruto.slice(1, -1), ",").map(valorToml);
  }
  if (/^-?\d+(\.\d+)?$/.test(bruto)) return Number(bruto);
  return bruto;
}

/* ---------------- YAML (só o pedaço que plugin.yml usa) ---------------- */

/**
 * Parser de subconjunto, na mesma linha do de TOML: mapas por indentação, listas
 * em bloco (`- item`) e inline (`[a, b]`), escalares com e sem aspas, comentários
 * e booleanos. Não é YAML completo — âncoras, blocos `|`/`>` e documentos
 * múltiplos não aparecem em plugin.yml e ficam de fora.
 *
 * O que os arquivos reais obrigaram a cobrir:
 *
 *   - lista recuada em 1, 2 ou 4 espaços, ou **na mesma coluna da chave** — as
 *     três formas são YAML válido e as três aparecem (squaremap, HuskHomes, Plan)
 *   - escalar sem aspas com espaço no meio: `version: 5.8 build 3579` (Plan)
 *   - `#` de comentário no fim da linha, sem estragar `website: https://…`
 *
 * Item de lista é sempre tratado como escalar: mapa dentro de lista não existe
 * nestes arquivos, e fingir que existe só complicaria o parser.
 */
export function parseYaml(texto) {
  const linhas = [];
  for (const bruta of texto.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!bruta.trim() || /^\s*#/.test(bruta)) continue;
    linhas.push({ col: bruta.length - bruta.trimStart().length, txt: bruta.trim() });
  }
  return linhas.length ? parseNo(linhas, 0, linhas[0].col)[0] : {};
}

const ehItem = (txt) => txt === "-" || txt.startsWith("- ");

function parseNo(ls, i, col) {
  return ehItem(ls[i].txt) ? parseLista(ls, i, col) : parseMapa(ls, i, col);
}

function parseLista(ls, i, col) {
  const out = [];
  while (i < ls.length && ls[i].col === col && ehItem(ls[i].txt)) {
    const corpo = tirarComentarioYaml(ls[i].txt.slice(1).trim());
    if (corpo) out.push(valorYaml(corpo));
    i++;
  }
  return [out, i];
}

function parseMapa(ls, i, col) {
  const obj = {};
  while (i < ls.length && ls[i].col === col && !ehItem(ls[i].txt)) {
    const { txt } = ls[i];
    const sep = separadorYaml(txt);
    if (sep < 0) { i++; continue; }

    const chave = txt.slice(0, sep).trim().replace(/^["']|["']$/g, "");
    const bruto = tirarComentarioYaml(txt.slice(sep + 1).trim());
    i++;

    if (bruto) { obj[chave] = valorYaml(bruto); continue; }

    // valor veio nas linhas de baixo: recuado (mapa ou lista) ou, no caso da
    // lista, na mesma coluna da chave — `softdepend:` seguido de `- Vault`
    if (i < ls.length && ls[i].col > col) [obj[chave], i] = parseNo(ls, i, ls[i].col);
    else if (i < ls.length && ls[i].col === col && ehItem(ls[i].txt)) [obj[chave], i] = parseLista(ls, i, col);
    else obj[chave] = null;
  }
  return [obj, i];
}

/**
 * A posição do `:` que separa chave de valor. Em YAML ele é `: ` ou um `:` no
 * fim da linha — por isso o `://` de uma URL não conta, e é isso que mantém
 * `website: https://enginehub.org` inteiro.
 */
function separadorYaml(txt) {
  let aspas = null;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (aspas) { if (c === aspas) aspas = null; continue; }
    if (c === '"' || c === "'") { aspas = c; continue; }
    if (c === ":" && (i === txt.length - 1 || txt[i + 1] === " ")) return i;
  }
  return -1;
}

/** `#` só abre comentário no começo ou depois de espaço, e nunca dentro de aspas. */
function tirarComentarioYaml(txt) {
  let aspas = null;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (aspas) { if (c === aspas) aspas = null; continue; }
    if (c === '"' || c === "'") { aspas = c; continue; }
    if (c === "#" && (i === 0 || txt[i - 1] === " ")) return txt.slice(0, i).trim();
  }
  return txt.trim();
}

function valorYaml(bruto) {
  if (!bruto || bruto === "~" || bruto === "null") return null;
  if (bruto === "true") return true;
  if (bruto === "false") return false;
  const s = /^"([\s\S]*)"$/.exec(bruto) || /^'([\s\S]*)'$/.exec(bruto);
  if (s) return s[1];
  if (bruto.startsWith("[") && bruto.endsWith("]")) return fatiar(bruto.slice(1, -1), ",").map(valorYaml);
  // só inteiro vira número, de propósito: `api-version: 1.20` sem aspas é o caso
  // comum e, lido como decimal, viraria 1.2 — o painel passaria a dizer que um
  // plugin de 1.20 exige "1.2". Versão é texto, e aqui não há float nenhum.
  if (/^-?\d+$/.test(bruto)) return Number(bruto);
  return bruto;
}

/* ---------------- utilidades ---------------- */

/**
 * `JSON.parse` estrito recusa caractere de controle cru dentro de string, e mod
 * publicado faz isso: o beltborne_lanterns tem um no meio da descrição e derrubava
 * a leitura do jar inteiro. Vira espaço (não some) para não colar dois tokens, e o
 * BOM sai da frente. Escrito com escape, nunca com o byte literal no fonte.
 */
function jsonTolerante(texto) {
  const limpo = texto.replace(/^\uFEFF/, "").replace(/[\u0000-\u001F]/g, " ");
  return JSON.parse(limpo);
}

/** `Implementation-Version` do MANIFEST.MF — é o que o Forge põe em ${file.jarVersion}. */
function versaoDoManifesto(manifesto) {
  if (!manifesto) return null;
  // MANIFEST.MF quebra linha longa continuando com um espaço na coluna 0
  const juntado = manifesto.replace(/\r?\n /g, "");
  const m = /^Implementation-Version:\s*(.+)$/mi.exec(juntado);
  return m ? m[1].trim() : null;
}

function resolverPlaceholder(valor, manifesto) {
  if (typeof valor !== "string" || !valor) return valor || null;
  if (!valor.includes("${")) return valor;
  const doManifesto = versaoDoManifesto(manifesto);
  if (/\$\{file\.jarVersion\}/.test(valor) && doManifesto) {
    return valor.replace(/\$\{file\.jarVersion\}/g, doManifesto);
  }
  return doManifesto || null;
}

const IGNORAR_DEP = new Set([
  "minecraft", "java", "forge", "neoforge", "fabricloader", "fabric", "fabric-api",
  "fabric-api-base", "quilt_loader",
]);

/**
 * Submódulos da Fabric API — `fabric-resource-loader-v0`, `fabric-command-api-v2`
 * e companhia. Não são mods separados: vêm todos dentro do jar da Fabric API. Sem
 * isto o painel dizia "depende de 3" para um mod que na prática só precisa da
 * Fabric API, e nenhum desses ids casa com jar nenhum da pasta.
 */
const IGNORAR_DEP_RE = /^fabric-[a-z0-9-]+-v\d+$/i;

const dependenciaDeVerdade = (d) => !IGNORAR_DEP.has(d) && !IGNORAR_DEP_RE.test(d);

/* ---------------- leitores por carregador ---------------- */

function lerFabric(texto) {
  const j = jsonTolerante(texto);
  const depende = Object.keys(j.depends || {});
  const mc = j.depends?.minecraft;
  return {
    carregador: "fabric",
    id: j.id || null,
    nome: j.name || j.id || null,
    versao: j.version || null,
    descricao: (j.description || "").trim() || null,
    autores: (j.authors || []).map((a) => (typeof a === "string" ? a : a?.name)).filter(Boolean),
    depende,
    dependeDeVerdade: depende.filter(dependenciaDeVerdade),
    ambiente: j.environment === "client" ? "client" : j.environment === "server" ? "server" : null,
    // pode vir string ou lista de strings; guardo como veio e o avaliador resolve
    mcRange: Array.isArray(mc) ? mc.join(" || ") : (typeof mc === "string" ? mc : null),
  };
}

function lerForge(texto, manifesto, carregador) {
  const t = parseToml(texto);
  const mods = Array.isArray(t.mods) ? t.mods : t.mods ? [t.mods] : [];
  const principal = mods[0] || {};
  const id = principal.modId || null;

  // [[dependencies.<modid>]] — o Forge antigo marca com mandatory, o novo com type
  const bloco = (t.dependencies && id && t.dependencies[id]) || [];
  const listaDeps = Array.isArray(bloco) ? bloco : [bloco];
  const obrigatorias = listaDeps.filter((d) => d && (d.type ? d.type === "required" : d.mandatory !== false));
  const depende = obrigatorias.map((d) => d.modId).filter(Boolean);

  // lado só é declarado por dependência; a do próprio carregador é a melhor pista
  const doLoader = listaDeps.find((d) => d && (d.modId === "neoforge" || d.modId === "forge"));
  const lado = doLoader?.side ? String(doLoader.side).toLowerCase() : null;
  const doMc = listaDeps.find((d) => d && d.modId === "minecraft");

  return {
    carregador,
    id,
    nome: principal.displayName || id || null,
    versao: resolverPlaceholder(principal.version, manifesto),
    descricao: (principal.description || "").trim() || null,
    autores: principal.authors ? [String(principal.authors)] : [],
    depende,
    dependeDeVerdade: depende.filter(dependenciaDeVerdade),
    // "both"/"client"/"server" no vocabulário do Forge; normalizado igual ao Fabric
    ambiente: lado === "client" ? "client" : lado === "server" ? "server" : null,
    mcRange: doMc?.versionRange ? String(doMc.versionRange) : null,
  };
}

/**
 * Plugin de Bukkit e derivados: `plugin.yml` (todos) e `paper-plugin.yml` (Paper
 * moderno). Quando o jar traz os dois, o Paper usa o segundo e ignora o primeiro.
 *
 * Duas diferenças em relação a mod que mudam o resultado:
 *
 * - **`api-version` é um mínimo, não uma faixa.** Um plugin com `api-version: 1.13`
 *   não está dizendo que roda em 1.21 — está dizendo que não roda antes de 1.13.
 *   Por isso vai para `mcMinimo`, e não para `mcRange`: tratá-lo como faixa faria
 *   o painel carimbar "compatível" em plugin de 2019, que é o erro que derruba
 *   servidor.
 * - **`softdepend` e `libraries` não são dependência.** O primeiro é opcional por
 *   definição e o segundo é biblioteca Maven, baixada pelo próprio servidor.
 *   Contá-los daria "depende de 8" num plugin que não precisa de nada.
 */
function lerBukkit(texto, carregador) {
  const y = parseYaml(texto);
  const lista = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(String).filter(Boolean);

  // paper-plugin.yml aninha as dependências e marca cada uma; sem `required`
  // escrito, a spec do Paper considera obrigatória
  const doServidor = y.dependencies?.server;
  const doPaper = doServidor && typeof doServidor === "object" && !Array.isArray(doServidor)
    ? Object.keys(doServidor).filter((k) => doServidor[k]?.required !== false)
    : [];
  const depende = [...new Set([...lista(y.depend), ...doPaper])];
  const api = y["api-version"] == null ? null : String(y["api-version"]);

  return {
    carregador,
    id: y.name ? String(y.name) : null,
    nome: y.name ? String(y.name) : null,
    versao: y.version == null ? null : String(y.version),
    descricao: (y.description ? String(y.description) : "").trim() || null,
    autores: lista(y.authors).length ? lista(y.authors) : lista(y.author),
    depende,
    dependeDeVerdade: depende.filter(dependenciaDeVerdade),
    // plugin roda no servidor por definição: não existe plugin de cliente
    ambiente: "server",
    mcRange: null,
    mcMinimo: api,
    folia: y["folia-supported"] === true,
  };
}

const VAZIO = {
  carregador: null, id: null, nome: null, versao: null, descricao: null,
  autores: [], depende: [], dependeDeVerdade: [], ambiente: null,
  mcRange: null, mcMinimo: null, folia: false,
};

/**
 * Lê um .jar e devolve **um perfil por carregador que ele declara**.
 *
 * O mesmo arquivo serve mais de um carregador com frequência — mod publicado pelo
 * Modrinth costuma trazer `fabric.mod.json`, `mods.toml` e `neoforge.mods.toml`
 * juntos. Escolher por ordem fixa faria o painel anunciar "NeoForge" num servidor
 * Fabric; quem sabe qual vale é `mods.js`, que conhece o carregador do servidor.
 *
 * Nunca lança: jar ilegível volta com `perfis` vazio e a interface mostra só o
 * nome do arquivo, o que já é melhor do que sumir com ele.
 */
export function identificar(arquivo) {
  const achados = lerEntradas(arquivo, ALVOS);
  const manifesto = achados.get("META-INF/MANIFEST.MF") || null;
  const perfis = {};

  const tentar = (carregador, fn) => {
    try {
      const p = fn();
      // perfil sem id não serve para nada e ainda esconderia um carregador bom
      if (p && p.id) perfis[carregador] = p;
    } catch { /* um carregador ilegível não invalida os outros */ }
  };

  const neo = achados.get("META-INF/neoforge.mods.toml");
  if (neo) tentar("neoforge", () => lerForge(neo, manifesto, "neoforge"));

  const forge = achados.get("META-INF/mods.toml");
  if (forge) tentar("forge", () => lerForge(forge, manifesto, "forge"));

  const fabric = achados.get("fabric.mod.json");
  if (fabric) tentar("fabric", () => lerFabric(fabric));

  // `paper-plugin.yml` sozinho quer dizer plugin que **só** roda em Paper e
  // derivados: em Spigot puro ele nem carrega. É o caso do MiniPlaceholders, e
  // é por isso que os dois viram perfis separados em vez de um só.
  const paper = achados.get("paper-plugin.yml");
  if (paper) tentar("paper", () => lerBukkit(paper, "paper"));

  const bukkit = achados.get("plugin.yml");
  if (bukkit) tentar("bukkit", () => lerBukkit(bukkit, "bukkit"));

  return { carregadores: Object.keys(perfis), perfis };
}

/**
 * Ordem de desempate quando o servidor não tem carregador conhecido. Exportada
 * porque é a MESMA decisão nos dois lugares que desempatam — aqui (qual perfil
 * de um jar multi-loader vale) e em mods.js (qual carregador uma pasta só de
 * multi-loader tem). Duas listas divergiram uma vez; agora é uma só.
 */
export const PREFERENCIA = ["fabric", "neoforge", "forge", "paper", "bukkit"];

/** Quem herda de quem na família Bukkit. Fora dela, ninguém herda de ninguém. */
const HERDA = { purpur: "paper", folia: "paper", paper: "spigot", spigot: "bukkit" };

/** Carregadores da família Bukkit — os que aceitam plugin em vez de mod. */
export const PLUGINS = ["purpur", "folia", "paper", "spigot", "bukkit"];

export const usaPlugins = (carregador) => PLUGINS.includes(carregador);

/**
 * O que este servidor aceita, do mais específico ao mais genérico: um Purpur roda
 * plugin escrito para Purpur, Paper, Spigot e Bukkit. Para Fabric e Forge a lista
 * tem um item só — eles não herdam de ninguém, e é justamente essa diferença que
 * justifica a função existir em vez de um `includes` espalhado.
 */
export function cascata(carregador) {
  const out = [];
  for (let c = carregador; c; c = HERDA[c]) out.push(c);
  return out;
}

/**
 * O perfil que vale para este servidor. Com o jar servindo vários carregadores,
 * ganha o mais específico que o servidor aceita; sem carregador conhecido, o
 * primeiro da preferência.
 */
export function escolherPerfil({ carregadores, perfis }, preferido) {
  if (!carregadores?.length) return { ...VAZIO };
  for (const c of cascata(preferido)) if (perfis[c]) return perfis[c];
  return perfis[PREFERENCIA.find((c) => perfis[c])];
}
