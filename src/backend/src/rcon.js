import { Rcon } from "rcon-client";

// o connect tem timeout próprio (5s), mas o send não: um servidor que aceita a
// conexão e nunca responde (Java preso em GC, watchdog prestes a agir) penduraria
// a promise — e com a fila serializada, TODO botão do painel junto com ela.
const SEND_TIMEOUT_MS = Number(process.env.RCON_SEND_TIMEOUT_MS || 10_000);

/**
 * Um cliente RCON por servidor. Conexão, fila e último erro são de cada
 * instância: servidor fora do ar não pode segurar o botão de outro.
 */
export function criar({ host, porta, senha }) {
  let client = null;
  let queue = Promise.resolve();

  async function getClient() {
    if (client) return client;
    const c = await Rcon.connect({ host, port: porta, password: senha, timeout: 5000 });
    // qualquer queda derruba o cache — a próxima chamada reconecta
    c.on("error", () => { client = null; });
    c.on("end", () => { client = null; });
    client = c;
    return c;
  }

  function drop() {
    const c = client;
    client = null;
    try { c?.end?.(); } catch { /* já caiu */ }
  }

  async function tentar(command) {
    const c = await getClient();
    let timer;
    try {
      return await Promise.race([
        c.send(command),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(`RCON não respondeu em ${SEND_TIMEOUT_MS / 1000}s`)), SEND_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Envia um comando. Serializa tudo numa fila: o protocolo RCON casa
   * resposta por id, mas com uma conexão só é mais simples não intercalar.
   * Uma falha derruba a conexão e tenta de novo — cobre o caso do servidor
   * ter reiniciado desde o último comando.
   */
  function send(command) {
    const run = async () => {
      try {
        return await tentar(command);
      } catch {
        drop();
        try {
          return await tentar(command);
        } catch (err2) {
          drop(); // conexão possivelmente podre (ex.: timeout) — não deixar em cache
          throw err2;
        }
      }
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  return { send };
}
