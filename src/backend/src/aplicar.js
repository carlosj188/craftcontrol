/**
 * Aplicar mudanças de mod com rede de segurança.
 *
 * Mexer em mod é a única coisa do painel que pode impedir o servidor de subir: um
 * jar incompatível ou uma dependência que sumiu e o boot morre no meio, com o
 * usuário olhando para um servidor fora do ar sem saber o que desfazer. Aqui o
 * painel reinicia, **vigia** e, se o servidor não voltar, devolve a pasta ao que
 * era antes e reinicia de novo. O pior caso deixa de ser "servidor morto" e passa
 * a ser "alguns minutos fora e uma explicação na tela".
 *
 * O que torna isso possível é a lixeira do mods.js: nada é apagado na hora, então
 * toda mudança pendente é reversível — inclusive remover e atualizar.
 *
 * **Como sabemos que subiu.** Em ordem de confiança:
 *   1. healthcheck do contêiner virou `healthy` (a imagem itzg tem um, e ele só
 *      passa quando o servidor responde de verdade);
 *   2. sem healthcheck, o RCON respondendo — que é o mesmo sinal que acende a
 *      pílula "no ar" do topo.
 * Falha é o inverso com paciência: `unhealthy` com faltas repetidas, contêiner
 * parado, ou o tempo acabar.
 */

import { erroHttp, erro400, erro409 } from "./erros.js";

const ESPERA_MS = Number(process.env.MODS_APLICAR_TIMEOUT_MS || 240000); // 4 min
const INTERVALO_MS = 3000;
const FALHAS_PARA_DESISTIR = 3;

export function criar({ mods, docker, log, estadoServidor, avisar }) {
  let estado = vazio();

  function vazio() {
    return {
      rodando: false, fase: null, detalhe: null, erro: null,
      ok: null, revertido: false, em: null, mudancas: 0,
    };
  }

  const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

  function marcar(fase, detalhe = null) {
    estado.fase = fase;
    estado.detalhe = detalhe;
    if (detalhe) log("info", detalhe);
  }

  /**
   * Observa até o servidor voltar ou o tempo acabar.
   *
   * `desdeAntes` é o `StartedAt` do contêiner antes do reinício, e é o que
   * distingue o boot novo do velho. A primeira versão disto esperava *ver* o
   * contêiner parado, e num reinício rápido — mais rápido que o intervalo de
   * checagem — essa janela nunca era observada: o vigia então lia `healthy` do
   * boot anterior, se recusava a aceitá-lo e ficava girando até estourar o
   * tempo, revertendo uma mudança que tinha dado certo. O carimbo não tem essa
   * corrida.
   *
   * @returns {{subiu:boolean, motivo:string}}
   */
  async function vigiar(limite, desdeAntes) {
    let falhas = 0;
    let bootNovo = false;

    while (Date.now() < limite) {
      await pausa(INTERVALO_MS);
      const d = await docker.estado().catch(() => null);

      if (!d || d.erro) {
        falhas++;
      } else {
        // o contêiner subiu de novo? carimbo diferente, ou visto parado no caminho
        if (!bootNovo && ((d.desde && desdeAntes && d.desde !== desdeAntes) || !d.rodando)) {
          bootNovo = true;
        }
        // sem carimbo em nenhum dos dois lados não dá para distinguir os boots;
        // aí resta confiar no que estamos vendo agora
        if (!bootNovo && !d.desde && !desdeAntes) bootNovo = true;

        if (!d.rodando) {
          falhas = 0;
          marcar("esperando", "o contêiner está fora do ar, aguardando subir");
        } else if (d.temSaude) {
          if (bootNovo && d.saude === "healthy") return { subiu: true, motivo: "healthcheck passou" };
          if (d.saude === "unhealthy") {
            falhas = Math.max(falhas, d.falhasSeguidas || 0);
            if (falhas >= FALHAS_PARA_DESISTIR) return { subiu: false, motivo: "o healthcheck falhou seguidamente" };
          }
        } else if (bootNovo && estadoServidor()?.online) {
          // sem healthcheck: o RCON respondendo é o sinal de que o mundo carregou
          return { subiu: true, motivo: "o RCON respondeu" };
        }
      }

      const restante = Math.max(0, Math.round((limite - Date.now()) / 1000));
      estado.detalhe = `esperando o servidor voltar… ${restante}s`;
    }
    return { subiu: false, motivo: "o servidor não voltou no tempo esperado" };
  }

  /** `StartedAt` de agora — a referência para saber que o boot seguinte é outro. */
  const carimboAtual = async () => (await docker.estado().catch(() => null))?.desde || null;

  /**
   * Reinicia para valer as mudanças pendentes e confirma que o servidor voltou.
   * Não espera o fim: devolve na hora e o progresso sai em `status()`.
   */
  async function aplicar({ espera = ESPERA_MS } = {}) {
    if (estado.rodando) throw erro409("já tem uma aplicação em andamento");
    const mudancas = mods.journal();
    if (!mudancas.length) throw erro400("não há mudança pendente para aplicar");
    if (!docker.habilitado()) {
      throw erroHttp(501, "o painel não controla o contêiner: reinicie o servidor por fora");
    }

    estado = { ...vazio(), rodando: true, em: new Date().toISOString(), mudancas: mudancas.length };
    correr(mudancas, espera).catch((err) => {
      estado.erro = err.message;
      estado.rodando = false;
      estado.fase = "erro";
    });
    return status();
  }

  async function correr(mudancas, espera) {
    const limite = Date.now() + espera;
    try {
      marcar("avisando", null);
      // quem estiver jogando merece saber por que vai cair
      await avisar?.(`Reiniciando para aplicar ${mudancas.length} ${mudancas.length === 1 ? "mudança" : "mudanças"} de mod`).catch(() => {});

      marcar("reiniciando", `aplicando ${mudancas.length} mudança(s) de mod: reiniciando o servidor`);
      const antes = await carimboAtual();
      await docker.reiniciar();

      marcar("esperando", "servidor reiniciado, esperando ele voltar");
      const r = await vigiar(limite, antes);

      if (r.subiu) {
        const apagados = mods.confirmar();
        estado.ok = true;
        marcar("pronto", `mods aplicados: ${r.motivo}${apagados ? `, ${apagados} jar(s) antigos descartados` : ""}`);
        return;
      }

      /* ---- não subiu: desfaz tudo e volta ---- */
      log("err", `o servidor não voltou (${r.motivo}) — desfazendo as mudanças de mod`);
      marcar("revertendo", "o servidor não voltou; devolvendo os mods de antes");
      const erros = mods.desfazer(mudancas);
      for (const e of erros) log("err", `ao desfazer: ${e}`);

      marcar("reiniciando", "reiniciando com os mods de antes");
      const antesDaVolta = await carimboAtual();
      await docker.reiniciar();
      const volta = await vigiar(Date.now() + espera, antesDaVolta);

      estado.ok = false;
      estado.revertido = true;
      estado.erro = r.motivo;
      marcar(volta.subiu ? "revertido" : "revertido-sem-confirmar",
        volta.subiu
          ? "mods de antes restaurados e servidor no ar de novo"
          : "mods de antes restaurados, mas o servidor ainda não confirmou que voltou");
    } finally {
      estado.rodando = false;
    }
  }

  const status = () => ({ ...estado });

  return { aplicar, status };
}
