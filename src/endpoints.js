// Endpoints de UM comando só — cada comando do bot chama um endereço que faz
// uma coisa e busca em um lugar só (sem passar pelo banco quando não precisa).
// Documentação para o público: elorank-games.com.br/docs (aba LoL).
//
//   GET /api/lol/elo/nick?player=Nome%23Tag&region=br1   elo pelo nick (só Riot)
//   GET /api/lol/elo/nick/:nome/:tag?region=br1          o mesmo, nick no caminho
//   GET /api/lol/elo/puuid/:puuid?region=br1             elo pelo PUUID (só Riot)
//   GET /api/lol/elo/id/:id                              elo pelo ID EloRank (1 consulta no banco + Riot)
//   GET /api/lol/puuid?player=Nome%23Tag&region=br1      só o PUUID do nick
//   GET /api/lol/status                                  saúde da API, da Riot e do banco
//
// Parâmetros comuns dos /elo: msg (template), queue|mode (lol_solo, lol_flex),
// lang (pt, en), format=json (campos separados, para overlays).
// Texto sai sempre com status 200: o bot imprime o corpo no chat, inclusive a
// mensagem de erro.
import { REGION_ROUTING, buscarContaRiot } from "./riot.js";
import { TEMPLATE_PADRAO, applyTemplate, cleanMsg, entradaDaFila, traduzirDivisao, traduzirTier } from "./template.js";

export const SITE = "elorank-games.com.br/rank-lol";
export const REGIAO_PADRAO = "br1";
// Respostas boas ficam 30s no cache de borda (src/index.js): o mesmo !elo
// repetido no chat não gasta a cota da Riot.
export const CACHE_OK = "public, max-age=30";

const FILAS_VALIDAS = ["lol_solo", "lol_flex"];

// "Nome Com Espaço#TAG" → { nome, tag }. Separa no ÚLTIMO "#".
export function separarRiotId(valor) {
  const v = cleanMsg(valor);
  const h = v.lastIndexOf("#");
  if (h <= 0 || h >= v.length - 1) return null;
  return { nome: v.slice(0, h).trim(), tag: v.slice(h + 1).trim() };
}

function opcoes(c) {
  const lang = (c.req.query("lang") || "pt").toLowerCase() === "en" ? "en" : "pt";
  const fila = (c.req.query("queue") || c.req.query("mode") || "lol_solo").toLowerCase();
  return {
    lang,
    en: lang === "en",
    fila: FILAS_VALIDAS.includes(fila) ? fila : "lol_solo",
    template: cleanMsg(c.req.query("msg")) || TEMPLATE_PADRAO,
    json: (c.req.query("format") || "").toLowerCase() === "json",
    region: (cleanMsg(c.req.query("region")) || "").toLowerCase(),
  };
}

function texto(c, corpo, cache = "no-store") {
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Cache-Control", cache);
  c.header("Access-Control-Allow-Origin", "*");
  return c.body(corpo, 200);
}

// Erro amigável: texto (200) para o bot, JSON com status para quem integra.
function falha(c, o, status, pt, en) {
  const msg = o.en ? en : pt;
  if (o.json) {
    c.header("Cache-Control", "no-store");
    return c.json({ ok: false, error: msg }, status);
  }
  return texto(c, msg);
}

function erroRiot(c, o, err) {
  if (err?.status === 404) return falha(c, o, 404, "Jogador não encontrado", "Player not found");
  if (err?.status === 429) return falha(c, o, 429, "Muitas consultas agora, tente em instantes", "Too many requests, try again shortly");
  if (err?.status === 401 || err?.status === 403) return falha(c, o, 502, "Chave da Riot inválida no servidor", "Server Riot key is invalid");
  console.error("[elo]", err?.status, err?.corpo || err?.message);
  return falha(c, o, 502, "Erro ao consultar a Riot", "Error contacting Riot API");
}

// Resposta final do /elo, a partir do jogador e das entradas da liga.
function responderElo(c, o, jogador, entradas) {
  const ranked = entradaDaFila(entradas, o.fila);
  const frase = applyTemplate(o.template, jogador, ranked, o.fila, o.lang);
  if (!o.json) return texto(c, frase, CACHE_OK);

  const wins = ranked?.wins || 0;
  const losses = ranked?.losses || 0;
  const jogos = wins + losses;
  c.header("Cache-Control", CACHE_OK);
  return c.json({
    ok: true,
    jogo: "lol",
    player: jogador.gameName,
    tag: jogador.tagLine,
    region: jogador.region,
    puuid: jogador.puuid,
    fila: o.fila,
    ranqueado: Boolean(ranked),
    rank: applyTemplate("(rank)", jogador, ranked, o.fila, o.lang),
    tier: ranked ? traduzirTier(ranked.tier, o.lang) : null,
    tier_original: ranked?.tier || null,
    divisao: ranked ? traduzirDivisao(ranked.rank) : null,
    pontos: ranked?.leaguePoints ?? 0,
    vitorias: wins,
    derrotas: losses,
    jogos,
    winrate: jogos ? Math.round((wins / jogos) * 100) : 0,
    texto: frase,
  });
}

