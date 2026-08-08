import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { erro409 } from "./erros.js";

/**
 * Backup do mundo: o painel roda `save-off` + `save-all flush` no servidor,
 * empacota `world/` num tar.gz e devolve o `save-on` no fim, aconteça o que
 * acontecer.
 *
 * O mesmo tar serve dois destinos:
 *
 * - **download** (`start`) — o stream sai pelo corpo da resposta e nada toca o
 *   disco. É um GET direto porque o navegador precisa gerenciar o arquivo, e GET
 *   não carrega header de Authorization: por isso um POST autenticado pega um
 *   ticket de uso único e o GET apresenta o ticket.
 * - **arquivo** (`paraArquivo`) — o mesmo stream vai para um `.part` no disco,
 *   usado pelo backup automático. Ver `backupauto.js`.
 *
 * A trava `busy` é uma só para os dois: nunca há dois tar do mesmo mundo.
 */

const TICKET_MS = 60_000;

/** Um backup por servidor: ticket, trava de ocupado e cache de tamanho são de cada um. */
export function criar({ dados, mundo = "world" }) {
  const DATA = dados;
  const WORLD = mundo;

  // por instância: um ticket emitido para o servidor A não abre o mundo do servidor B
  const tickets = new Map(); // id -> expira em (ms)

  function issueTicket() {
    const id = crypto.randomBytes(24).toString("base64url");
    tickets.set(id, Date.now() + TICKET_MS);
    for (const [k, exp] of tickets) if (exp < Date.now()) tickets.delete(k);
    return { ticket: id, expiresIn: TICKET_MS / 1000 };
  }

  /** Uso único: quem resgata, queima. */
  function useTicket(id) {
    const exp = tickets.get(id);
    if (!exp) return false;
    tickets.delete(id);
    return exp >= Date.now();
  }

  /* ---------------- tamanho ---------------- */

  let sizeCache = { at: 0, bytes: null };

  function size() {
    if (Date.now() - sizeCache.at < 300_000) return Promise.resolve(sizeCache.bytes);
    return new Promise((resolve) => {
      const child = spawn("du", ["-sb", path.join(DATA, WORLD)]);
      let out = "";
      child.stdout.on("data", (b) => { out += b; });
      child.on("error", () => resolve(null));
      child.on("close", () => {
        const bytes = Number(out.split(/\s/)[0]);
        sizeCache = { at: Date.now(), bytes: Number.isFinite(bytes) ? bytes : null };
        resolve(sizeCache.bytes);
      });
    });
  }

  /* ---------------- stream ---------------- */

  let busy = false;

  function filename() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `world-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.tar.gz`;
  }

  /**
   * Abre o tar. `run` é o executor de RCON do servidor (o mesmo dos botões), pra
   * que save-off/save-on apareçam no console do painel.
   * Devolve o stdout do tar e um `done()` que precisa ser chamado uma vez só —
   * o chamador amarra ele no fim da resposta E no abort do cliente.
   */
  async function start(run) {
    if (busy) throw erro409("já existe um backup em andamento");
    busy = true;

    try {
      await run("save-off");
      await run("save-all flush");
    } catch (err) {
      busy = false;
      // se o save-off passou e o flush falhou, não dá pra deixar o servidor sem salvar
      await run("save-on").catch(() => {});
      throw err;
    }

    // nice: compactar 1 GB não pode competir por CPU com a thread do servidor
    const child = spawn("nice", ["-n", "10", "tar", "-czf", "-", "-C", DATA, WORLD], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (b) => { if (stderr.length < 2000) stderr += String(b).slice(0, 2000); });

    let finished = false;
    const done = async () => {
      if (finished) return;
      finished = true;
      if (child.exitCode === null) child.kill("SIGTERM"); // cliente desistiu no meio
      busy = false;
      await run("save-on").catch(() => {});
    };

    return { stream: child.stdout, done, stderrRef: () => stderr };
  }

  /**
   * O mesmo backup, gravado em disco em vez de enviado ao navegador.
   *
   * Escreve num `.part` e só renomeia no fim: backup interrompido — tar que
   * morreu, disco que encheu, painel que caiu — nunca se passa por um arquivo
   * completo. Se falhar, o `.part` é removido e o `save-on` acontece de todo
   * jeito, porque `done()` está no `finally`.
   *
   * @returns {{ arquivo: string, bytes: number }}
   */
  async function paraArquivo(run, destino) {
    const parcial = `${destino}.part`;
    const { stream, done, stderrRef } = await start(run);
    try {
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      await pipeline(stream, fs.createWriteStream(parcial));
      const { size: bytes } = fs.statSync(parcial);
      if (!bytes) throw new Error(`o tar não gerou nada${stderrRef() ? `: ${stderrRef().slice(0, 200)}` : ""}`);
      fs.renameSync(parcial, destino);
      return { arquivo: path.basename(destino), bytes };
    } catch (err) {
      try { fs.unlinkSync(parcial); } catch { /* já não existia */ }
      const detalhe = stderrRef().trim();
      throw new Error(detalhe ? `${err.message} — ${detalhe.slice(0, 200)}` : err.message);
    } finally {
      await done();
    }
  }

  return { issueTicket, useTicket, size, filename, start, paraArquivo, isBusy: () => busy };
}
