import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * Ruído que não vale espaço no console: as farms do easy-villager anunciam cada
 * loot (~3k linhas/dia, e elas rodam em spawn chunk mesmo com o servidor vazio),
 * algum mod cospe listas enormes de BlockPos em [STDOUT], e cada conexão RCON de
 * fora do painel (rcon-cli, scripts) rende duas linhas de "Thread RCON Client".
 * Some do painel, continua no latest.log.
 * LOG_MUTE="" desliga o filtro; qualquer outro valor vira o regex.
 */
const MUTE_PADRAO = "generated loot\\.$|\\[STDOUT\\]: \\[class_2338\\{|Thread RCON Client";
const muteRe = (() => {
  const v = process.env.LOG_MUTE ?? MUTE_PADRAO;
  if (!v) return null;
  try {
    return new RegExp(v);
  } catch {
    console.warn(`LOG_MUTE não é um regex válido, filtro desligado: ${v}`);
    return null;
  }
})();

const silenciada = (l) => muteRe !== null && muteRe.test(l);

const LINE_RE = /^\[(\d{2}:\d{2}:\d{2})\] \[([^\]]*)\]:? ?(.*)$/;

/* ---------------- puro: não depende de qual servidor ---------------- */

export function parseLine(raw) {
  const m = LINE_RE.exec(raw);
  if (!m) return { t: null, lvl: "info", msg: raw };
  const [, t, source, msg] = m;
  const lvl = /ERROR|FATAL/i.test(source) ? "err" : /WARN/i.test(source) ? "warn" : "info";
  return { t, lvl, msg };
}

const CHAT_RE = /^<([A-Za-z0-9_]{1,16})> ([\s\S]+)$/;
const ME_RE = /^\* ([A-Za-z0-9_]{1,16}) ([\s\S]+)$/;
// `say` pelo painel sai como "[Not Secure] [Rcon] msg"; pelo console do servidor, "[Server] msg".
// Atenção: "[Rcon: ...]" (com dois-pontos) é eco de resposta de comando, não é fala — não casa aqui.
const SERVER_RE = /^\[(?:Server|Rcon)\] ([\s\S]+)$/;
const JOIN_RE = /^([A-Za-z0-9_]{1,16}) (joined|left) the game$/;
// prefixo de mensagem não assinada; some antes de tudo pra não atrapalhar os outros padrões
const INSEGURA_RE = /^\[Not Secure\] /;

/**
 * Reconhece a conversa dentro de uma linha já limpa do log. Devolve null pro que
 * não é papo — assim o painel marca só as linhas de chat e a aba de chat vira um
 * filtro do que já chega pelo console, sem duplicar o caminho dos dados.
 */
export function parseChat(raw) {
  const msg = String(raw).replace(INSEGURA_RE, "");
  let m;
  if ((m = CHAT_RE.exec(msg))) return { kind: "chat", nick: m[1], text: m[2] };
  if ((m = ME_RE.exec(msg))) return { kind: "me", nick: m[1], text: m[2] };
  if ((m = SERVER_RE.exec(msg))) return { kind: "server", nick: null, text: m[1] };
  if ((m = JOIN_RE.exec(msg))) return { kind: "system", nick: m[1], text: m[2] === "joined" ? "entrou" : "saiu" };
  return null;
}

const ROTACIONADO_RE = /^(\d{4}-\d{2}-\d{2})-(\d+)\.log\.gz$/;

function colherChat(texto, dia, dentro) {
  for (const raw of texto.split("\n")) {
    if (!raw.trim()) continue;
    const { t, msg } = parseLine(raw);
    const chat = parseChat(msg.replace(/§[0-9a-fk-or]/gi, ""));
    if (chat) dentro.push({ t, dia, ...chat });
  }
}

/* ---------------- por servidor ---------------- */

