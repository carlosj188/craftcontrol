import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * Histórico de quem já entrou no servidor, reconstruído do próprio log.
 *
 * O RCON não guarda nada disso e o painel reinicia, então a fonte é o log4j:
 * os arquivos rotacionados (`AAAA-MM-DD-N.log.gz`) mais o `latest.log`. A linha
 * só traz `[HH:MM:SS]` — a data vem do nome do arquivo, e do mtime no caso do
 * `latest.log`. Depois do boot o modelo é mantido vivo pelo tail.
 *
 * Fallback: quem não aparece em nenhum log retido (rotação come os antigos) ainda
 * tem o mtime do `world/playerdata/<uuid>.dat`, que o servidor grava ao deslogar.
 */

// exige [Server thread/INFO] pra não confundir com chat: "<Fulano> beltrano joined the game"
const EVENT_RE = /^\[(\d{2}):(\d{2}):(\d{2})\] \[Server thread\/INFO\]:? ([A-Za-z0-9_]{1,16}) (joined|left) the game$/;
const BOOT_RE = /^\[(\d{2}):(\d{2}):(\d{2})\] \[[^\]]*\]:? Starting minecraft server version/;
const TIME_RE = /^\[(\d{2}):(\d{2}):(\d{2})\]/;
const ROTATED_RE = /^(\d{4}-\d{2}-\d{2})-(\d+)\.log(\.gz)?$/;

const DAY = 86400000;

