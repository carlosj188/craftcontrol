/**
 * Ligar/desligar/reiniciar o contêiner de um servidor.
 *
 * O painel nunca toca no `/var/run/docker.sock`. Ele fala com o wollomatic/socket-proxy,
 * que só deixa passar o que casa com um regex — na prática apenas
 * `GET /containers/<nome>/json` e `POST /containers/<nome>/{start,stop,restart}`.
 * Painel comprometido não cria contêiner nem monta nada do host.
 *
 * ATENÇÃO ao acrescentar um segundo servidor: o regex do socket-proxy no compose
 * é fixo no nome do contêiner. Sem incluir o novo nome lá, a energia dele volta 403.
 *
 * Sem DOCKER_API definido, o recurso simplesmente não existe e o painel diz isso.
 */

const BASE = (process.env.DOCKER_API || "").replace(/\/$/, "");
// o desligamento manda SIGTERM e espera: 1,2 GB de mundo não salva em 10s (o padrão do Docker)
const ESPERA_PADRAO = Number(process.env.DOCKER_STOP_TIMEOUT || 90);

/** Um controle por servidor — só muda o nome do contêiner; o proxy é o mesmo. */
export function criar({ container, espera = ESPERA_PADRAO }) {
  const NOME = container;

  const habilitado = () => !!BASE && !!NOME;

  async function chamar(metodo, caminho, timeoutMs = (espera + 30) * 1000) {
    if (!habilitado()) throw Object.assign(new Error("controle do contêiner não configurado"), { statusCode: 501 });
    let res;
    try {
      res = await fetch(`${BASE}${caminho}`, { method: metodo, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw Object.assign(new Error(`não consegui falar com o docker: ${err.message}`), { statusCode: 502 });
    }
    // 304 = já estava no estado pedido (parar o que está parado). Não é erro.
    if (res.status === 304) return res;
    if (!res.ok) {
      const corpo = (await res.text().catch(() => "")).slice(0, 300).trim();
      throw Object.assign(new Error(`docker respondeu ${res.status}${corpo ? `: ${corpo}` : ""}`), {
        statusCode: res.status === 404 ? 404 : 502,
      });
    }
    return res;
  }

  async function estado() {
    if (!habilitado()) return { habilitado: false };
    try {
      const info = await (await chamar("GET", `/containers/${NOME}/json`, 8000)).json();
      const saude = info?.State?.Health;
      return {
        habilitado: true,
        rodando: !!info?.State?.Running,
        status: info?.State?.Status || null,
        desde: info?.State?.StartedAt || null,
        // o healthcheck é o que diz se o servidor SUBIU, não só se o processo existe —
        // é dele que a aplicação de mods sabe se pode confirmar ou precisa reverter
        temSaude: Boolean(saude),
        saude: saude?.Status || null,          // starting | healthy | unhealthy
        falhasSeguidas: saude?.FailingStreak ?? null,
      };
    } catch (err) {
      return { habilitado: true, erro: err.message };
    }
  }

  /**
   * As variáveis de ambiente do contêiner do servidor.
   *
   * Existe por um motivo específico: a imagem `itzg` **reescreve o
   * `server.properties` a cada boot** a partir das variáveis do compose. Quem
   * define `VIEW_DISTANCE` ali e depois muda a distância pelo painel vê a
   * mudança sumir no reinício, sem erro nenhum na tela — o painel gravou certo e
   * a imagem desfez.
   *
   * Ler o ambiente é o que permite avisar antes, em vez de deixar o usuário
   * descobrir sozinho depois de reiniciar. Cache curto: isso não muda sem
   * recriar o contêiner.
   */
  let envCache = { em: 0, valores: null };
  async function ambiente() {
    if (!habilitado()) return null;
    if (envCache.valores && Date.now() - envCache.em < 60_000) return envCache.valores;
    try {
      const info = await (await chamar("GET", `/containers/${NOME}/json`, 8000)).json();
      const valores = {};
      for (const linha of info?.Config?.Env || []) {
        const i = String(linha).indexOf("=");
        if (i > 0) valores[linha.slice(0, i)] = linha.slice(i + 1);
      }
      envCache = { em: Date.now(), valores };
      return valores;
    } catch {
      return null; // sem docker o painel só deixa de avisar; nada quebra
    }
  }

  return {
    habilitado,
    estado,
    ambiente,
    reiniciar: () => chamar("POST", `/containers/${NOME}/restart?t=${espera}`),
    parar: () => chamar("POST", `/containers/${NOME}/stop?t=${espera}`),
    iniciar: () => chamar("POST", `/containers/${NOME}/start`),
  };
}
