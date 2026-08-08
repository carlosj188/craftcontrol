import fs from "node:fs";
import path from "node:path";

/**
 * Histórico de desempenho — o que alimenta o gráfico do dia.
 *
 * Uma linha por amostra em `<dados>/mcpanel/tps-historico.csv`:
 *
 *     <epochSegundos>,<tps>,<mspt>,<jogadores>
 *
 * CSV e não JSON porque a gravação é **append**: 2.880 linhas (48 h a 1/min)
 * ocupam ~70 KB, e acrescentar uma linha custa uma syscall. Reescrever um JSON
 * de 2.880 pontos a cada minuto seria o mesmo dado com muito mais I/O.
 *
 * **`jogadores` é o campo que dá valor ao gráfico.** TPS sozinho mostra que
 * travou; com a contagem ao lado dá para responder se trava com gente ou
 * sozinho — que é a pergunta que o diagnóstico de lag deixou em aberto. O dado
 * já está em memória, então custa zero.
 *
 * Linha ilegível é ignorada na leitura, nunca derruba a resposta: o arquivo é
 * append de um processo que pode ser morto no meio de uma escrita.
 */

const INTERVALO_MS = Number(process.env.TPS_HIST_MS || 60_000);
const RETER_H = Number(process.env.TPS_HIST_HORAS || 48);
const PODA_MS = 60 * 60_000; // uma vez por hora basta

export function criar({ dados, estadoServidor, log }) {
  const PASTA = path.join(dados, "mcpanel");
  const ARQUIVO = path.join(PASTA, "tps-historico.csv");

  let ultimoGravado = 0;
  let ultimaPoda = Date.now();

  /** Chamado pelo tps.js a cada medição; grava no máximo uma por INTERVALO_MS. */
  function registrar(tps, mspt) {
    const agora = Date.now();
    if (agora - ultimoGravado < INTERVALO_MS) return;
    ultimoGravado = agora;

    const jogadores = estadoServidor?.()?.count ?? 0;
    const linha = [
      Math.round(agora / 1000),
      Math.round(tps * 10) / 10,
      mspt == null ? "" : Math.round(mspt * 10) / 10,
      jogadores,
    ].join(",");

    try {
      fs.mkdirSync(PASTA, { recursive: true });
      fs.appendFileSync(ARQUIVO, linha + "\n");
    } catch (err) {
      log?.("warn", `não consegui gravar o histórico de TPS: ${err.message}`);
      return;
    }

    if (agora - ultimaPoda > PODA_MS) { ultimaPoda = agora; podar(); }
  }

  /** Corta o que passou da janela de retenção, com troca atômica. */
  function podar() {
    try {
      const corte = Math.round((Date.now() - RETER_H * 3600_000) / 1000);
      const linhas = fs.readFileSync(ARQUIVO, "utf8").split("\n");
      const vivas = linhas.filter((l) => {
        const t = Number(l.split(",", 1)[0]);
        return Number.isFinite(t) && t >= corte;
      });
      if (vivas.length === linhas.length - 1) return; // nada a cortar (a última é vazia)
      const tmp = `${ARQUIVO}.tmp`;
      fs.writeFileSync(tmp, vivas.join("\n") + (vivas.length ? "\n" : ""));
      fs.renameSync(tmp, ARQUIVO);
    } catch { /* arquivo ainda não existe ou sumiu: nada a podar */ }
  }

  /**
   * Pontos das últimas `horas`, como array de arrays.
   *
   * Array e não objeto de propósito: com 1.440 pontos, repetir as chaves em cada
   * um quase triplica o JSON que vai pela rede.
   *
   * @returns {{ pontos: Array<[number, number, number|null, number]>, intervaloS: number }}
   */
  function ler(horas = 24) {
    const h = Math.min(RETER_H, Math.max(1, Number(horas) || 24));
    const corte = Math.round((Date.now() - h * 3600_000) / 1000);
    let bruto = "";
    try { bruto = fs.readFileSync(ARQUIVO, "utf8"); } catch { return { pontos: [], intervaloS: INTERVALO_MS / 1000 }; }

    const pontos = [];
    for (const linha of bruto.split("\n")) {
      if (!linha) continue;
      const [t, tps, mspt, jog] = linha.split(",");
      const em = Number(t);
      const v = Number(tps);
      // linha truncada por um kill no meio da escrita: ignora e segue
      if (!Number.isFinite(em) || !Number.isFinite(v) || em < corte) continue;
      pontos.push([em, v, mspt === "" || mspt === undefined ? null : Number(mspt), Number(jog) || 0]);
    }
    pontos.sort((a, b) => a[0] - b[0]);
    return { pontos, intervaloS: INTERVALO_MS / 1000, retencaoH: RETER_H };
  }

  return { registrar, ler };
}
