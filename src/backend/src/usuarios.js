import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Quem entra no painel e o que cada um pode.
 *
 * Antes daqui existia um usuário só, vindo de `ADMIN_USER`/`ADMIN_PASSWORD`. Esse
 * usuário **continua valendo, sempre**, por dois motivos que não são o mesmo:
 *
 * 1. **Compatibilidade.** Toda instalação existente sobe sem `usuarios.json`, e
 *    tem que continuar entrando igual depois do update.
 * 2. **Chave-mestra.** Esquecer a senha do painel não pode obrigar ninguém a
 *    editar JSON por SSH. Quem tem o `.env` já é dono da máquina — não há
 *    segredo novo sendo exposto, só um caminho de volta garantido.
 *
 * Três papéis, do mais para o menos poderoso:
 *
 *   admin     tudo, inclusive mexer em mods, restaurar mundo e gerir usuários
 *   operador  o dia a dia: chat, kick, ban, whitelist, baixar backup
 *   leitor    só olha
 *
 * **O papel é lido do arquivo a cada requisição, nunca do token.** Se viajasse no
 * JWT, tirar o acesso de alguém só valeria no próximo login — e o token dura 7
 * dias. O custo disso é um `stat` por requisição, com o conteúdo em cache.
 */

const PAPEIS = ["admin", "operador", "leitor"];
const FORCA = { admin: 3, operador: 2, leitor: 1 };

/** O admin embutido, que existe mesmo sem arquivo nenhum. */
const ENV_USER = process.env.ADMIN_USER || "admin";
const ENV_PASSWORD = process.env.ADMIN_PASSWORD || "";

const USER_RE = /^[A-Za-z0-9_.-]{2,32}$/;
const SENHA_MIN = 8;

export const papelValido = (p) => PAPEIS.includes(p);
export const podeMais = (papel, minimo) => (FORCA[papel] || 0) >= (FORCA[minimo] || 99);

/* ---------------- senha ---------------- */

// scrypt é o que o Node traz pronto e é caro de propósito: um vazamento do
// arquivo não vira lista de senhas. Os parâmetros vão junto no hash para que
// aumentar o custo no futuro não invalide o que já está gravado.
const N = 16384, R = 8, P = 1, KEYLEN = 32;
const MAXMEM = 256 * 1024 * 1024; // precisa acompanhar N: o padrão de 32 MB estoura

/**
 * Assíncrono, e não `scryptSync`.
 *
 * Medido nesta máquina: **48 ms por chamada**. O painel é um processo só, que no
 * mesmo laço atende o polling de 2 s de cada aba aberta — cada tentativa de login
 * congelava tudo por 48 ms. Aqui o cálculo sai para a threadpool e o laço segue
 * respondendo.
 */
function derivar(senha, salt, n = N, r = R, p = P) {
  return new Promise((ok, falhou) => {
    crypto.scrypt(String(senha), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, dk) => {
      if (err) falhou(err); else ok(dk);
    });
  });
}