function midnight(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/** Quantas vezes o relógio do arquivo volta pra trás — cada volta é um dia novo. */
function countRollovers(lines) {
  let prev = -1;
  let n = 0;
  for (const line of lines) {
    const m = TIME_RE.exec(line);
    if (!m) continue;
    const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    if (prev >= 0 && secs < prev) n++;
    prev = secs;
  }
  return n;
}

function readLines(file) {
  const buf = fs.readFileSync(file);
  const txt = file.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  return txt.split("\n");
}

/** Um histórico por servidor: cada um tem sua pasta de logs e seu modelo vivo. */
export function criar({ dados }) {
  const LOGS = path.join(dados, "logs");
  const PLAYERDATA = path.join(dados, "world", "playerdata");

  /** nick -> registro acumulado */
  let players = new Map();
  /** nick -> ms do join ainda sem o "left" correspondente */
  let open = new Map();
  /** Data do log mais antigo ainda retido — é até onde o histórico enxerga. */
  let oldestMs = null;

  function rec(nick) {
    let r = players.get(nick);
    if (!r) {
      r = { nick, firstSeen: null, lastJoin: null, lastLeave: null, sessions: 0, playedMs: 0, source: "log" };
      players.set(nick, r);
    }
    return r;
  }

  function onJoin(nick, ts) {
    const r = rec(nick);
    if (!r.firstSeen || ts < r.firstSeen) r.firstSeen = ts;
    r.lastJoin = ts;
    r.source = "log";
    open.set(nick, ts);
  }

  function onLeave(nick, ts) {
    const r = rec(nick);
    const started = open.get(nick);
    if (started != null && ts >= started) {
      r.playedMs += ts - started;
      r.sessions++;
    }
    open.delete(nick);
    if (!r.lastLeave || ts > r.lastLeave) r.lastLeave = ts;
    if (!r.firstSeen || ts < r.firstSeen) r.firstSeen = ts;
    r.source = "log";
  }

  /** Servidor subiu: quem estava online caiu junto e nunca teve o "left" no log. */
  function onBoot() {
    open.clear();
  }

  function scan(lines, baseMs) {
    let day = 0;
    let prev = -1;
    for (const line of lines) {
      const tm = TIME_RE.exec(line);
      if (!tm) continue;
      const secs = Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3]);
      if (prev >= 0 && secs < prev) day++;
      prev = secs;
      const ts = baseMs + day * DAY + secs * 1000;

      if (BOOT_RE.test(line)) { onBoot(); continue; }
      const m = EVENT_RE.exec(line);
      if (!m) continue;
      if (m[5] === "joined") onJoin(m[4], ts);
      else onLeave(m[4], ts);
    }
  }

  /**
   * Corrige o "último logout" pelo mtime do `world/playerdata/<uuid>.dat`, que o
   * servidor grava ao desconectar. Manda mais que o log por dois motivos: cobre
   * quem só aparece em log já rotacionado fora, e não sofre com o fuso — os logs
   * anteriores a 04/08/2026 saíram em UTC (o TZ do contêiner só valeu na recriação),
   * então a hora deles está 4h adiantada. Sessões e tempo total continuam vindo do
   * log: são diferenças, o deslocamento se cancela.
   */
  function applyPlayerdata() {
    let cache = [];
    try {
      cache = JSON.parse(fs.readFileSync(path.join(dados, "usercache.json"), "utf8"));
    } catch { return; }
    if (!Array.isArray(cache)) return;

    for (const entry of cache) {
      if (!entry?.name || !entry?.uuid) continue;
      let mtime;
      try {
        mtime = fs.statSync(path.join(PLAYERDATA, `${entry.uuid}.dat`)).mtimeMs;
      } catch { continue; }
      const novo = !players.has(entry.name);
      const r = rec(entry.name);
      r.lastLeave = Math.round(mtime);
      if (novo) r.source = "playerdata"; // sem log nenhum: só sabemos a última vez
    }
  }

  /** Lê tudo do zero. Chamado uma vez no boot — os .gz somam poucas centenas de KB. */
  function build() {
    players = new Map();
    open = new Map();
    oldestMs = null;

    let names = [];
    try { names = fs.readdirSync(LOGS); } catch { /* sem volume de log */ }

    const rotated = names
      .map((n) => ({ n, m: ROTATED_RE.exec(n) }))
      .filter((x) => x.m)
      .sort((a, b) => a.m[1].localeCompare(b.m[1]) || Number(a.m[2]) - Number(b.m[2]));

    if (rotated.length) oldestMs = midnight(rotated[0].m[1]);

    for (const f of rotated) {
      try { scan(readLines(path.join(LOGS, f.n)), midnight(f.m[1])); } catch { /* log corrompido */ }
    }

    // latest.log não tem data no nome: ancora pelo mtime e recua os dias que ele atravessou
    try {
      const file = path.join(LOGS, "latest.log");
      const st = fs.statSync(file);
      const lines = readLines(file);
      const end = new Date(st.mtime);
      const base = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime()
        - countRollovers(lines) * DAY;
      scan(lines, base);
    } catch { /* servidor nunca subiu */ }

    applyPlayerdata();
    return players.size;
  }

  /** Linha nova vinda do tail — mantém o modelo vivo sem reler os arquivos. */
  function feed(rawLine) {
    if (BOOT_RE.test(rawLine)) { onBoot(); return; }
    const m = EVENT_RE.exec(rawLine);
    if (!m) return;
    // a linha chega em ~1s: o relógio do painel é mais confiável que remontar a data
    const ts = Date.now();
    if (m[5] === "joined") onJoin(m[4], ts);
    else onLeave(m[4], ts);
  }

  /**
   * Lista pro painel. `onlineNow` vem do RCON e manda no status — o log pode ter
   * perdido um "left" (crash) e não vale contradizer quem está de fato conectado.
   */
  function list(onlineNow = []) {
    const online = new Set(onlineNow.map((p) => p.nick));
    const out = [];

    for (const r of players.values()) {
      const isOn = online.has(r.nick);
      out.push({
        nick: r.nick,
        online: isOn,
        lastSeen: isOn ? null : r.lastLeave ?? r.lastJoin ?? null,
        firstSeen: r.firstSeen,
        sessions: r.sessions,
        playedMs: r.playedMs + (isOn && open.has(r.nick) ? Date.now() - open.get(r.nick) : 0),
        approx: r.source === "playerdata",
      });
    }

    // quem está online primeiro, depois os mais recentes
    out.sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
    return out;
  }

  /**
   * Quando começou a sessão em curso deste jogador, segundo o log.
   *
   * É a hora real do "joined the game", e não "quando o painel reparou nele" —
   * que era o que a lista de jogadores mostrava antes. A diferença aparecia toda
   * vez que o painel ficava de pé mais tempo que o jogador: o carimbo de uma
   * sessão antiga sobrevivia e a pessoa entrava já marcada como online há horas.
   * Além de correto, isto sobrevive a reinício do painel, porque a fonte é o log.
   *
   * `null` quando o log não viu o join (rotação levou, ou o painel subiu com o
   * jogador já dentro) — nesse caso quem responde é o `firstSeen` de sempre.
   */
  function sessaoAberta(nick) {
    const ms = open.get(nick);
    return ms ? new Date(ms).toISOString() : null;
  }

  return { build, feed, list, sessaoAberta, oldest: () => oldestMs };
}
