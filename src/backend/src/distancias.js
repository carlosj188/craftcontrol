import fs from "node:fs";
import path from "node:path";

/**
 * Distância de visão e de simulação, ajustáveis pelo painel.
 *
 * São as duas alavancas que mais mexem no desempenho, e as únicas do
 * `server.properties` que valem oferecer num botão: mudar as outras é raro e
 * arriscado, e o arquivo continua editável à mão para isso.
 *
 * **Não existe jeito de aplicar a quente.** O Minecraft baunilha não tem comando
 * para trocar distância em execução, e nenhum mod instalado aqui adiciona um
 * (foi conferido: sem Carpet). Então o painel grava no arquivo e a mudança vale
 * no próximo boot — a mesma regra que já vale para mods.
 *
 * A pendência usa o **carimbo de boot**, no mesmo padrão do `mods.js`: guarda-se
 * o `startedAt` de quando a mudança foi feita, e quando o servidor sobe de novo
 * esse carimbo muda e a pendência se resolve sozinha. Isso sobrevive a reinício
 * do próprio painel, que é `read_only` e não pode guardar estado em memória.
 *
 * ## O que cada uma faz, e por que a simulação nunca deve passar a visão
 *
 * - **visão** decide quais chunks são *enviados* ao jogador. É o que ele enxerga.
 * - **simulação** decide quais chunks *rodam*: mob anda, planta cresce, redstone
 *   pulsa. É a que custa CPU.
 *
 * Simulação maior que visão é desperdício puro: o servidor gasta tempo animando
 * chunk que ninguém recebe. Por isso a simulação é limitada pela visão aqui.
 */

/** As únicas chaves que o painel mexe, com os limites que o servidor aceita. */
export const AJUSTAVEIS = {
  "view-distance": { min: 3, max: 32, padrao: 10, rotulo: "visão" },
  "simulation-distance": { min: 3, max: 32, padrao: 10, rotulo: "simulação" },
};

const erro = (msg, statusCode = 400) => Object.assign(new Error(msg), { statusCode });

export function criar({ dados, mc, log }) {
  const ARQUIVO = path.join(dados, "mcpanel", "distancias-pendente.json");

  const carimboBoot = () => mc.startedAt() || null;

  const lerPendencia = () => {
    try { return JSON.parse(fs.readFileSync(ARQUIVO, "utf8")); } catch { return null; }
  };

  const limpar = () => { try { fs.unlinkSync(ARQUIVO); } catch { /* já não existia */ } };

  function anotar(valores) {
    try {
      fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
      const tmp = `${ARQUIVO}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ carimbo: carimboBoot(), valores }));
      fs.renameSync(tmp, ARQUIVO);
    } catch (err) {
      // sem o registro a interface só deixa de avisar; o arquivo já foi gravado
      log?.("warn", `não consegui anotar a pendência de distância: ${err.message}`);
    }
  }

  /**
   * O que está no arquivo, o que está rodando e o que falta reiniciar.
   *
   * `emUso` é o valor que o servidor carregou no boot — que só difere do arquivo
   * quando há mudança pendente. É ele que a interface mostra como "agora".
   */
  function estado() {
    const props = mc.properties();
    const numero = (chave) => {
      const n = Number(props[chave]);
      return Number.isFinite(n) ? n : AJUSTAVEIS[chave].padrao;
    };
    const arquivo = {
      "view-distance": numero("view-distance"),
      "simulation-distance": numero("simulation-distance"),
    };

    const p = lerPendencia();
    // carimbo diferente = o servidor subiu depois da mudança, então ela já vale
    if (p && p.carimbo !== carimboBoot()) { limpar(); }
    const pendente = p && p.carimbo === carimboBoot() ? p : null;

    return {
      arquivo,
      // sem pendência, o que está no arquivo é o que está rodando
      emUso: pendente?.valores?.antes ?? arquivo,
      pendente: Boolean(pendente),
      limites: AJUSTAVEIS,
    };
  }

  /**
   * Grava as novas distâncias. Devolve o estado já recalculado.
   *
   * Guarda o valor **anterior** junto da pendência: é o que permite a interface
   * dizer "roda com 8, vai para 12 no próximo reinício" em vez de só avisar que
   * há algo pendente.
   */
  function definir(pedido = {}) {
    const atual = estado();
    const novos = {};

    for (const [chave, lim] of Object.entries(AJUSTAVEIS)) {
      if (pedido[chave] === undefined) continue;
      const n = Number(pedido[chave]);
      if (!Number.isInteger(n)) throw erro(`${lim.rotulo}: precisa ser um número inteiro`);
      if (n < lim.min || n > lim.max) {
        throw erro(`${lim.rotulo}: use entre ${lim.min} e ${lim.max} chunks`);
      }
      novos[chave] = n;
    }
    if (!Object.keys(novos).length) throw erro("nada para mudar");

    const visao = novos["view-distance"] ?? atual.arquivo["view-distance"];
    const simulacao = novos["simulation-distance"] ?? atual.arquivo["simulation-distance"];
    if (simulacao > visao) {
      throw erro(`a simulação (${simulacao}) não pode passar da visão (${visao}): o servidor `
        + "gastaria CPU animando chunk que ninguém recebe");
    }

    // nada mudou de verdade: não suja o arquivo nem acende aviso à toa
    const mudou = Object.entries(novos).some(([k, v]) => v !== atual.arquivo[k]);
    if (!mudou) return atual;

    mc.escreverPropriedades(novos);
    // o "antes" é o que continua rodando até o próximo boot
    anotar({ ...novos, antes: atual.emUso });
    log?.("warn", `distâncias gravadas (visão ${visao}, simulação ${simulacao}) — valem no próximo reinício`);

    const depois = estado();
    return { ...depois, pendente: true, emUso: atual.emUso };
  }

  return { estado, definir, arquivo: ARQUIVO };
}
