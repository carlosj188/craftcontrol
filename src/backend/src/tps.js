/**
 * TPS e tempo por tick — sem mod nenhum.
 *
 * Duas fontes vanilla, ambas por RCON:
 *
 * 1. `time query gametime` devolve a idade do mundo em ticks ("The time is 17537312").
 *    Ela avança exatamente uma vez por tick, então TPS = Δgametime ÷ Δrelógio. Funciona
 *    em qualquer versão e é a medida de verdade: se o servidor engasga, o contador
 *    fica para trás junto. (`doDaylightCycle` mexe no *daytime*, não neste contador.)
 * 2. `tick query`, vanilla desde a 1.20.3, dá o tempo médio por tick e os percentis.
 *    Em servidor mais velho o comando não existe e o painel simplesmente mostra só o TPS.
 *
 * Por que não o spark: ele responde num worker e o texto sai no log, não pelo RCON —
 * daria para colher do tail, mas exigiria um mod que nem todo servidor tem. Estes dois
 * comandos respondem na hora e **não escrevem nada** no latest.log.
 */

const POLL_MS = Number(process.env.TPS_POLL_MS || 5000);
// sem ninguém olhando o painel não há motivo de ficar perguntando
const OCIOSO_MS = Number(process.env.TPS_IDLE_MS || 45_000);
const TICK_QUERY_MS = 15_000; // o custo é o mesmo, mas o número muda devagar
const JANELA_MS = 120_000;    // guarda 2 min de amostras

const GAMETIME_RE = /The time is (\d+)/;
const DESCONHECIDO_RE = /Unknown or incomplete command|<--\[HERE\]/i;

const limpa = (s) => String(s || "").replace(/§[0-9a-fk-or]/gi, "").trim();

export function criar({ rcon, online }) {
  const amostras = [];        // {gt, em}
  let tick = null;            // saída do `tick query`
  let tickSuportado = null;   // null = ainda não sei
  let ultimoTickQuery = 0;
  let ultimoAcesso = 0;
  let erro = null;
  let timer = null;

  /** O painel pediu estado: mantém a medição viva pelos próximos OCIOSO_MS. */
  function acordar() {
    ultimoAcesso = Date.now();
    if (!timer) {
      timer = setInterval(() => { medir().catch(() => {}); }, POLL_MS);
      timer.unref();
      medir().catch(() => {});
    }
  }

  function dormir() {
    if (timer) clearInterval(timer);
    timer = null;
    amostras.length = 0; // o próximo Δ não pode atravessar o intervalo em que ninguém mediu
  }

  async function medir() {
    if (Date.now() - ultimoAcesso > OCIOSO_MS) return dormir();
    if (online && !online()) { amostras.length = 0; return; }

    try {
      const saida = limpa(await rcon.send("time query gametime"));
      const m = GAMETIME_RE.exec(saida);
      if (!m) throw new Error(`não entendi a resposta do gametime: ${saida.slice(0, 60)}`);
      const gt = Number(m[1]);
      const agora = Date.now();

      // mundo trocado (restauração) ou contador para trás: recomeça a medir
      const ultimo = amostras[amostras.length - 1];
      if (ultimo && gt < ultimo.gt) amostras.length = 0;

      amostras.push({ gt, em: agora });
      while (amostras.length && agora - amostras[0].em > JANELA_MS) amostras.shift();
      erro = null;
    } catch (err) {
      erro = err.message || String(err);
      amostras.length = 0;
      return;
    }

    if (tickSuportado !== false && Date.now() - ultimoTickQuery >= TICK_QUERY_MS) {
      ultimoTickQuery = Date.now();
      try {
        const saida = limpa(await rcon.send("tick query"));
        if (DESCONHECIDO_RE.test(saida)) {
          tickSuportado = false; // servidor anterior à 1.20.3
        } else {
          tickSuportado = true;
          tick = lerTickQuery(saida);
        }
      } catch { /* fica com o valor anterior */ }
    }
  }

  /**
   * O RCON devolve as linhas grudadas e com códigos de cor, então o parse é por
   * regex solto, sem depender de quebra de linha:
   *   "The game is running normally  Target tick rate: 20.0 per second.
   *    Average time per tick: 13.6ms (Target: 50.0ms)
   *    Percentiles: P50: 13.2ms P95: 16.6ms P99: 21.5ms, sample: 100"
   */
  function lerTickQuery(saida) {
    const num = (re) => {
      const m = re.exec(saida);
      return m ? Number(m[1]) : null;
    };
    const p = /P50: ([\d.]+)ms P95: ([\d.]+)ms P99: ([\d.]+)ms/.exec(saida);
    return {
      mspt: num(/Average time per tick: ([\d.]+)ms/),
      alvoMs: num(/\(Target: ([\d.]+)ms\)/),
      alvoTps: num(/Target tick rate: ([\d.]+)/),
      p50: p ? Number(p[1]) : null,
      p95: p ? Number(p[2]) : null,
      p99: p ? Number(p[3]) : null,
      // "frozen" (/tick freeze) e "sprinting" (/tick sprint) fazem o TPS medido
      // mentir de propósito: o painel avisa em vez de mostrar um número estranho
      estado: /frozen/i.test(saida) ? "congelado" : /sprint/i.test(saida) ? "acelerado" : "normal",
    };
  }

  /** TPS na janela pedida: pega a amostra mais velha que ainda cabe nela. */
  function taxa(janelaMs) {
    if (amostras.length < 2) return null;
    const fim = amostras[amostras.length - 1];
    const limite = fim.em - janelaMs;
    let inicio = null;
    for (let i = amostras.length - 2; i >= 0; i--) {
      inicio = amostras[i];
      if (amostras[i].em <= limite) break;
    }
    const dt = (fim.em - inicio.em) / 1000;
    if (dt < 1) return null;
    const tps = (fim.gt - inicio.gt) / dt;
    // 20 é o teto do vanilla; o pouquinho a mais é jitter do relógio, não desempenho
    return Math.round(Math.min(20, Math.max(0, tps)) * 10) / 10;
  }

  function estado() {
    return {
      tps10s: taxa(10_000),
      tps1m: taxa(60_000),
      // sem `tick query` o painel ainda mostra TPS; com ele, também o tempo por tick
      tick: tickSuportado ? tick : null,
      tickSuportado,
      erro,
    };
  }

  return { acordar, estado };
}
