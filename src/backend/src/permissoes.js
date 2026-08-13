/**
 * Quem pode o quê, e como cada ação aparece no histórico.
 *
 * Uma tabela só, em vez de marcar as ~45 rotas uma a uma. Política espalhada por
 * handler é política que se esquece de aplicar na rota nova; aqui, quem esquecer
 * de cadastrar cai no padrão — e **o padrão é `admin`**, o lado seguro.
 *
 * A mesma linha serve às duas perguntas do painel:
 *
 *   - qual o papel mínimo (usado no `onRequest`, antes do handler)
 *   - como isso vira frase no histórico (usado no `onResponse`, depois)
 *
 * Manter as duas juntas é o que garante que ação registrável e ação protegida
 * sejam o mesmo conjunto.
 *
 * Onde a linha foi traçada, e por quê:
 *
 * - **`/command` é admin, não operador.** Ele manda RCON livre: um operador com
 *   essa rota daria `op` em si mesmo e todo o resto viraria enfeite. Operador tem
 *   os botões (kick, ban, whitelist, chat), não o console.
 * - **`/power/*` é admin.** Desligar o servidor não é o dia a dia.
 * - **Mods e restauração são admin.** São as duas coisas que podem derrubar o
 *   mundo de todo mundo.
 */

/** Só o caminho, sem query — a regra não pode depender do que vem depois do `?`. */
const semQuery = (url) => String(url).split("?")[0];

const S = "/api/servers/[^/]+"; // prefixo de tudo que é de um servidor

/** `alvo` curto e sempre string; nunca o corpo cru, que carrega senha e jar. */
const txt = (v, max = 80) => (v == null ? null : String(v).slice(0, max));

/**
 * A tabela. Ordem importa: a primeira que casar vence, então o específico vem
 * antes do genérico.
 */
