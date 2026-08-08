import fs from "node:fs";
import path from "node:path";

import { erro400, erro404, erroHttp } from "./erros.js";
import { chaveDia, dois, proximaOcorrencia, validarHora, validarDias, atrasadaDemais, TOLERANCIA_MS } from "./quando.js";

/**
 * Backup automático do mundo, com rotação.
 *
 * O calendário vem do `quando.js` — o mesmo do reinício agendado, inclusive a
 * regra de nunca correr atrás de horário perdido. O que é próprio daqui é a
 * ordem das operações, e é ela que torna isto seguro de deixar rodando sozinho:
 *
 * 1. **Confere o espaço antes de começar.** Estimativa = tamanho do último
 *    backup + 30% de margem. Não coube, pula a rodada e avisa — nunca enche o
 *    disco às cegas, porque disco cheio derruba o servidor junto.
 * 2. **Grava em `.part` e só então renomeia** (é o `backup.paraArquivo`).
 * 3. **Só apaga as cópias velhas depois de a nova estar pronta.** Ao contrário,
 *    um backup que falhasse deixaria você com uma cópia a menos e nada no lugar.
 *
 * A rotação só enxerga arquivos no padrão `Mundo-DDMMAA.tar.gz`. Backup manual
 * com outro nome — `world-pre-otimizacao-20260804.tar.gz`, por exemplo — fica
 * onde está para sempre. Isso é de propósito: o painel não apaga o que não criou.
 */

const INTERVALO_MS = 20_000;
const MARGEM = 1.3;          // sobra sobre o tamanho estimado do pacote
const RESERVA_BYTES = 512 * 1024 * 1024; // nunca deixa o disco abaixo disto

const PADRAO = {
  ativo: false,
  hora: "04:00",
  dias: [0, 1, 2, 3, 4, 5, 6],
  manter: 7,
};

/** `Mundo-070826.tar.gz` — o dia no nome, para saber o que é sem abrir. */
const NOME_RE = /^Mundo-(\d{2})(\d{2})(\d{2})\.tar\.gz$/;

export const nomeDoDia = (d = new Date()) =>
  `Mundo-${dois(d.getDate())}${dois(d.getMonth() + 1)}${dois(d.getFullYear() % 100)}.tar.gz`;

/** Data que está no nome do arquivo, para ordenar sem depender do mtime. */
function dataDoNome(nome) {
  const m = NOME_RE.exec(nome);
  if (!m) return null;
  const [, dd, mm, aa] = m.map(Number);
  const d = new Date(2000 + aa, mm - 1, dd);
  return Number.isNaN(d.getTime()) ? null : d;
}

function validar(bruto) {
  const cfg = { ...PADRAO };
  if (typeof bruto?.ativo === "boolean") cfg.ativo = bruto.ativo;
  cfg.hora = validarHora(bruto?.hora, cfg.hora);
  cfg.dias = validarDias(bruto?.dias, cfg.dias);
  if (bruto?.manter !== undefined) {
    const n = Number(bruto.manter);
    if (!Number.isInteger(n) || n < 1 || n > 30) throw erro400("guarde entre 1 e 30 cópias");
    cfg.manter = n;
  }
  return cfg;
}

