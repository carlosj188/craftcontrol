import fs from "node:fs";
import path from "node:path";

/**
 * Quem fez o quê, e quando — o rastro que sobrevive a reinício.
 *
 * O console do painel já mostrava as ações, mas num anel de 500 linhas que morre
 * junto com o processo. Aqui é arquivo: `<painel>/mcpanel/eventos.jsonl`, uma
 * linha JSON por evento.
 *
 * **JSONL e não CSV** (o histórico de TPS é CSV) porque ali toda linha tem as
 * mesmas quatro colunas numéricas, e aqui os campos variam por tipo de ação.
 * A gravação continua sendo append de uma linha, que é o que importa para o
 * custo.
 *
 * **Só mutação e login.** `GET` de fora: um painel aberto o dia todo geraria
 * milhares de linhas de leitura e o arquivo deixaria de ser legível justamente
 * quando alguém precisasse dele. Login entra — inclusive o que falhou, que é o
 * que denuncia acesso indevido.
 *
 * **Nunca o corpo cru.** Pela mesma função passam a senha do login e o `.jar` do
 * upload; o que vai para o disco é só o resumo que a tabela de permissões monta,
 * campo por campo.
 */

const RETER_DIAS = Number(process.env.EVENTOS_DIAS || 90);
const PODA_MS = 24 * 60 * 60_000; // uma vez por dia basta
const MAX_LINHA = 2000;           // corta linha absurda antes de gravar

export function criar({ dados, log }) {
  const PASTA = path.join(dados, "mcpanel");
  const ARQUIVO = path.join(PASTA, "eventos.jsonl");

  /**
   * Zero, e não `Date.now()`: começando no relógio de agora, a poda só rodaria se
   * o processo sobrevivesse um dia inteiro — e o painel reinicia a cada deploy.
   * Na prática a retenção nunca era aplicada e o arquivo crescia sem teto,
   * enquanto a tela prometia 90 dias. Começando em zero, a primeira gravação
   * depois de subir já limpa o que venceu.
   */
  let ultimaPoda = 0;

  /**
   * Grava um evento. Nunca lança: falhar em registrar não pode desfazer a ação
   * que já aconteceu, nem derrubar a resposta que já está indo.
   */
  function registrar(ev) {
    const linha = JSON.stringify({
      em: new Date().toISOString(),
      quem: ev.quem || "?",
      papel: ev.papel || null,
      acao: ev.acao || "outro",
      resumo: ev.resumo || null,
      servidor: ev.servidor || null,
      ip: ev.ip || null,
      ok: ev.ok !== false,
    });

    try {
      fs.mkdirSync(PASTA, { recursive: true });
      fs.appendFileSync(ARQUIVO, linha.slice(0, MAX_LINHA) + "\n");
    } catch (err) {
      log?.("warn", `não consegui gravar o evento: ${err.message}`);
      return;
    }

    if (Date.now() - ultimaPoda > PODA_MS) { ultimaPoda = Date.now(); podar(); }
  }

  /** Corta o que passou da retenção, com troca atômica. */
  function podar() {
    try {
      const corte = Date.now() - RETER_DIAS * 86400_000;
      const linhas = fs.readFileSync(ARQUIVO, "utf8").split("\n").filter(Boolean);
      const vivas = linhas.filter((l) => {
        try { return new Date(JSON.parse(l).em).getTime() >= corte; } catch { return false; }
      });
      if (vivas.length === linhas.length) return;
      const tmp = `${ARQUIVO}.tmp`;
      fs.writeFileSync(tmp, vivas.join("\n") + (vivas.length ? "\n" : ""));
      fs.renameSync(tmp, ARQUIVO);
    } catch { /* arquivo ainda não existe: nada a podar */ }
  }

  /**
   * Os eventos mais recentes primeiro, com filtros opcionais, e junto a lista de
   * quem já apareceu — que é o que a caixa de seleção da interface precisa.
   *
   * **As duas coisas saem da mesma passagem.** Antes eram duas: a rota chamava
   * `ler()` e depois um `quemJaApareceu()` que abria e parseava o arquivo inteiro
   * de novo, para no fim só extrair nomes do que a primeira já tinha lido.
   *
   * `pessoas` ignora os filtros de propósito. Se seguisse o filtro, escolher uma
   * pessoa tiraria todas as outras da caixa — e a seleção se apagava sozinha.
   * Também não tem teto: no jeito antigo, os nomes saíam dos 1000 eventos mais
   * recentes, então quem parava de mexer no painel sumia da caixa sem aviso.
   *
   * Linha ilegível é pulada em silêncio — é append de um processo que pode ser
   * morto no meio de uma escrita, exatamente como no histórico de TPS.
   */
  function ler({ dias, quem, acao, limite = 200 } = {}) {
    const vazio = { eventos: [], total: 0, pessoas: [], retencaoDias: RETER_DIAS };
    let bruto = "";
    try { bruto = fs.readFileSync(ARQUIVO, "utf8"); } catch { return vazio; }

    const corte = dias ? Date.now() - Math.min(RETER_DIAS, Math.max(1, Number(dias))) * 86400_000 : 0;
    const alvoQuem = quem ? String(quem).toLowerCase() : null;
    const out = [];
    const pessoas = new Set();

    for (const linha of bruto.split("\n")) {
      if (!linha) continue;
      let ev;
      try { ev = JSON.parse(linha); } catch { continue; }
      if (ev.quem) pessoas.add(ev.quem);
      if (corte && new Date(ev.em).getTime() < corte) continue;
      if (alvoQuem && String(ev.quem).toLowerCase() !== alvoQuem) continue;
      if (acao && !String(ev.acao).startsWith(String(acao))) continue;
      out.push(ev);
    }

    out.reverse(); // mais recente primeiro, que é como se lê
    return {
      eventos: out.slice(0, Math.min(1000, Math.max(1, Number(limite) || 200))),
      total: out.length,
      pessoas: [...pessoas].sort((a, b) => a.localeCompare(b)),
      retencaoDias: RETER_DIAS,
    };
  }

  return { registrar, ler, arquivo: ARQUIVO };
}
