// Monta o texto do comando a partir do rank. Funções puras (sem rede nem
// banco), testadas em test/app.test.js.

const TIER_PT = {
  IRON: "Ferro", BRONZE: "Bronze", SILVER: "Prata", GOLD: "Ouro",
  PLATINUM: "Platina", EMERALD: "Esmeralda", DIAMOND: "Diamante",
  MASTER: "Mestre", GRANDMASTER: "Grão-Mestre", CHALLENGER: "Desafiante",
};
const TIER_EN = {
  IRON: "Iron", BRONZE: "Bronze", SILVER: "Silver", GOLD: "Gold",
  PLATINUM: "Platinum", EMERALD: "Emerald", DIAMOND: "Diamond",
  MASTER: "Master", GRANDMASTER: "Grandmaster", CHALLENGER: "Challenger",
};
const DIVISION_NUM = { I: "1", II: "2", III: "3", IV: "4", V: "5" };
const TIERS_SEM_DIVISAO = ["MASTER", "GRANDMASTER", "CHALLENGER"];

// Fila do comando → queueType da Riot.
const FILAS = { lol: "RANKED_SOLO_5x5", lol_solo: "RANKED_SOLO_5x5", lol_flex: "RANKED_FLEX_SR" };

export const TEMPLATE_PADRAO = "(player) está (rank) com (pontos) pontos";
export const TEMPLATE_PADRAO_EN = "(player) is (rank) with (pontos) LP";

export function traduzirTier(tier, lang = "pt") {
  if (!tier) return lang === "en" ? "Unranked" : "Sem rank";
  const dict = lang === "en" ? TIER_EN : TIER_PT;
  return dict[tier.toUpperCase()] || tier;
}

export function traduzirDivisao(div) {
  if (!div) return "";
  return DIVISION_NUM[div.toUpperCase()] || div;
}

// Entrada da fila pedida, ou null (sem rank nessa fila).
export function entradaDaFila(entradas, gameMode) {
  const queueType = FILAS[gameMode] || "RANKED_SOLO_5x5";
  return (Array.isArray(entradas) ? entradas : []).find((q) => q.queueType === queueType) || null;
}

// Remove espaços e aspas externas ("..." ou '...') — o site manda msg="...".
export function cleanMsg(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s;
}

// Substitui as variáveis — aceita (var) e {var}, sem diferenciar maiúsculas.
export function applyTemplate(template, playerInfo, ranked, gameMode, lang = "pt") {
  let rankStr = lang === "en" ? "Unranked" : "Sem rank";
  let tierStr = rankStr;
  let divStr = "";
  let lpStr = "0";

  if (ranked) {
    tierStr = traduzirTier(ranked.tier, lang);
    divStr = traduzirDivisao(ranked.rank);
    if (TIERS_SEM_DIVISAO.includes((ranked.tier || "").toUpperCase())) {
      rankStr = tierStr;
      divStr = "";
    } else {
      rankStr = `${tierStr} ${divStr}`.trim();
    }
    lpStr = String(ranked.leaguePoints || 0);
  }

  const wins = ranked?.wins || 0;
  const losses = ranked?.losses || 0;
  const total = wins + losses;
  const winrate = total > 0 ? `${Math.round((wins / total) * 100)}%` : "0%";

  const variables = {
    player: playerInfo.gameName || (lang === "en" ? "Unknown" : "Desconhecido"),
    tag: playerInfo.tagLine || "",
    region: (playerInfo.region || "").toUpperCase(),
    rank: rankStr,
    tier: tierStr,
    divisao: divStr,
    division: divStr,
    pontos: lpStr,
    lp: lpStr,
    vitorias: String(wins),
    wins: String(wins),
    derrotas: String(losses),
    losses: String(losses),
    winrate,
    jogos: String(total),
    games: String(total),
    modo: gameMode.toUpperCase(),
    mode: gameMode.toUpperCase(),
  };

  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    // função no replace: um "$" no valor não vira padrão especial
    result = result.replace(new RegExp(`\\(${key}\\)`, "gi"), () => value).replace(new RegExp(`\\{${key}\\}`, "gi"), () => value);
  }
  return result;
}