export function criar({ dados, destino, backup, restore, run, log, estadoServidor }) {
  const PASTA = path.join(dados, "mcpanel");
  const ARQUIVO = path.join(PASTA, "backup-auto.json");

  let cfg = { ...PADRAO };
  let ultimo = null;   // { em, arquivo, bytes, ok, erro }
  let alvo = null;
  let adiadoAte = 0;
  let rodando = false;

  /* ---------------- persistência ---------------- */

  function carregar() {
    try {
      const bruto = JSON.parse(fs.readFileSync(ARQUIVO, "utf8"));
      cfg = validar(bruto);
      ultimo = bruto.ultimo ?? null;
    } catch { /* sem arquivo ainda: fica no padrão */ }
    recalcular();
  }

  function salvar() {
    try {
      fs.mkdirSync(PASTA, { recursive: true });
      const tmp = `${ARQUIVO}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...cfg, ultimo }, null, 2));
      fs.renameSync(tmp, ARQUIVO); // troca atômica: nunca deixa um json pela metade
    } catch (err) {
      log?.("err", `não consegui gravar a configuração de backup: ${err.message}`);
      throw erroHttp(500, `não consegui gravar a configuração: ${err.message}`);
    }
  }

  const recalcular = () => { alvo = proximaOcorrencia(cfg, new Date()); adiadoAte = 0; };

  /* ---------------- a pasta ---------------- */

  const disponivel = () => {
    if (!destino) return false;
    try { fs.mkdirSync(destino, { recursive: true }); fs.accessSync(destino, fs.constants.W_OK); return true; }
    catch { return false; }
  };

  /** As cópias que este módulo criou, da mais nova para a mais velha. */
  function copias() {
    let nomes = [];
    try { nomes = fs.readdirSync(destino); } catch { return []; }
    return nomes
      .filter((n) => NOME_RE.test(n))
      .map((nome) => {
        let st = null;
        try { st = fs.statSync(path.join(destino, nome)); } catch { /* sumiu no meio */ }
        return st && { nome, bytes: st.size, em: dataDoNome(nome)?.toISOString() ?? st.mtime.toISOString() };
      })
      .filter(Boolean)
      // pela data do NOME, não pelo mtime: copiar a pasta ou restaurar um backup
      // mexe no mtime e faria a rotação apagar o arquivo errado
      .sort((a, b) => dataDoNome(b.nome) - dataDoNome(a.nome));
  }

  /** Tudo que está na pasta, inclusive backup manual que o painel não gerencia. */
  function listar() {
    let nomes = [];
    try { nomes = fs.readdirSync(destino); } catch { return []; }
    return nomes
      .filter((n) => n.endsWith(".tar.gz"))
      .map((nome) => {
        let st = null;
        try { st = fs.statSync(path.join(destino, nome)); } catch { /* sumiu no meio */ }
        return st && { nome, bytes: st.size, em: st.mtime.toISOString(), automatico: NOME_RE.test(nome) };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.em) - new Date(a.em));
  }

  function livreEmDisco() {
    try {
      const s = fs.statfsSync(destino);
      return s.bavail * s.bsize;
    } catch { return null; }
  }

  /**
   * Cabe mais um? Estima pelo maior backup que já foi feito; sem histórico, cai
   * para metade do mundo cru (num mundo real de 1,2 GB o tar.gz deu ~45%).
   */
  async function cabe() {
    const livre = livreEmDisco();
    if (livre === null) return { ok: true }; // sem statfs, não dá para julgar

    const anteriores = copias().map((c) => c.bytes);
    const estimado = anteriores.length
      ? Math.max(...anteriores)
      : Math.round((await backup.size().catch(() => null)) * 0.5) || 0;

    const preciso = Math.round(estimado * MARGEM) + RESERVA_BYTES;
    if (livre >= preciso) return { ok: true, livre, preciso };
    return { ok: false, livre, preciso, estimado };
  }

  /** Mantém as `manter` mais recentes; devolve o que apagou. */
  function girar() {
    const velhas = copias().slice(cfg.manter);
    const apagadas = [];
    for (const c of velhas) {
      try { fs.unlinkSync(path.join(destino, c.nome)); apagadas.push(c.nome); }
      catch (err) { log?.("warn", `não consegui apagar ${c.nome}: ${err.message}`); }
    }
    return apagadas;
  }

  /* ---------------- executar ---------------- */

  async function executar() {
    if (!disponivel()) {
      log?.("err", "backup automático cancelado: a pasta de backups não existe ou não é gravável");
      ultimo = { em: new Date().toISOString(), ok: false, erro: "pasta de backups indisponível" };
      salvar();
      return true; // não adianta tentar de novo em 5 min; é problema de configuração
    }
    if (backup.isBusy() || restore?.ocupado()) {
      adiadoAte = Date.now() + TOLERANCIA_MS;
      log?.("warn", "backup automático adiado 5 min: há um backup ou restauração em andamento");
      return false;
    }

    const espaco = await cabe();
    if (!espaco.ok) {
      const mb = (n) => `${Math.round(n / 1048576)} MB`;
      const msg = `espaço insuficiente: ${mb(espaco.livre)} livres, precisaria de ~${mb(espaco.preciso)}`;
      log?.("err", `backup automático pulado — ${msg}`);
      ultimo = { em: new Date().toISOString(), ok: false, erro: msg };
      salvar();
      return true; // pula a rodada; girar antes de gravar arriscaria ficar sem nada
    }

    const nome = nomeDoDia();
    rodando = true;
    log?.("info", `backup automático: gerando ${nome}`);
    const começo = Date.now();
    try {
      const r = await backup.paraArquivo(run, path.join(destino, nome));
      const seg = Math.round((Date.now() - começo) / 1000);
      const apagadas = girar();
      ultimo = { em: new Date().toISOString(), ok: true, arquivo: r.arquivo, bytes: r.bytes, segundos: seg };
      log?.("info", `backup automático pronto: ${r.arquivo}, ${Math.round(r.bytes / 1048576)} MB em ${seg}s`
        + (apagadas.length ? ` — ${apagadas.length} cópia(s) antiga(s) descartada(s)` : ""));
    } catch (err) {
      ultimo = { em: new Date().toISOString(), ok: false, erro: err.message };
      log?.("err", `backup automático falhou: ${err.message}`);
    } finally {
      rodando = false;
      salvar();
    }
    return true;
  }

  async function tique() {
    if (!cfg.ativo) { alvo = null; return; }
    if (!alvo) { recalcular(); return; }
    if (alvo.getTime() > Date.now()) return;
    if (adiadoAte && Date.now() < adiadoAte) return;

    // atrasou demais (painel fora do ar): a ocorrência passa em branco
    if (atrasadaDemais(alvo) && !adiadoAte) {
      log?.("warn", `backup automático de ${alvo.toLocaleString("pt-BR")} não aconteceu (painel fora do ar) — pulando`);
      recalcular();
      return;
    }

    const resolvido = await executar();
    if (resolvido) recalcular();
  }

  /* ---------------- interface ---------------- */

  function status() {
    const lista = copias();
    return {
      ...cfg,
      disponivel: disponivel(),
      rodando,
      ultimo,
      proximoEm: alvo ? alvo.toISOString() : null,
      guardadas: lista.length,
      ocupado: lista.reduce((s, c) => s + c.bytes, 0),
      livreEmDisco: livreEmDisco(),
      hojeJaTem: lista.some((c) => c.nome === nomeDoDia()),
    };
  }

  function definir(bruto) {
    cfg = validar({ ...cfg, ...bruto });
    salvar();
    recalcular();
    return status();
  }

  /** Roda agora, fora do horário — o botão "fazer agora" da interface. */
  async function agora() {
    if (rodando) throw erroHttp(409, "já existe um backup automático em andamento");
    await executar();
    return status();
  }

  function apagar(nome) {
    if (!NOME_RE.test(String(nome))) throw erro400("só dá para apagar backup gerado pelo painel");
    const alvoArq = path.join(destino, nome);
    // o regex acima já não deixa passar barra nem "..", mas o caminho resolvido
    // ainda é conferido contra a pasta: validação de nome e de caminho são coisas
    // diferentes, e é barato ter as duas
    if (path.resolve(alvoArq) !== path.join(path.resolve(destino), nome)) throw erro400("nome inválido");
    if (!fs.existsSync(alvoArq)) throw erro404(`${nome} não está na pasta`);
    fs.unlinkSync(alvoArq);
    log?.("warn", `backup removido: ${nome}`);
    return { nome, removido: true };
  }

  /** Caminho de um arquivo para download, já validado. */
  function caminho(nome) {
    const n = String(nome ?? "");
    if (!n.endsWith(".tar.gz") || n.includes("/") || n.includes("\\") || n.includes("\0")) {
      throw erro400("nome inválido");
    }
    const cheio = path.join(destino, n);
    if (path.resolve(cheio) !== path.join(path.resolve(destino), n)) throw erro400("nome inválido");
    if (!fs.existsSync(cheio)) throw erro404(`${n} não está na pasta`);
    return cheio;
  }

  carregar();
  setInterval(() => { tique().catch((err) => log?.("err", `backup automático: ${err.message}`)); }, INTERVALO_MS).unref();

  return { status, definir, agora, listar, apagar, caminho };
}
