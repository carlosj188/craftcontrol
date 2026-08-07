/**
 * Este mod serve neste servidor?
 *
 * Duas perguntas: o carregador bate, e a versão do Minecraft bate. A primeira é
 * um `includes`. A segunda é chata, porque cada carregador escreve o intervalo de
 * um jeito:
 *
 *   Fabric     ">=1.21 <1.22"   "~1.21"   "1.21.1"   "*"   ["1.21", "1.21.1"]
 *   Forge      "[1.21.1,1.22)"  "[1.21,)"                    (intervalo Maven)
 *
 * Por isso a fonte preferida é o Modrinth, que devolve a lista literal de versões
 * suportadas — sem interpretação, sem chute. O intervalo declarado no jar é o
 * plano B, para mod que não está no catálogo.
 *
 * **Regra da casa: na dúvida, `null`.** Um "não sei" honesto vira aviso amarelo na
 * interface e deixa o usuário decidir; um "incompatível" errado bloquearia um mod
 * que funciona, e um "compatível" errado derrubaria o servidor. O meio-termo é o
 * único resultado que não causa dano.
 */

/** "1.21.1" -> [1,21,1]; o que não for número vira 0 e o resto é ignorado. */
function partes(v) {
  return String(v).trim().split(/[.\-+]/).slice(0, 3).map((x) => {
    const n = parseInt(x, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function comparar(a, b) {
  const pa = partes(a), pb = partes(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Intervalo Maven: `[1.21,1.22)`, `[1.21,)`, `(,1.21]`, `[1.21.1]`. */
function maven(range, versao) {
  const m = /^([[(])\s*([^,\])]*)\s*(?:,\s*([^\])]*))?\s*([\])])$/.exec(range.trim());
  if (!m) return null;
  const [, abre, minBruto, maxBruto, fecha] = m;
  const min = (minBruto || "").trim();
  // `[1.21.1]` sem vírgula quer dizer exatamente esta versão
  const max = maxBruto === undefined ? min : (maxBruto || "").trim();

  if (min) {
    const c = comparar(versao, min);
    if (c < 0 || (c === 0 && abre === "(")) return false;
  }
  if (max) {
    const c = comparar(versao, max);
    if (c > 0 || (c === 0 && fecha === ")")) return false;
  }
  return true;
}

/** Comparador único do estilo Fabric: `>=1.21`, `<1.22`, `1.21.1`, `~1.21`, `*`. */
function termo(t, versao) {
  const s = t.trim();
  if (!s || s === "*") return true;

  const op = /^(>=|<=|>|<|=|\^|~)?\s*v?(.+)$/.exec(s);
  if (!op) return null;
  const [, sinal, alvoBruto] = op;
  const alvo = alvoBruto.trim().replace(/^v/, "");
  if (!/^\d/.test(alvo)) return null; // "any", ramo git, coisa que não sei ler

  const c = comparar(versao, alvo);
  switch (sinal) {
    case ">=": return c >= 0;
    case ">": return c > 0;
    case "<=": return c <= 0;
    case "<": return c < 0;
    case "~": {
      // ~1.21 aceita 1.21.x; ~1.21.1 aceita 1.21.>=1
      const p = partes(alvo);
      const v = partes(versao);
      return v[0] === p[0] && v[1] === p[1] && c >= 0;
    }
    case "^": {
      const p = partes(alvo);
      const v = partes(versao);
      return v[0] === p[0] && c >= 0;
    }
    default: {
      // sem operador: "1.21" costuma significar a linha 1.21 quando vem sem patch
      if (alvo.split(".").length === 2) {
        const p = partes(alvo), v = partes(versao);
        return v[0] === p[0] && v[1] === p[1];
      }
      return c === 0;
    }
  }
}

/**
 * A versão cabe no intervalo declarado?
 * @returns {boolean|null} null = não deu para interpretar o que estava escrito
 */
export function versaoNoIntervalo(range, versao) {
  if (!range || !versao) return null;
  const bruto = String(range).trim();
  if (!bruto || bruto === "*") return true;

  // "a || b" — qualquer lado serve
  if (bruto.includes("||")) {
    const partesOu = bruto.split("||").map((p) => versaoNoIntervalo(p, versao));
    if (partesOu.some((r) => r === true)) return true;
    return partesOu.some((r) => r === null) ? null : false;
  }

  if (/^[[(]/.test(bruto)) return maven(bruto, versao);

  // "> =1.21 <1.22" — espaços separam condições que valem todas juntas
  const termos = bruto.split(/\s+/).filter(Boolean);
  const res = termos.map((t) => termo(t, versao));
  if (res.some((r) => r === false)) return false;
  return res.some((r) => r === null) ? null : true;
}

/**
 * Veredito sobre um jar.
 *
 * @param perfil     o que o próprio jar declara (de modmeta.identificar/escolherPerfil)
 * @param declarados todos os carregadores que o jar traz
 * @param alvo       { carregador, versaoJogo } do servidor
 * @param catalogo   o que o Modrinth sabe da versão exata deste arquivo, se souber
 * @returns {{ok:boolean|null, motivos:string[], avisos:string[]}}
 */
export function avaliar({ perfil, declarados, alvo, catalogo }) {
  const motivos = [];  // impedem: o mod não vai carregar
  const avisos = [];   // não impedem, mas o usuário precisa saber
  let incerto = false;

  /* ---- carregador ---- */
  const doJar = catalogo?.loaders?.length ? catalogo.loaders : declarados;
  if (alvo.carregador && doJar?.length) {
    if (!doJar.includes(alvo.carregador)) {
      motivos.push(`é um mod de ${doJar.join("/")} e este servidor é ${alvo.carregador}`);
    }
  } else if (!doJar?.length) {
    incerto = true;
    avisos.push("não consegui ler os metadados do jar — pode não ser um mod");
  }

  /* ---- versão do Minecraft ---- */
  if (alvo.versaoJogo) {
    if (catalogo?.game_versions?.length) {
      // fonte literal: o autor marcou exatamente estas versões no Modrinth
      if (!catalogo.game_versions.includes(alvo.versaoJogo)) {
        motivos.push(`foi publicado para ${resumirVersoes(catalogo.game_versions)} e este servidor é ${alvo.versaoJogo}`);
      }
    } else if (perfil?.mcRange) {
      const r = versaoNoIntervalo(perfil.mcRange, alvo.versaoJogo);
      if (r === false) motivos.push(`declara suportar ${perfil.mcRange} e este servidor é ${alvo.versaoJogo}`);
      else if (r === null) { incerto = true; avisos.push(`não sei interpretar "${perfil.mcRange}" como faixa de versão`); }
    } else {
      incerto = true;
      avisos.push("o jar não diz para qual versão do Minecraft ele é");
    }
  }

  /* ---- o mod faz alguma coisa no servidor? ---- */
  // só o jar declara isto: `catalogo` aqui é sempre um objeto de VERSÃO do
  // Modrinth, e `server_side` é campo de projeto — nunca vem
  if (perfil?.ambiente === "client") {
    avisos.push("é um mod de cliente: no servidor ele só ocupa memória");
  }

  if (motivos.length) return { ok: false, motivos, avisos };
  return { ok: incerto ? null : true, motivos, avisos };
}

/** ["1.21","1.21.1","1.20.1"] -> "1.20.1, 1.21 e 1.21.1" (no máximo 4). */
function resumirVersoes(lista) {
  const ord = [...lista].sort(comparar);
  const mostra = ord.length > 4 ? [...ord.slice(0, 3), `mais ${ord.length - 3}`] : ord;
  if (mostra.length === 1) return mostra[0];
  return mostra.slice(0, -1).join(", ") + " e " + mostra[mostra.length - 1];
}