const REGRAS = [
  // ---- leitura que não é para qualquer um ----
  // saber quem tem acesso, e o rastro do que cada um fez, é assunto de quem
  // administra. `acao: null` deixa fora do histórico: é leitura, não mudança.
  { m: "GET", re: `^/api/usuarios$`, papel: "admin", acao: null, resumo: null },
  { m: "GET", re: `^/api/eventos$`, papel: "admin", acao: null, resumo: null },

  // ---- usuários (fora do prefixo de servidor: usuário é do painel) ----
  { m: "POST", re: `^/api/usuarios$`, papel: "admin", acao: "usuario.criar",
    resumo: (r) => `criou o usuário ${txt(r.body?.user)} como ${txt(r.body?.papel)}` },
  { m: "PUT", re: `^/api/usuarios/([^/]+)$`, papel: "admin", acao: "usuario.alterar",
    resumo: (r, m) => {
      const o = [];
      if (r.body?.papel) o.push(`papel para ${txt(r.body.papel)}`);
      if (r.body?.senha !== undefined) o.push("senha");
      return `alterou ${o.join(" e ") || "nada"} de ${decodeURIComponent(m[1])}`;
    } },
  { m: "DELETE", re: `^/api/usuarios/([^/]+)$`, papel: "admin", acao: "usuario.remover",
    resumo: (r, m) => `removeu o usuário ${decodeURIComponent(m[1])}` },

  // ---- mods ----
  { m: "POST", re: `^${S}/mods/estado$`, papel: "admin", acao: "mods.estado",
    resumo: (r) => `${r.body?.ativo ? "ativou" : "desativou"} ${txt(r.body?.arquivo)}` },
  { m: "POST", re: `^${S}/mods/remover$`, papel: "admin", acao: "mods.remover",
    resumo: (r) => `removeu ${txt(r.body?.arquivo)}` },
  { m: "POST", re: `^${S}/mods/instalar$`, papel: "admin", acao: "mods.instalar",
    resumo: (r) => `instalou ${txt(r.body?.projeto)}` },
  { m: "POST", re: `^${S}/mods/atualizar-todos$`, papel: "admin", acao: "mods.atualizarTodos",
    resumo: () => "atualizou todos os mods com versão nova" },
  { m: "POST", re: `^${S}/mods/atualizar$`, papel: "admin", acao: "mods.atualizar",
    resumo: (r) => `atualizou ${txt(r.body?.arquivo)}` },
  { m: "POST", re: `^${S}/mods/aplicar$`, papel: "admin", acao: "mods.aplicar",
    resumo: () => "aplicou as mudanças e reiniciou o servidor" },
  // o corpo aqui é o .jar cru: só a query pode ser lida
  { m: "PUT", re: `^${S}/mods/arquivo$`, papel: "admin", acao: "mods.enviar",
    resumo: (r) => `enviou o arquivo ${txt(r.query?.nome)}` },

  // ---- mundo ----
  { m: "PUT", re: `^${S}/restore/world$`, papel: "admin", acao: "mundo.restaurar",
    resumo: () => "restaurou o mundo a partir de um backup" },
  { m: "DELETE", re: `^${S}/restore/preserved/([^/]+)$`, papel: "admin", acao: "mundo.descartar",
    resumo: (r, m) => `descartou o mundo preservado ${decodeURIComponent(m[1])}` },

  // ---- backup ----
  /**
   * O pedido diz como a configuração **fica**, não o que ela era antes: salvar
   * uma agenda já ligada manda `ativo: true` igual a ligar do zero, e salvar só
   * a quantidade de cópias não manda `ativo` nenhum.
   *
   * Por isso o resumo descreve o estado resultante e nunca uma transição que ele
   * não tem como conferir. Antes, mudar a hora de um backup já ligado gravava
   * "ligou o backup automático" — uma frase que afirma algo que não aconteceu, e
   * histórico que afirma o que não houve não serve para nada.
   */
  { m: "PUT", re: `^${S}/backup/auto$`, papel: "admin", acao: "backup.auto",
    resumo: (r) => {
      const b = r.body ?? {};
      if (b.ativo === false) return "desligou o backup automático";
      const det = [
        b.hora ? `às ${txt(b.hora, 5)}` : null,
        b.manter ? `guardando ${Number(b.manter)}` : null,
      ].filter(Boolean).join(", ");
      const alvo = `backup automático${det ? ` (${det})` : ""}`;
      return b.ativo === true ? `deixou o ${alvo} ligado` : `mudou a configuração do ${alvo}`;
    } },
  { m: "POST", re: `^${S}/backup/auto/agora$`, papel: "admin", acao: "backup.agora",
    resumo: () => "disparou um backup na hora" },
  { m: "DELETE", re: `^${S}/backup/arquivos/([^/]+)$`, papel: "admin", acao: "backup.apagar",
    resumo: (r, m) => `apagou o backup ${decodeURIComponent(m[1])}` },
  // baixar é rotina de operação, não de administração
  { m: "POST", re: `^${S}/backup/arquivos/([^/]+)/ticket$`, papel: "operador", acao: "backup.baixar",
    resumo: (r, m) => `baixou o backup ${decodeURIComponent(m[1])}` },
  { m: "POST", re: `^${S}/backup/ticket$`, papel: "operador", acao: "backup.baixar",
    resumo: () => "baixou um backup do mundo" },

  // ---- distâncias: mexem no desempenho de todo mundo, e exigem reinício ----
  { m: "PUT", re: `^${S}/distancias$`, papel: "admin", acao: "distancias",
    resumo: (r) => {
      const b = r.body ?? {};
      const p = [
        b["view-distance"] !== undefined ? `visão ${Number(b["view-distance"])}` : null,
        b["simulation-distance"] !== undefined ? `simulação ${Number(b["simulation-distance"])}` : null,
      ].filter(Boolean).join(" e ");
      return `mudou a distância de ${p} (vale no próximo reinício)`;
    } },

  // ---- energia e agenda ----
  { m: "POST", re: `^${S}/power/([^/]+)$`, papel: "admin", acao: "power",
    resumo: (r, m) => `mandou ${decodeURIComponent(m[1])} no servidor` },
  // mesma regra do backup automático acima: estado resultante, nunca transição
  { m: "PUT", re: `^${S}/agenda$`, papel: "admin", acao: "agenda.definir",
    resumo: (r) => {
      const b = r.body ?? {};
      if (b.ativo === false) return "desligou o reinício agendado";
      const alvo = `reinício agendado${b.hora ? ` das ${txt(b.hora, 5)}` : ""}`;
      return b.ativo === true ? `deixou o ${alvo} ligado` : `mudou a configuração do ${alvo}`;
    } },
  { m: "POST", re: `^${S}/agenda/pular$`, papel: "admin", acao: "agenda.pular",
    resumo: () => "pulou o próximo reinício agendado" },

  // ---- console: RCON livre, por isso admin ----
  { m: "POST", re: `^${S}/command$`, papel: "admin", acao: "comando",
    resumo: (r) => `executou: ${txt(r.body?.command, 120)}` },

  // ---- moderação e chat: o dia a dia do operador ----
  { m: "POST", re: `^${S}/players/([^/]+)/kick$`, papel: "operador", acao: "kick",
    resumo: (r, m) => `expulsou ${decodeURIComponent(m[1])}` },
  { m: "POST", re: `^${S}/bans$`, papel: "operador", acao: "ban",
    resumo: (r) => `baniu ${txt(r.body?.nick)}` },
  { m: "DELETE", re: `^${S}/bans/([^/]+)$`, papel: "operador", acao: "desbanir",
    resumo: (r, m) => `perdoou ${decodeURIComponent(m[1])}` },
  { m: "POST", re: `^${S}/whitelist/toggle$`, papel: "operador", acao: "whitelist.toggle",
    resumo: (r) => `${r.body?.on ? "ligou" : "desligou"} a whitelist` },
  { m: "POST", re: `^${S}/whitelist$`, papel: "operador", acao: "whitelist.add",
    resumo: (r) => `pôs ${txt(r.body?.nick)} na whitelist` },
  { m: "DELETE", re: `^${S}/whitelist/([^/]+)$`, papel: "operador", acao: "whitelist.rm",
    resumo: (r, m) => `tirou ${decodeURIComponent(m[1])} da whitelist` },
  // `message`, e não `text`: é o nome que o painel manda e que a rota lê. Com o
  // campo errado, toda mensagem entrava no histórico como "falou no chat: null"
  // — a ação ficava registrada e o conteúdo dela se perdia.
  { m: "POST", re: `^${S}/chat/broadcast$`, papel: "operador", acao: "chat",
    resumo: (r) => `falou no chat: ${txt(r.body?.message, 120)}` },
  { m: "POST", re: `^${S}/chat/private$`, papel: "operador", acao: "chat.privado",
    resumo: (r) => `mandou para ${txt(r.body?.nick)}: ${txt(r.body?.message, 120)}` },
].map((x) => ({ ...x, re: new RegExp(x.re) }));

/**
 * O que esta requisição exige e como ela se descreve.
 *
 * `GET` é leitura e vale para qualquer papel — quem entrou no painel pode ver o
 * painel. Escrita sem regra cadastrada cai em `admin`: rota nova nasce fechada,
 * e é melhor um admin reclamar de 403 do que um leitor apagar um mundo.
 */
export function regraDe(metodo, url) {
  const caminho = semQuery(url);
  for (const r of REGRAS) {
    if (r.m !== metodo) continue;
    const m = r.re.exec(caminho);
    if (m) return { ...r, m };
  }
  if (metodo === "GET") return { papel: "leitor", acao: null, resumo: null, m: null };
  return { papel: "admin", acao: "outro", resumo: () => `${metodo} ${caminho}`, m: null };
}

/** O id do servidor que aparece na URL, para o evento dizer onde foi. */
export function servidorDaUrl(url) {
  const m = /^\/api\/servers\/([^/?]+)/.exec(semQuery(url));
  return m ? decodeURIComponent(m[1]) : null;
}