function regiaoValida(o) {
  const r = o.region || REGIAO_PADRAO;
  return REGION_ROUTING[r] ? r : null;
}

export function registrarEndpoints(app, { banco, riot }) {
  // ---------- Elo pelo nick: Riot ID → PUUID → liga. Sem banco. ----------
  async function eloPorNick(c, nome, tag) {
    const o = opcoes(c);
    if (!nome || !tag) return falha(c, o, 400, "Use: !elo Nome#Tag", "Use: !elo Name#Tag");
    const region = regiaoValida(o);
    if (!region) return falha(c, o, 400, "Região inválida (ex.: region=br1)", "Invalid region (e.g. region=br1)");
    try {
      const conta = await riot.contaPorRiotId(REGION_ROUTING[region], nome, tag);
      const entradas = await riot.ligaLol(region, conta.puuid);
      return responderElo(c, o, { puuid: conta.puuid, gameName: conta.gameName, tagLine: conta.tagLine, region }, entradas);
    } catch (err) {
      return erroRiot(c, o, err);
    }
  }

  app.get("/api/lol/elo/nick", (c) => {
    const junto = separarRiotId(c.req.query("player") || c.req.query("riot") || "");
    const nome = cleanMsg(c.req.query("nick")) || junto?.nome;
    const tag = cleanMsg(c.req.query("tag")) || junto?.tag;
    return eloPorNick(c, nome, tag);
  });
  app.get("/api/lol/elo/nick/:nome/:tag", (c) => eloPorNick(c, c.req.param("nome"), c.req.param("tag")));

  // ---------- Elo pelo PUUID: conta e liga em paralelo. Sem banco. ----------
  app.get("/api/lol/elo/puuid/:puuid", async (c) => {
    const o = opcoes(c);
    const puuid = cleanMsg(c.req.param("puuid"));
    const region = regiaoValida(o);
    if (!region) return falha(c, o, 400, "Região inválida (ex.: region=br1)", "Invalid region (e.g. region=br1)");
    try {
      const [conta, entradas] = await Promise.all([
        // O nome só enfeita a frase: se a conta falhar, segue sem ele.
        riot.contaPorPuuid(REGION_ROUTING[region], puuid).catch((err) => {
          if (err?.status === 400 || err?.status === 404) throw err;
          return null;
        }),
        riot.ligaLol(region, puuid),
      ]);
      return responderElo(c, o, { puuid, gameName: conta?.gameName, tagLine: conta?.tagLine, region }, entradas);
    } catch (err) {
      // A Riot responde 400 para um PUUID mal formado.
      if (err?.status === 400) return falha(c, o, 404, "PUUID inválido", "Invalid PUUID");
      return erroRiot(c, o, err);
    }
  });

  // ---------- Elo pelo ID EloRank: 1 consulta (accounts) + Riot. ----------
  app.get("/api/lol/elo/id/:id", async (c) => {
    const o = opcoes(c);
    const id = cleanMsg(c.req.param("id"));
    const acc = await banco.contaCompartilhada(id);
    if (!acc) {
      // Compatível com o /cmd/{id} antigo: um PUUID da Riot que ainda não está
      // na tabela accounts também funciona.
      const region = (o.region || REGIAO_PADRAO).toLowerCase();
      if (!REGION_ROUTING[region]) return falha(c, o, 400, "Região inválida (ex.: region=br1)", "Invalid region (e.g. region=br1)");
      try {
        const [conta, entradas] = await Promise.all([
          riot.contaPorPuuid(REGION_ROUTING[region], id),
          riot.ligaLol(region, id),
        ]);
        return responderElo(c, o, { puuid: id, gameName: conta.gameName, tagLine: conta.tagLine, region }, entradas);
      } catch (err) {
        if (err?.status === 429) return erroRiot(c, o, err);
        return falha(c, o, 404, `ID não encontrado. Busque o jogador em ${SITE}`, `ID not found. Search the player at ${SITE}`);
      }
    }
    const region = (o.region || acc.riot_region || "").toLowerCase() || REGIAO_PADRAO;
    if (!REGION_ROUTING[region]) return falha(c, o, 400, "Região inválida (ex.: region=br1)", "Invalid region (e.g. region=br1)");
    try {
      let jogador = { puuid: acc.riot_puuid, gameName: acc.game_name, tagLine: acc.tag_line, region };
      if (!jogador.puuid) {
        // Conta conhecida só pelo Valorant: resolve o PUUID da Riot agora e guarda.
        if (!acc.game_name || !acc.tag_line) return falha(c, o, 404, "Conta sem Riot ID", "Account without Riot ID");
        const conta = await buscarContaRiot(riot, acc.game_name, acc.tag_line, region);
        jogador = { puuid: conta.puuid, gameName: conta.gameName, tagLine: conta.tagLine, region };
        await banco.vincularContaRiot({ riotPuuid: conta.puuid, gameName: conta.gameName, tagLine: conta.tagLine, riotRegion: region });
      }
      let entradas;
      try {
        entradas = await riot.ligaLol(region, jogador.puuid);
      } catch (err) {
        // O PUUID salvo pode ter vindo de outro jogo: cada chave da Riot cifra o
        // PUUID de um jeito, e a Riot recusa (400) o de outra chave. Nesse caso
        // resolve pelo Riot ID salvo, sem regravar (o outro jogo usa o dele).
        if (![400, 404].includes(err?.status) || !acc.game_name || !acc.tag_line) throw err;
        const conta = await riot.contaPorRiotId(REGION_ROUTING[region], acc.game_name, acc.tag_line);
        jogador = { puuid: conta.puuid, gameName: conta.gameName, tagLine: conta.tagLine, region };
        entradas = await riot.ligaLol(region, conta.puuid);
      }
      return responderElo(c, o, jogador, entradas);
    } catch (err) {
      return erroRiot(c, o, err);
    }
  });

  // ---------- Só o PUUID do nick ----------
  app.get("/api/lol/puuid", async (c) => {
    const o = opcoes(c);
    const junto = separarRiotId(c.req.query("player") || c.req.query("riot") || "");
    const nome = cleanMsg(c.req.query("nick")) || junto?.nome;
    const tag = cleanMsg(c.req.query("tag")) || junto?.tag;
    if (!nome || !tag) return falha(c, o, 400, "Use: ?player=Nome%23Tag", "Use: ?player=Name%23Tag");
    const region = regiaoValida(o);
    if (!region) return falha(c, o, 400, "Região inválida (ex.: region=br1)", "Invalid region (e.g. region=br1)");
    try {
      const conta = await riot.contaPorRiotId(REGION_ROUTING[region], nome, tag);
      if (!o.json) return texto(c, conta.puuid, CACHE_OK);
      c.header("Cache-Control", CACHE_OK);
      return c.json({ ok: true, jogo: "lol", puuid: conta.puuid, player: conta.gameName, tag: conta.tagLine, region });
    } catch (err) {
      return erroRiot(c, o, err);
    }
  });

  // ---------- Status ----------
  app.get("/api/lol/status", async (c) => {
    const o = opcoes(c);
    const region = regiaoValida(o) || REGIAO_PADRAO;
    const s = await verificarStatus({ banco, riot, region });
    if ((c.req.query("format") || "").toLowerCase() === "text") return texto(c, fraseStatus(s, o.en));
    c.header("Cache-Control", "no-store");
    c.header("Access-Control-Allow-Origin", "*");
    return c.json(s, s.ok ? 200 : 503);
  });
}

