import fs from "node:fs";
import path from "node:path";

import { erro400, erroHttp } from "./erros.js";
import { chaveDia, proximaOcorrencia, validarHora, validarDias, atrasadaDemais, TOLERANCIA_MS } from "./quando.js";

/**
 * Reinício automático.
 *
 * Guarda a configuração em `<dados>/mcpanel/agenda.json`: o contêiner do painel roda
 * com `read_only: true`, então o volume de dados do servidor é o único lugar gravável
 * e permanente — e como é um por servidor, cada um tem a sua agenda de graça. O backup
 * e a restauração só mexem em `world/`, então o arquivo sobrevive a uma restauração.
 *
 * O laço confere a cada 20s. Ele nunca "corre atrás" de um horário perdido: se o painel
 * estava fora do ar na hora marcada, aquela ocorrência simplesmente passa — reiniciar
 * o servidor de surpresa fora de hora é pior do que pular um dia.
 */

const INTERVALO_MS = 20_000;
const ADIAR_MS = TOLERANCIA_MS; // backup ou restauração em andamento: tenta de novo depois

const PADRAO = {
  ativo: false,
  hora: "05:00",
  dias: [0, 1, 2, 3, 4, 5, 6], // 0 = domingo
  avisosMin: [15, 5, 1],
  pularSeTiverGente: false,
};

function validar(bruto) {
  const cfg = { ...PADRAO };
  if (typeof bruto?.ativo === "boolean") cfg.ativo = bruto.ativo;
  if (typeof bruto?.pularSeTiverGente === "boolean") cfg.pularSeTiverGente = bruto.pularSeTiverGente;
  cfg.hora = validarHora(bruto?.hora, cfg.hora);
  cfg.dias = validarDias(bruto?.dias, cfg.dias);

  if (Array.isArray(bruto?.avisosMin)) {
    cfg.avisosMin = [...new Set(bruto.avisosMin.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 60))]
      .sort((a, b) => b - a)
      .slice(0, 6);
  }
  return cfg;
}

export function criar({ dados, docker, run, log, estadoServidor, backup, restore }) {
  const PASTA = path.join(dados, "mcpanel");
  const ARQUIVO = path.join(PASTA, "agenda.json");

  let cfg = { ...PADRAO };
  let ultimoEm = null;   // ISO do último reinício de fato executado
  let puladoEm = null;   // dia (AAAA-MM-DD) cancelado à mão pelo painel
  let alvo = null;       // Date da próxima ocorrência
  let avisados = new Set();
  let adiadoAte = 0;

  /* ---------------- persistência ---------------- */

  function carregar() {
    try {
      const bruto = JSON.parse(fs.readFileSync(ARQUIVO, "utf8"));
      cfg = validar(bruto);
      ultimoEm = typeof bruto.ultimoEm === "string" ? bruto.ultimoEm : null;
      puladoEm = typeof bruto.puladoEm === "string" ? bruto.puladoEm : null;
    } catch { /* sem arquivo ainda: fica no padrão */ }
    recalcular();
  }

  function salvar() {
    try {
      fs.mkdirSync(PASTA, { recursive: true });
      const tmp = `${ARQUIVO}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...cfg, ultimoEm, puladoEm }, null, 2));
      fs.renameSync(tmp, ARQUIVO); // troca atômica: nunca deixa um json pela metade
    } catch (err) {
      log?.("err", `não consegui gravar a agenda: ${err.message}`);
      throw erroHttp(500, `não consegui gravar a agenda: ${err.message}`);
    }
  }

  /* ---------------- quando é a próxima ---------------- */

  function recalcular() {
    alvo = proximaOcorrencia(cfg, new Date(), puladoEm);
    // avisos cuja janela já passou entram como "dados": ligar a agenda 2 min antes do
    // horário não pode fazer o chat anunciar "reinício em 15 minutos" na mesma hora
    avisados = new Set(alvo ? cfg.avisosMin.filter((min) => alvo.getTime() - Date.now() <= min * 60_000) : []);
    adiadoAte = 0;
  }

  /* ---------------- o laço ---------------- */

  async function executar() {
    const gente = estadoServidor()?.count || 0;

    if (cfg.pularSeTiverGente && gente > 0) {
      log?.("info", `reinício automático pulado: ${gente} jogador(es) online`);
      return true; // ocorrência resolvida, segue para a próxima
    }
    if (backup?.isBusy() || restore?.ocupado()) {
      adiadoAte = Date.now() + ADIAR_MS;
      log?.("warn", "reinício automático adiado 5 min: há um backup ou restauração em andamento");
      return false; // mantém o alvo, tenta de novo
    }

    log?.("cmd", "reinício automático");
    await run("say [painel] reiniciando o servidor agora — voltamos em instantes").catch(() => {});
    await run("save-all flush").catch(() => {});
    try {
      await docker.reiniciar();
      ultimoEm = new Date().toISOString();
      salvar();
      log?.("info", "reinício automático concluído");
    } catch (err) {
      log?.("err", `reinício automático falhou: ${err.message}`);
    }
    return true;
  }

  async function tique() {
    if (!cfg.ativo) { alvo = null; return; }
    if (!alvo) { recalcular(); return; }

    const faltam = alvo.getTime() - Date.now();

    if (faltam > 0) {
      // avisa no chat nos minutos configurados (uma vez cada)
      for (const min of cfg.avisosMin) {
        if (avisados.has(min)) continue;
        if (faltam > min * 60_000) continue;
        avisados.add(min);
        if (docker.habilitado() && estadoServidor()?.online) {
          const quanto = min === 1 ? "1 minuto" : `${min} minutos`;
          await run(`say [painel] reinício automático em ${quanto}`).catch(() => {});
        }
      }
      return;
    }

    if (adiadoAte && Date.now() < adiadoAte) return;

    // atrasou demais (painel fora do ar, máquina suspensa): não reinicia fora de hora
    if (atrasadaDemais(alvo) && !adiadoAte) {
      log?.("warn", `reinício automático de ${alvo.toLocaleString("pt-BR")} não aconteceu (painel fora do ar) — pulando`);
      recalcular();
      return;
    }

    if (!docker.habilitado()) {
      log?.("err", "reinício automático cancelado: o controle do contêiner não está configurado");
      recalcular();
      return;
    }

    const resolvido = await executar();
    if (resolvido) recalcular();
  }

  /* ---------------- interface ---------------- */

  function status() {
    return {
      ...cfg,
      ultimoEm,
      proximoEm: alvo ? alvo.toISOString() : null,
      puladoHoje: !!(puladoEm && puladoEm === chaveDia(new Date())),
      podeReiniciar: docker.habilitado(),
    };
  }

  function definir(bruto) {
    cfg = validar({ ...cfg, ...bruto });
    // mudou a configuração: um "pular hoje" antigo não faz mais sentido
    if (puladoEm && puladoEm !== chaveDia(new Date())) puladoEm = null;
    salvar();
    recalcular();
    return status();
  }

  /** Cancela só a próxima ocorrência, sem desligar a agenda. */
  function pularProxima() {
    if (!alvo) throw erro400("não há reinício agendado para cancelar");
    puladoEm = chaveDia(alvo);
    salvar();
    const era = alvo;
    recalcular();
    log?.("info", `reinício de ${era.toLocaleString("pt-BR")} cancelado`);
    return status();
  }

  carregar();
  setInterval(() => { tique().catch((err) => log?.("err", `agenda: ${err.message}`)); }, INTERVALO_MS).unref();

  return { status, definir, pularProxima };
}