export async function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const dk = await derivar(senha, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${dk.toString("base64")}`;
}

export async function conferirSenha(senha, guardado) {
  try {
    const [alg, n, r, p, salt, dk] = String(guardado).split("$");
    if (alg !== "scrypt") return false;
    const esperado = Buffer.from(dk, "base64");
    const obtido = await derivar(senha, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
    return esperado.length === obtido.length && crypto.timingSafeEqual(esperado, obtido);
  } catch {
    return false;
  }
}

/**
 * Um hash de verdade, de uma senha aleatória que ninguém conhece, para conferir
 * contra quando a conta **não existe**.
 *
 * Sem isto, o login respondia em 0,3 ms para nome inexistente e 48 ms para nome
 * que existe — medido, 160× de diferença. Dava para varrer nomes de usuário sem
 * acertar senha nenhuma. Pagando o mesmo custo nos dois casos, a resposta deixa
 * de contar quem tem conta aqui.
 *
 * Calculado uma vez, na primeira necessidade, e guardado como promessa: duas
 * tentativas simultâneas antes da primeira terminar reaproveitam a mesma conta.
 */
let promessaFantasma = null;
const hashFantasma = () => (promessaFantasma ??= hashSenha(crypto.randomBytes(24).toString("hex")));

/** Compara em tempo constante — o mesmo cuidado que o login do env já tinha. */
function mesmoTexto(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ---------------- arquivo ---------------- */

export function criar({ dados, log }) {
  const PASTA = path.join(dados, "mcpanel");
  const ARQUIVO = path.join(PASTA, "usuarios.json");

  let cache = { mtimeMs: -1, lista: [] };

  /**
   * Lê o arquivo, com cache por mtime.
   *
   * Arquivo ausente, vazio ou corrompido devolve lista vazia **sem lançar**: o
   * painel tem que subir de qualquer jeito, porque o admin do `.env` é a saída de
   * emergência e ela não pode depender deste arquivo estar íntegro.
   */
  function ler() {
    let st;
    try {
      st = fs.statSync(ARQUIVO);
    } catch {
      cache = { mtimeMs: -1, lista: [] };
      return cache.lista;
    }
    if (st.mtimeMs === cache.mtimeMs) return cache.lista;

    let lista = [];
    try {
      const bruto = JSON.parse(fs.readFileSync(ARQUIVO, "utf8"));
      lista = Array.isArray(bruto?.usuarios) ? bruto.usuarios : [];
      lista = lista.filter((u) => u && USER_RE.test(u.user || "") && papelValido(u.papel) && u.hash);
    } catch (err) {
      log?.("warn", `usuarios.json ilegível (${err.message}); só o admin do .env vale até arrumar`);
      lista = [];
    }
    cache = { mtimeMs: st.mtimeMs, lista };
    return lista;
  }

  function gravar(lista) {
    fs.mkdirSync(PASTA, { recursive: true });
    const tmp = `${ARQUIVO}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ usuarios: lista }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, ARQUIVO); // troca atômica: nunca deixa um json pela metade
    cache = { mtimeMs: -1, lista: [] };
  }

  const achar = (user) => ler().find((u) => u.user.toLowerCase() === String(user || "").toLowerCase());

  /**
   * Uma escrita por vez, na ordem de chegada.
   *
   * Enquanto o scrypt era síncrono, `ler()` → hash → `gravar()` corria inteiro
   * sem soltar o laço, e nada podia se intercalar. Com o hash assíncrono existe
   * um `await` no meio dessa sequência: dois pedidos ao mesmo tempo leriam a
   * mesma lista e o segundo `gravar()` apagaria o trabalho do primeiro — criar
   * dois usuários de uma vez deixaria só um.
   *
   * Tornar o hash assíncrono e serializar a escrita são a mesma mudança; separar
   * as duas seria trocar 48 ms de travamento por perda silenciosa de dado.
   *
   * Só as escritas entram aqui. Leitura não precisa de vez, e **nada que já está
   * na fila pode entrar nela de novo** — seria esperar por si mesmo.
   */
  let fila = Promise.resolve();
  function emFila(tarefa) {
    const resultado = fila.then(tarefa);
    // a fila não pode quebrar quando uma tarefa falha: a próxima ainda tem que rodar
    fila = resultado.then(() => {}, () => {});
    return resultado;
  }

  /* ---------------- consulta ---------------- */

  const ehAdminDoEnv = (user) => Boolean(ENV_PASSWORD) && mesmoTexto(user ?? "", ENV_USER);

  /**
   * O papel de quem está autenticado. O admin do `.env` é sempre admin, mesmo que
   * exista um registro homônimo no arquivo — senão bastaria criar um usuário com
   * o nome dele para rebaixá-lo.
   */
  function papelDe(user) {
    if (ehAdminDoEnv(user)) return "admin";
    return achar(user)?.papel || null;
  }

  /**
   * Confere as credenciais. Devolve `{ user, papel }` ou `null`.
   *
   * O scrypt roda **sempre**, exista a conta ou não: contra o hash guardado, ou
   * contra o fantasma. É o que faz o tempo de resposta parar de dizer quem tem
   * conta no painel.
   */
  async function autenticar(user, senha) {
    if (ehAdminDoEnv(user) && mesmoTexto(senha ?? "", ENV_PASSWORD)) {
      return { user: ENV_USER, papel: "admin" };
    }
    const u = achar(user);
    const confere = await conferirSenha(senha ?? "", u?.hash ?? (await hashFantasma()));
    if (u && confere) {
      await emFila(() => marcarAcesso(u.user));
      return { user: u.user, papel: u.papel };
    }
    return null;
  }

  /** Carimba o último acesso; falha aqui nunca impede o login. */
  function marcarAcesso(user) {
    try {
      const lista = ler().map((u) => (u.user === user ? { ...u, ultimoAcesso: new Date().toISOString() } : u));
      gravar(lista);
    } catch { /* disco cheio ou só-leitura: o login continua valendo */ }
  }

  /** Lista para a interface — sem hash, nunca. */
  const listar = () => {
    const doArquivo = ler().map(({ hash, ...resto }) => ({ ...resto, doEnv: false }));
    // o admin do .env não está no arquivo, mas existe e precisa aparecer
    const embutido = ENV_PASSWORD
      ? [{ user: ENV_USER, papel: "admin", doEnv: true, criadoEm: null, ultimoAcesso: null }]
      : [];
    return [...embutido, ...doArquivo];
  };

  /* ---------------- escrita ---------------- */

  const erro = (msg, statusCode = 400) => Object.assign(new Error(msg), { statusCode });

  function validarNome(user) {
    const v = String(user || "").trim();
    if (!USER_RE.test(v)) throw erro("nome de usuário inválido — use 2 a 32 letras, números, ponto, hífen ou _");
    if (ehAdminDoEnv(v)) throw erro("esse nome é o do administrador do .env; escolha outro", 409);
    if (achar(v)) throw erro("já existe um usuário com esse nome", 409);
    return v;
  }

  function validarSenha(senha) {
    const v = String(senha ?? "");
    if (v.length < SENHA_MIN) throw erro(`a senha precisa de pelo menos ${SENHA_MIN} caracteres`);
    return v;
  }

  // As três entram inteiras na fila: a checagem e a gravação que ela autoriza
  // precisam ser um bloco só. Validar fora da fila deixaria a brecha de dois
  // pedidos passarem pela mesma checagem antes de qualquer um gravar.

  const adicionar = ({ user, senha, papel }, porQuem) => emFila(async () => {
    const nome = validarNome(user);
    if (!papelValido(papel)) throw erro("papel inválido");
    const novo = {
      user: nome,
      papel,
      hash: await hashSenha(validarSenha(senha)),
      criadoEm: new Date().toISOString(),
      criadoPor: porQuem || null,
      ultimoAcesso: null,
    };
    gravar([...ler(), novo]);
    return { user: novo.user, papel: novo.papel };
  });

  const alterar = (user, { senha, papel }, porQuem) => emFila(async () => {
    const alvo = achar(user);
    if (!alvo) throw erro("usuário não encontrado", 404);
    if (papel !== undefined && !papelValido(papel)) throw erro("papel inválido");

    // rebaixar a si mesmo é o caminho mais curto para ficar sem nenhum admin
    if (papel && papel !== "admin" && alvo.papel === "admin" && mesmoTexto(alvo.user, porQuem || "")) {
      throw erro("você não pode tirar o próprio acesso de administrador", 409);
    }
    if (papel && papel !== "admin") exigirOutroAdmin(alvo.user);

    const atualizado = {
      ...alvo,
      ...(papel ? { papel } : {}),
      ...(senha !== undefined ? { hash: await hashSenha(validarSenha(senha)) } : {}),
    };
    gravar(ler().map((u) => (u.user === alvo.user ? atualizado : u)));
    return { user: atualizado.user, papel: atualizado.papel };
  });

  const remover = (user, porQuem) => emFila(async () => {
    const alvo = achar(user);
    if (!alvo) throw erro("usuário não encontrado", 404);
    if (mesmoTexto(alvo.user, porQuem || "")) throw erro("você não pode remover a si mesmo", 409);
    if (alvo.papel === "admin") exigirOutroAdmin(alvo.user);
    gravar(ler().filter((u) => u.user !== alvo.user));
    return { user: alvo.user, removido: true };
  });

  /**
   * Impede ficar sem administrador. O admin do `.env` conta como saída de
   * emergência: com ele configurado, ninguém fica trancado para fora nem que o
   * arquivo perca todos os admins.
   */
  function exigirOutroAdmin(exceto) {
    if (ENV_PASSWORD) return;
    const outros = ler().filter((u) => u.papel === "admin" && u.user !== exceto);
    if (!outros.length) throw erro("este é o último administrador — promova outro antes", 409);
  }

  // Calcula o fantasma agora, em segundo plano, para que a primeira tentativa de
  // login contra um nome inexistente já custe o mesmo que as seguintes.
  hashFantasma().catch(() => {});

  return { autenticar, papelDe, listar, adicionar, alterar, remover, ehAdminDoEnv, arquivo: ARQUIVO };
}