// Mede quanto uma checagem leva; nunca lança.
async function medir(fn) {
  const t0 = Date.now();
  try {
    const dados = await fn();
    return { ok: true, ms: Date.now() - t0, dados };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, erro: err?.status ? `HTTP ${err.status}` : err?.message || "falhou" };
  }
}

export async function verificarStatus({ banco, riot, region }) {
  const [db, r] = await Promise.all([medir(() => banco.ping()), medir(() => riot.statusPlataforma(region))]);
  const incidentes = r.ok ? (r.dados?.incidents || []).length : null;
  const manutencoes = r.ok ? (r.dados?.maintenances || []).length : null;
  return {
    ok: db.ok && r.ok,
    servico: "rank-lol",
    jogo: "lol",
    hora: new Date().toISOString(),
    banco: { ok: db.ok, ms: db.ms, ...(db.erro ? { erro: db.erro } : {}) },
    riot: {
      ok: r.ok,
      ms: r.ms,
      region,
      incidentes,
      manutencoes,
      ...(r.erro ? { erro: r.erro } : {}),
    },
  };
}

export function fraseStatus(s, en = false) {
  const reg = s.riot.region.toUpperCase();
  const riot = s.riot.ok
    ? s.riot.incidentes || s.riot.manutencoes
      ? en
        ? `Riot ${reg}: ${s.riot.incidentes} incident(s), ${s.riot.manutencoes} maintenance(s)`
        : `Riot ${reg}: ${s.riot.incidentes} incidente(s), ${s.riot.manutencoes} manutenção(ões)`
      : en
        ? `Riot ${reg}: OK`
        : `Riot ${reg}: OK, sem incidentes`
    : en
      ? `Riot ${reg}: unreachable`
      : `Riot ${reg}: fora do ar`;
  const banco = s.banco.ok ? (en ? "database OK" : "banco OK") : en ? "database down" : "banco fora do ar";
  return `LoL API: ${s.ok ? "online" : en ? "degraded" : "instável"} · ${riot} · ${banco}`;
}
