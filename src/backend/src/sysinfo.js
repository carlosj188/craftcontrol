import fs from "node:fs";
import os from "node:os";

const DATA = process.env.MC_DATA || "/mcdata";

/**
 * CPU, memória e disco da máquina que hospeda o servidor.
 *
 * Não precisa montar nada nem dar privilégio nenhum: `/proc/stat` e `/proc/meminfo`
 * não são isolados por namespace, então de dentro do contêiner já se lê o host
 * (conferido: os números batem com os do host). O disco vem de
 * um statfs no volume de dados, que cai no mesmo sistema de arquivos do servidor.
 *
 * São números do host inteiro, não só do Minecraft — dá pra responder "a máquina
 * está apertada?", que é a pergunta que interessa aqui.
 */

let anterior = null;

function amostraCpu() {
  const linha = fs.readFileSync("/proc/stat", "utf8").split("\n", 1)[0];
  const v = linha.trim().split(/\s+/).slice(1).map(Number).filter(Number.isFinite);
  if (v.length < 4) return null;
  // user nice system idle iowait irq softirq steal ...
  return { ocioso: v[3] + (v[4] || 0), total: v.reduce((a, b) => a + b, 0) };
}

/** Percentual de CPU desde a chamada anterior. Null na primeira, que não tem base. */
function cpu() {
  const agora = amostraCpu();
  if (!agora) return null;
  const antes = anterior;
  anterior = agora;
  if (!antes) return null;
  const dTotal = agora.total - antes.total;
  const dOcioso = agora.ocioso - antes.ocioso;
  if (dTotal <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((1 - dOcioso / dTotal) * 100)));
}

function memoria() {
  try {
    const txt = fs.readFileSync("/proc/meminfo", "utf8");
    const kb = (chave) => {
      const m = new RegExp(`^${chave}:\\s+(\\d+) kB`, "m").exec(txt);
      return m ? Number(m[1]) * 1024 : null;
    };
    const total = kb("MemTotal");
    const livre = kb("MemAvailable");
    if (!total || livre == null) return null;
    return { total, usado: total - livre, pct: Math.round(((total - livre) / total) * 100) };
  } catch {
    return null;
  }
}

function disco() {
  try {
    const s = fs.statfsSync(DATA);
    const total = s.blocks * s.bsize;
    const disponivel = s.bavail * s.bsize;
    // usa o mesmo critério do df: o reservado do root não conta como espaço livre
    const usado = total - s.bfree * s.bsize;
    return { total, usado, disponivel, pct: Math.round((usado / (usado + disponivel)) * 100) };
  } catch {
    return null;
  }
}

// o /state é pedido a cada 2s por aba aberta, e a leitura de CPU é uma diferença
// entre chamadas: sem este cache, duas abas juntas mediriam janelas de milissegundos
// e o número dançaria. Uma amostra por 2s serve todo mundo.
const CACHE_MS = 2000;
let ultima = { em: 0, dados: null };

export function read() {
  if (ultima.dados && Date.now() - ultima.em < CACHE_MS) return ultima.dados;
  const dados = {
    cpu: cpu(),
    nucleos: os.cpus().length,
    carga: os.loadavg().map((n) => Math.round(n * 100) / 100),
    memoria: memoria(),
    disco: disco(),
  };
  ultima = { em: Date.now(), dados };
  return dados;
}
