/**
 * Erro com status HTTP, do jeito que o setErrorHandler do server.js espera.
 * Um construtor só para o projeto inteiro — antes eram três dialetos (classe,
 * arrows locais e `Object.assign` inline) inventando a mesma coisa.
 */
export const erroHttp = (status, msg, extra = {}) =>
  Object.assign(new Error(msg), { statusCode: status, ...extra });

export const erro400 = (msg) => erroHttp(400, msg);
export const erro404 = (msg) => erroHttp(404, msg);
export const erro409 = (msg) => erroHttp(409, msg);
export const erro422 = (msg, extra) => erroHttp(422, msg, extra);
export const erro429 = (msg) => erroHttp(429, msg);
