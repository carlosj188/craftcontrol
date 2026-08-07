import crypto from "node:crypto";

const SECRET = process.env.JWT_SECRET || "";
const USER = process.env.ADMIN_USER || "admin";
const PASSWORD = process.env.ADMIN_PASSWORD || "";
const TTL_DAYS = Number(process.env.SESSION_DAYS || 7);

if (!SECRET) throw new Error("JWT_SECRET não definido");
if (!PASSWORD) throw new Error("ADMIN_PASSWORD não definido");

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const sign = (data) => crypto.createHmac("sha256", SECRET).update(data).digest("base64url");

export function issueToken(sub) {
  const exp = Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, exp })}`;
  return `${body}.${sign(body)}`;
}

export function verifyToken(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = sign(body);
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function equals(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // compara o hash pra não vazar o tamanho da senha pelo tempo de resposta
  const ha = crypto.createHash("sha256").update(ba).digest();
  const hb = crypto.createHash("sha256").update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function checkCredentials(user, password) {
  return equals(user ?? "", USER) && equals(password ?? "", PASSWORD);
}

/** Freio simples de força bruta por IP — o painel é VPN-only, mas login é login. */
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
const MAX = 10;

export function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW) { attempts.delete(ip); return false; }
  return rec.count >= MAX;
}

export function registerFailure(ip) {
  // varre os vencidos antes de crescer — o mapa nunca acumula IPs antigos
  for (const [k, r] of attempts) if (Date.now() - r.first > WINDOW) attempts.delete(k);
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW) attempts.set(ip, { first: Date.now(), count: 1 });
  else rec.count++;
}

export function clearFailures(ip) {
  attempts.delete(ip);
}
