import fs from "node:fs";
import zlib from "node:zlib";

/**
 * Leitura de um arquivo de dentro de um .jar, sem dependência nenhuma.
 *
 * .jar é zip, e o Node já traz `inflateRawSync`. O que falta é achar a entrada, e
 * para isso basta o "central directory": o zip guarda no fim do arquivo um índice
 * (EOCD) que aponta para ele. Assim dá para ler 2 KB de metadados de um jar de
 * 24 MB sem carregar o jar inteiro na memória — o painel tem `mem_limit: 256m` e
 * lê pastas com 57 mods de uma vez, então isso não é preciosismo.
 *
 * Não trata ZIP64 (jar com mais de 65535 entradas ou acima de 4 GB). Nenhum mod do
 * mundo real chega perto; se chegar, `lerEntradas` devolve null e o chamador degrada.
 */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const MAX_COMENTARIO = 66000; // 64 KB de comentário + os 22 bytes do EOCD

/** Lê `tamanho` bytes a partir de `pos`. Devolve o que conseguiu. */
function ler(fd, pos, tamanho) {
  const buf = Buffer.alloc(tamanho);
  const lidos = fs.readSync(fd, buf, 0, tamanho, pos);
  return lidos === tamanho ? buf : buf.subarray(0, lidos);
}

/**
 * Índice do jar: nome da entrada -> { offset, metodo, tamComprimido, tamCru }.
 * Devolve null se o arquivo não for um zip legível.
 */
function lerIndice(fd, tamanhoArquivo) {
  const cauda = Math.min(MAX_COMENTARIO, tamanhoArquivo);
  const fim = ler(fd, tamanhoArquivo - cauda, cauda);

  let eocd = -1;
  for (let i = fim.length - 22; i >= 0; i--) {
    if (fim.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const total = fim.readUInt16LE(eocd + 10);
  const tamCen = fim.readUInt32LE(eocd + 12);
  const offCen = fim.readUInt32LE(eocd + 16);
  if (total === 0xffff || offCen === 0xffffffff) return null; // ZIP64, fora do escopo

  const cen = ler(fd, offCen, tamCen);
  const indice = new Map();
  let p = 0;
  for (let i = 0; i < total && p + 46 <= cen.length; i++) {
    if (cen.readUInt32LE(p) !== CEN_SIG) break;
    const metodo = cen.readUInt16LE(p + 10);
    const tamComprimido = cen.readUInt32LE(p + 20);
    const tamCru = cen.readUInt32LE(p + 24);
    const nl = cen.readUInt16LE(p + 28);
    const el = cen.readUInt16LE(p + 30);
    const cl = cen.readUInt16LE(p + 32);
    const offset = cen.readUInt32LE(p + 42);
    indice.set(cen.toString("utf8", p + 46, p + 46 + nl), { offset, metodo, tamComprimido, tamCru });
    p += 46 + nl + el + cl;
  }
  return indice;
}

const TETO_ENTRADA = 4 * 1024 * 1024; // metadados de mod não passam de alguns KB

/**
 * Abre o jar uma vez e extrai as entradas pedidas.
 * @param {string} arquivo caminho do .jar
 * @param {string[]} alvos nomes exatos dentro do zip
 * @returns {Map<string,string>} só as que existiam, já em texto utf8
 */
export function lerEntradas(arquivo, alvos) {
  const achados = new Map();
  let fd;
  try {
    fd = fs.openSync(arquivo, "r");
    const { size } = fs.fstatSync(fd);
    if (size < 22) return achados;

    const indice = lerIndice(fd, size);
    if (!indice) return achados;

    for (const alvo of alvos) {
      const e = indice.get(alvo);
      if (!e || e.tamCru > TETO_ENTRADA) continue;
      // o cabeçalho local repete nome e extra com tamanhos próprios: só ele diz
      // onde os dados começam de verdade
      const local = ler(fd, e.offset, 30);
      if (local.length < 30) continue;
      const inicio = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const dados = ler(fd, inicio, e.tamComprimido);
      const cru = e.metodo === 0 ? dados : zlib.inflateRawSync(dados);
      achados.set(alvo, cru.toString("utf8"));
    }
  } catch {
    /* jar corrompido ou ilegível: devolve o que deu, quem chamou decide */
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignora */ }
  }
  return achados;
}
