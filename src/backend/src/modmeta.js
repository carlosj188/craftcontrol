import { lerEntradas } from "./jar.js";

/**
 * Quem é este .jar: carregador, id, nome, versão e de quem ele depende.
 *
 * Cada carregador guarda isso num arquivo diferente e num formato diferente, e é
 * a única parte do gerenciamento de mods que não é agnóstica — mover, apagar e
 * consultar o Modrinth funcionam igual para todos.
 *
 *   Fabric              mods/    fabric.mod.json                JSON
 *   Forge  (≤1.20.x)    mods/    META-INF/mods.toml             TOML
 *   NeoForge (1.20.5+)  mods/    META-INF/neoforge.mods.toml    TOML
 *
 * Quilt e plugins de Paper/Spigot ficaram de fora de propósito (decisão do Carlos
 * em 2026-08-07); os dois entram aqui sem mexer no resto quando forem pedidos.
 */

const ALVOS = [
  "META-INF/neoforge.mods.toml",
  "META-INF/mods.toml",
  "fabric.mod.json",
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

const VAZIO = {
  carregador: null, id: null, nome: null, versao: null, descricao: null,
  autores: [], depende: [], dependeDeVerdade: [], ambiente: null,
  mcRange: null,
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

  return { carregadores: Object.keys(perfis), perfis };
}

/**
 * Ordem de desempate quando o servidor não tem carregador conhecido. Exportada
 * porque é a MESMA decisão nos dois lugares que desempatam — aqui (qual perfil
 * de um jar multi-loader vale) e em mods.js (qual carregador uma pasta só de
 * multi-loader tem). Duas listas divergiram uma vez; agora é uma só.
 */
export const PREFERENCIA = ["fabric", "neoforge", "forge"];

/**
 * O perfil que vale para este servidor. Com o jar servindo vários carregadores,
 * ganha o do servidor; sem carregador conhecido, o primeiro da preferência.
 */
export function escolherPerfil({ carregadores, perfis }, preferido) {
  if (!carregadores?.length) return { ...VAZIO };
  return (preferido && perfis[preferido]) || perfis[PREFERENCIA.find((c) => perfis[c])];
}
