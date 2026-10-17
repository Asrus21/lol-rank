// Acesso à API da Riot (conta, invocador e liga do LoL).

// Plataforma do LoL → cluster regional da ACCOUNT-V1.
export const REGION_ROUTING = {
  br1: "americas", la1: "americas", la2: "americas", na1: "americas",
  euw1: "europe", eun1: "europe", tr1: "europe", ru: "europe",
  kr: "asia", jp1: "asia",
  oc1: "sea", ph2: "sea", sg2: "sea", th2: "sea", tw2: "sea", vn2: "sea",
};

export function mapRiotToVal(region) {
  const m = {
    br1: "br", na1: "na", la1: "latam", la2: "latam",
    euw1: "eu", eun1: "eu", tr1: "eu", ru: "eu", me1: "eu",
    kr: "kr", jp1: "ap", oc1: "ap", ph2: "ap", sg2: "ap", th2: "ap", tw2: "ap", vn2: "ap",
  };
  return m[(region || "").toLowerCase()] || null;
}

export function mapValToRiot(region) {
  const m = { br: "br1", na: "na1", latam: "la1", eu: "euw1", kr: "kr" };
  return m[(region || "").toLowerCase()] || null;
}

// Erro com o status HTTP da Riot (404 = não existe, 429 = limite, 401/403 = chave).
export class ErroRiot extends Error {
  constructor(status, corpo) {
    super(`Riot API ${status}`);
    this.status = status;
    this.corpo = corpo;
  }
}

export function criarRiot(apiKey, fetchImpl = fetch) {
  async function get(host, path) {
    const res = await fetchImpl(`https://${host}.api.riotgames.com${path}`, {
      headers: { "X-Riot-Token": apiKey || "" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new ErroRiot(res.status, await res.text().catch(() => ""));
    return res.json();
  }

  return {
    contaPorRiotId: (cluster, gameName, tagLine) =>
      get(cluster, `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`),
    invocadorPorPuuid: (region, puuid) => get(region, `/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`),
    ligaLol: (region, puuid) => get(region, `/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`),
  };
}

// nick#tag → { puuid, gameName, tagLine, summonerId }. Erro da conta propaga
// (com .status); falha no invocador só deixa summonerId nulo.
export async function buscarContaRiot(riot, gameName, tagLine, region) {
  const r = region.toLowerCase();
  const conta = await riot.contaPorRiotId(REGION_ROUTING[r] || "americas", gameName, tagLine);
  let invocador = null;
  try {
    invocador = await riot.invocadorPorPuuid(r, conta.puuid);
  } catch (err) {
    console.warn("[riot] invocador do LoL não encontrado:", err.message);
  }
  return { puuid: conta.puuid, gameName: conta.gameName, tagLine: conta.tagLine, summonerId: invocador?.id || null };
}