/** Leitura da pasta de dados de UM servidor: log, whitelist, bans, properties. */
export function criar({ dados, versaoPadrao = null }) {
  const DATA = dados;
  const LOG = path.join(DATA, "logs", "latest.log");

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(path.join(DATA, file), "utf8"));
    } catch {
      return fallback;
    }
  }

  /** banned-players.json é escrito pelo servidor na hora do /ban — fonte melhor que parsear banlist */
  function bans() {
    const raw = readJson("banned-players.json", []);
    if (!Array.isArray(raw)) return [];
    return raw.map((b) => ({
      nick: b.name,
      reason: b.reason && b.reason !== "Banned by an operator." ? b.reason : "sem motivo registrado",
      source: b.source || null,
      created: b.created || null,
      expires: b.expires && b.expires !== "forever" ? b.expires : null,
    }));
  }

  function whitelist() {
    const raw = readJson("whitelist.json", []);
    if (!Array.isArray(raw)) return [];
    return raw.map((w) => w.name).filter(Boolean);
  }

  function properties() {
    const out = {};
    try {
      const txt = fs.readFileSync(path.join(DATA, "server.properties"), "utf8");
      for (const line of txt.split("\n")) {
        if (!line || line.startsWith("#")) continue;
        const i = line.indexOf("=");
        if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
    } catch { /* sem acesso ao volume */ }
    return out;
  }

  /**
   * Momento em que o servidor subiu.
   *
   * Fonte principal: o mtime de `world/session.lock`, escrito quando o nível é
   * carregado no boot. É exato (bate com o `Done (` e com o StartedAt do contêiner)
   * e não some com a rotação do log — o "Done (" só existe no log do dia em que o
   * servidor subiu, então o painel mostrava "–" sempre que ele passava da meia-noite.
   * O log fica de reserva, para o caso de um mundo sem session.lock.
   */
  function startedAt() {
    try {
      return new Date(fs.statSync(path.join(DATA, "world", "session.lock")).mtime).toISOString();
    } catch { /* cai pro log */ }
    return startedAtFromLog();
  }

  function startedAtFromLog() {
    try {
      const st = fs.statSync(LOG);
      const size = Math.min(st.size, 512 * 1024);
      const buf = Buffer.alloc(size);
      const fd = fs.openSync(LOG, "r");
      fs.readSync(fd, buf, 0, size, st.size - size);
      fs.closeSync(fd);
      const lines = buf.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('Done (')) continue;
        const m = LINE_RE.exec(lines[i]);
        if (!m) continue;
        const [h, mi, s] = m[1].split(":").map(Number);
        const d = new Date(st.mtime);
        d.setHours(h, mi, s, 0);
        // log rotaciona à meia-noite; se der no futuro, foi ontem
        if (d > new Date()) d.setDate(d.getDate() - 1);
        return d.toISOString();
      }
    } catch { /* sem log acessível */ }
    return null;
  }

  /** arquivo rotacionado -> falas dele; ver chatHistory */
  const chatGzCache = new Map();

  /**
   * Conversa recente. Começa pelo `latest.log` e, se o dia estiver quieto (o log
   * rotaciona à meia-noite, então de manhã ele está quase vazio), recua pelos
   * rotacionados até juntar `max` falas. Cada linha leva o dia junto, porque o log
   * só carimba a hora e sem a data as mensagens de ontem confundiriam.
   */
  function chatHistory(max = 200) {
    const hoje = [];
    try {
      const st = fs.statSync(LOG);
      const size = Math.min(st.size, 1024 * 1024);
      const buf = Buffer.alloc(size);
      const fd = fs.openSync(LOG, "r");
      fs.readSync(fd, buf, 0, size, st.size - size);
      fs.closeSync(fd);
      const d = new Date(st.mtime);
      const dia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      colherChat(buf.toString("utf8"), dia, hoje);
    } catch { /* sem log */ }

    let out = hoje;
    if (out.length < max) {
      let antigos = [];
      try {
        const arquivos = fs.readdirSync(path.join(DATA, "logs"))
          .map((n) => ({ n, m: ROTACIONADO_RE.exec(n) }))
          .filter((x) => x.m)
          .sort((a, b) => b.m[1].localeCompare(a.m[1]) || Number(b.m[2]) - Number(a.m[2])); // do mais novo
        for (const f of arquivos.slice(0, 12)) {
          // rotacionado é imutável: parseia uma vez, depois é só cache
          let bloco = chatGzCache.get(f.n);
          if (!bloco) {
            bloco = [];
            try {
              const gz = fs.readFileSync(path.join(DATA, "logs", f.n));
              colherChat(zlib.gunzipSync(gz).toString("utf8"), f.m[1], bloco);
            } catch { continue; }
            if (chatGzCache.size > 30) chatGzCache.clear(); // nunca acumula além do que a UI alcança
            chatGzCache.set(f.n, bloco);
          }
          antigos = bloco.concat(antigos);
          if (antigos.length + hoje.length >= max) break;
        }
      } catch { /* sem pasta de logs */ }
      out = antigos.concat(hoje);
    }
    return out.slice(-max);
  }

  // o refresh chama isto a cada 5s: ler o log INTEIRO pra pegar uma linha do começo
  // era o maior desperdício do painel. Lê só os primeiros 20 KB e cacheia por inode —
  // a versão não muda enquanto o processo do servidor viver; rotação troca o inode.
  let versionCache = { ino: null, v: null };

  function version() {
    try {
      const st = fs.statSync(LOG);
      if (versionCache.ino === st.ino && versionCache.v) return versionCache.v;
      const size = Math.min(st.size, 20000);
      const buf = Buffer.alloc(size);
      const fd = fs.openSync(LOG, "r");
      fs.readSync(fd, buf, 0, size, 0);
      fs.closeSync(fd);
      const m = /Starting minecraft server version (\S+)/.exec(buf.toString("utf8"));
      if (m) {
        versionCache = { ino: st.ino, v: m[1] };
        return m[1];
      }
    } catch { /* idem */ }
    return versaoPadrao;
  }

  /**
   * Segue o latest.log por polling. Poll simples em vez de fs.watch porque o
   * arquivo vem de um bind mount — inotify não é confiável nesse caminho.
   */
  function tail(onLine, { seedLines = 80, intervalMs = 1000 } = {}) {
    let pos = 0;
    let inode = null;
    let rest = "";

    try {
      const st = fs.statSync(LOG);
      inode = st.ino;
      pos = st.size;
      if (seedLines > 0) {
        const size = Math.min(st.size, 128 * 1024);
        const buf = Buffer.alloc(size);
        const fd = fs.openSync(LOG, "r");
        fs.readSync(fd, buf, 0, size, st.size - size);
        fs.closeSync(fd);
        buf.toString("utf8").split("\n").filter(Boolean).filter((l) => !silenciada(l))
          .slice(-seedLines)
          .forEach((l) => onLine(l, true));
      }
    } catch { /* log aparece depois */ }

    setInterval(() => {
      let st;
      try { st = fs.statSync(LOG); } catch { return; }
      if (inode !== null && (st.ino !== inode || st.size < pos)) { pos = 0; rest = ""; } // rotacionou
      inode = st.ino;
      if (st.size <= pos) return;
      try {
        const len = st.size - pos;
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(LOG, "r");
        fs.readSync(fd, buf, 0, len, pos);
        fs.closeSync(fd);
        pos = st.size;
        const parts = (rest + buf.toString("utf8")).split("\n");
        rest = parts.pop() ?? "";
        for (const l of parts) if (l.trim() && !silenciada(l)) onLine(l, false);
      } catch { /* tenta no próximo tick */ }
    }, intervalMs).unref();
  }

  return { bans, whitelist, properties, startedAt, chatHistory, version, tail };
}
