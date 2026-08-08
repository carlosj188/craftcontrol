import { erro400 } from "./erros.js";

/**
 * Calendário de tarefa recorrente: "às HH:MM, nestes dias da semana".
 *
 * Mora fora de quem agenda porque a parte sutil não é o laço, é decidir *qual* é a
 * próxima ocorrência e o que fazer com a que passou. Duas regras que valem para
 * qualquer tarefa e que dão bug silencioso quando reescritas:
 *
 * - **Nunca correr atrás de horário perdido.** Painel fora do ar na hora marcada?
 *   Aquela ocorrência passa em branco. Reiniciar o servidor de surpresa três horas
 *   depois é pior do que pular um dia.
 * - **Ocorrência é sempre no futuro.** `proximaOcorrencia` só devolve horário à
 *   frente de `desde`, então ligar a agenda 2 min antes da hora não faz a tarefa
 *   disparar imediatamente nem anunciar aviso de uma janela que já passou.
 *
 * Usado pela agenda de reinício (`agenda.js`) e pelo backup automático
 * (`backupauto.js`).
 */

export const dois = (n) => String(n).padStart(2, "0");

/** Chave AAAA-MM-DD no fuso local — identifica "o dia" de uma ocorrência. */
export const chaveDia = (d) => `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;

/** Quanto tempo depois da hora ainda vale executar; passou disso, pula. */
export const TOLERANCIA_MS = 5 * 60_000;

const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validarHora(valor, padrao) {
  if (valor === undefined) return padrao;
  if (typeof valor === "string" && HORA_RE.test(valor)) return valor;
  throw erro400("horário inválido — use HH:MM");
}

export function validarDias(valor, padrao) {
  if (!Array.isArray(valor)) return padrao;
  const dias = [...new Set(valor.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  if (!dias.length) throw erro400("escolha pelo menos um dia da semana");
  return dias;
}

/**
 * A próxima ocorrência depois de `desde`, ou null se a tarefa está desligada.
 *
 * @param cfg   { ativo, hora "HH:MM", dias [0..6] }  (0 = domingo)
 * @param desde a partir de quando procurar
 * @param pular chave de dia (AAAA-MM-DD) cancelada à mão; opcional
 */
export function proximaOcorrencia(cfg, desde = new Date(), pular = null) {
  if (!cfg?.ativo) return null;
  const [h, m] = String(cfg.hora).split(":").map(Number);
  // 8 dias cobre qualquer combinação de dias da semana, inclusive um dia só
  for (let i = 0; i <= 8; i++) {
    const d = new Date(desde);
    d.setDate(d.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (d <= desde) continue;
    if (!cfg.dias.includes(d.getDay())) continue;
    if (pular && pular === chaveDia(d)) continue;
    return d;
  }
  return null;
}

/** Atrasou tanto que não vale mais executar (painel fora do ar, máquina suspensa). */
export const atrasadaDemais = (alvo, agora = Date.now()) => alvo.getTime() - agora < -TOLERANCIA_MS;
