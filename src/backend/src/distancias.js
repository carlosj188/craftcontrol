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

/**
 * As únicas chaves que o painel mexe, com os limites que o servidor aceita.
 *
 * `env` é a variável da imagem `itzg` que manda na mesma coisa. Ela existe aqui
 * porque **a imagem reescreve o `server.properties` a cada boot** a partir do
 * ambiente do compose: com `VIEW_DISTANCE` definido lá, o painel grava 12, o
 * servidor reinicia e volta para o valor do compose — sem erro nenhum na tela.
 * Detectar isso é o que transforma uma falha silenciosa em aviso.
 */
export const AJUSTAVEIS = {
  "view-distance": { min: 3, max: 32, padrao: 10, rotulo: "visão", env: "VIEW_DISTANCE" },
  "simulation-distance": { min: 3, max: 32, padrao: 10, rotulo: "simulação", env: "SIMULATION_DISTANCE" },
};

const erro = (msg, statusCode = 400) => Object.assign(new Error(msg), { statusCode });

export function criar({ dados, mc, docker, log }) {
  const ARQUIVO = path.join(dados, "mcpanel", "distancias-pendente.json");

  /**
   * Quais das nossas chaves o compose vai sobrescrever no próximo boot.
   *
   * Assíncrono porque vem do Docker; quem chama sem esperar recebe lista vazia e
   * só perde o aviso. Nunca lança: sem acesso ao Docker o painel continua
   * funcionando, apenas sem conseguir prevenir.
   */
  async function sobrescritasPeloCompose() {
    const env = (await docker?.ambiente?.().catch(() => null)) || null;
    if (!env) return [];
    return Object.entries(AJUSTAVEIS)
      .filter(([, lim]) => env[lim.env] !== undefined)
      .map(([chave, lim]) => ({ chave, rotulo: lim.rotulo, variavel: lim.env, valor: env[lim.env] }));
  }

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
  async function estado() {
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
      // não vazio = o compose vai desfazer isto no próximo boot
      sobrescritas: await sobrescritasPeloCompose(),
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
  async function definir(pedido = {}) {
    const atual = await estado();
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

    // Recusa antes de gravar quando o compose manda na mesma chave: gravar daria
    // "salvo" na tela e o boot desfaria em silêncio, que é pior que um erro.
    const conflito = atual.sobrescritas.filter((s) => novos[s.chave] !== undefined);
    if (conflito.length) {
      const quais = conflito.map((c) => `${c.variavel}=${c.valor}`).join(" e ");
      throw erro(`o compose define ${quais}, e a imagem reescreve o server.properties a cada boot: `
        + "a mudança seria desfeita no reinício. Tire essa variável do compose.yaml e recrie o "
        + "contêiner do servidor — aí o painel passa a mandar nesse valor.", 409);
    }

    mc.escreverPropriedades(novos);
    // o "antes" é o que continua rodando até o próximo boot
    anotar({ ...novos, antes: atual.emUso });
    log?.("warn", `distâncias gravadas (visão ${visao}, simulação ${simulacao}) — valem no próximo reinício`);

    const depois = await estado();
    return { ...depois, pendente: true, emUso: atual.emUso };
  }

  return { estado, definir, arquivo: ARQUIVO };
}
