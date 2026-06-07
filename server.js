require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const RIOT_API_KEY = process.env.RIOT_API_KEY;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const corsOptions = {
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Garante que o schema exista antes de atender requests (essencial na Vercel,
// onde não há app.listen para rodar a init no boot). Idempotente e cacheado.
app.use(async (req, res, next) => {
  try { await ensureInit(); next(); } catch (e) { next(e); }
});

// ============================================
// REGIÕES
// ============================================
const REGION_ROUTING = {
  'br1': 'americas', 'la1': 'americas', 'la2': 'americas', 'na1': 'americas',
  'euw1': 'europe', 'eun1': 'europe', 'tr1': 'europe', 'ru': 'europe',
  'kr': 'asia', 'jp1': 'asia',
  'oc1': 'sea', 'ph2': 'sea', 'sg2': 'sea', 'th2': 'sea', 'tw2': 'sea', 'vn2': 'sea'
};

// ============================================
// TRADUÇÃO DE ELOS
// ============================================
const TIER_PT = {
  'IRON': 'Ferro', 'BRONZE': 'Bronze', 'SILVER': 'Prata', 'GOLD': 'Ouro',
  'PLATINUM': 'Platina', 'EMERALD': 'Esmeralda', 'DIAMOND': 'Diamante',
  'MASTER': 'Mestre', 'GRANDMASTER': 'Grão-Mestre', 'CHALLENGER': 'Desafiante'
};
const TIER_EN = {
  'IRON': 'Iron', 'BRONZE': 'Bronze', 'SILVER': 'Silver', 'GOLD': 'Gold',
  'PLATINUM': 'Platinum', 'EMERALD': 'Emerald', 'DIAMOND': 'Diamond',
  'MASTER': 'Master', 'GRANDMASTER': 'Grandmaster', 'CHALLENGER': 'Challenger'
};
const DIVISION_NUM = { 'I': '1', 'II': '2', 'III': '3', 'IV': '4', 'V': '5' };
const TIERS_SEM_DIVISAO = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];

function traduzirTier(tier, lang = 'pt') {
  if (!tier) return lang === 'en' ? 'Unranked' : 'Sem rank';
  const dict = lang === 'en' ? TIER_EN : TIER_PT;
  return dict[tier.toUpperCase()] || tier;
}
function traduzirDivisao(div) {
  if (!div) return '';
  return DIVISION_NUM[div.toUpperCase()] || div;
}

// ============================================
// INIT DB
// ============================================
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lol_players (
        id SERIAL PRIMARY KEY,
        custom_uuid VARCHAR(36) UNIQUE NOT NULL,
        riot_puuid VARCHAR(78) UNIQUE NOT NULL,
        current_game_name VARCHAR(100),
        current_tag_line VARCHAR(10),
        region VARCHAR(10),
        summoner_id VARCHAR(100),
        tft_summoner_id VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE lol_players ADD COLUMN IF NOT EXISTS tft_summoner_id VARCHAR(100);`);

    // Tabela de comandos salvos — mantida para compatibilidade com o formato antigo /cmd/UUID/NOME
    await pool.query(`
      CREATE TABLE IF NOT EXISTS custom_commands (
        id SERIAL PRIMARY KEY,
        custom_uuid VARCHAR(36) NOT NULL REFERENCES lol_players(custom_uuid) ON DELETE CASCADE,
        command_name VARCHAR(50) NOT NULL,
        template TEXT NOT NULL,
        game_mode VARCHAR(20) DEFAULT 'lol_solo',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(custom_uuid, command_name)
      );
    `);
    await pool.query(`ALTER TABLE custom_commands ADD COLUMN IF NOT EXISTS game_mode VARCHAR(20) DEFAULT 'lol_solo';`);

    // Tabela COMPARTILHADA entre os 3 apps (LoL, TFT, Valorant).
    // `account_id` é um ID gerado do ZERO (uuid próprio do asrus) — NÃO é o
    // puuid da Riot nem da HenrikDev. É esse ID que o usuário usa nas URLs dos
    // comandos dos 3 jogos. Internamente guardamos os puuids reais (riot/val)
    // só para conseguir buscar o rank em cada API.
    // Quando o usuário digita o nick em qualquer site, a conta é resolvida e
    // gravada aqui — os outros sites passam a reconhecer o mesmo account_id.
    // Requer DATABASE_URL apontando para o MESMO banco Postgres nos 3 deploys.
    //   riot_region = plataforma LoL/TFT (br1, na1, euw1...)
    //   val_region  = região Valorant/HenrikDev (na, eu, br...)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id  TEXT PRIMARY KEY,
        game_name   TEXT,
        tag_line    TEXT,
        riot_puuid  TEXT,
        riot_region TEXT,
        val_puuid   TEXT,
        val_region  TEXT,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS accounts_riotid ON accounts (LOWER(game_name), LOWER(tag_line));`);
    await pool.query(`CREATE INDEX IF NOT EXISTS accounts_riot_puuid ON accounts (riot_puuid);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS accounts_val_puuid ON accounts (val_puuid);`);

    console.log('✅ Banco de dados inicializado');
  } catch (err) {
    console.error('❌ Erro ao inicializar banco:', err);
  }
}

// ============================================
// CONTA COMPARTILHADA (accounts) — ID gerado do zero
// Mesmo account_id -> mesma conta entre LoL, TFT e Valorant.
// ============================================

// Mapeamento de região entre o formato da Riot (LoL/TFT) e o do Valorant.
function mapRiotToVal(region) {
  const m = {
    br1: 'br', na1: 'na', la1: 'latam', la2: 'latam',
    euw1: 'eu', eun1: 'eu', tr1: 'eu', ru: 'eu', me1: 'eu',
    kr: 'kr', jp1: 'ap', oc1: 'ap', ph2: 'ap', sg2: 'ap', th2: 'ap', tw2: 'ap', vn2: 'ap'
  };
  return m[(region || '').toLowerCase()] || null;
}
function mapValToRiot(region) {
  const m = { br: 'br1', na: 'na1', latam: 'la1', eu: 'euw1', kr: 'kr' };
  return m[(region || '').toLowerCase()] || null;
}

// Lê a conta compartilhada por account_id OU por um puuid real (compat. legada).
async function getSharedAccount(id) {
  if (!id) return null;
  try {
    const r = await pool.query(
      'SELECT * FROM accounts WHERE account_id = $1 OR riot_puuid = $1 OR val_puuid = $1 LIMIT 1',
      [id]
    );
    return r.rows[0] || null;
  } catch (err) {
    console.warn('⚠️  accounts leitura falhou:', err.message);
    return null;
  }
}

// Upsert do lado RIOT (LoL/TFT). Deduplica por riot_puuid e depois por nick#tag.
// Gera um account_id do zero quando a conta ainda não existe. Retorna o account_id.
async function linkAccountRiot({ riotPuuid, gameName, tagLine, riotRegion }) {
  const valRegion = mapRiotToVal(riotRegion);
  try {
    let r = await pool.query('SELECT * FROM accounts WHERE riot_puuid = $1 LIMIT 1', [riotPuuid]);
    if (r.rows.length === 0 && gameName && tagLine) {
      r = await pool.query(
        'SELECT * FROM accounts WHERE LOWER(game_name) = LOWER($1) AND LOWER(tag_line) = LOWER($2) LIMIT 1',
        [gameName, tagLine]
      );
    }
    if (r.rows.length > 0) {
      const acc = r.rows[0];
      await pool.query(`
        UPDATE accounts SET
          game_name = $1, tag_line = $2, riot_puuid = $3, riot_region = $4,
          val_region = COALESCE(val_region, $5), updated_at = CURRENT_TIMESTAMP
        WHERE account_id = $6
      `, [gameName, tagLine, riotPuuid, riotRegion, valRegion, acc.account_id]);
      return acc.account_id;
    }
    const accountId = uuidv4();
    await pool.query(`
      INSERT INTO accounts (account_id, game_name, tag_line, riot_puuid, riot_region, val_region)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [accountId, gameName, tagLine, riotPuuid, riotRegion, valRegion]);
    return accountId;
  } catch (err) {
    console.warn('⚠️  accounts upsert (riot) falhou:', err.message);
    return null;
  }
}

// ============================================
// Riot API
// ============================================
async function fetchRiotAccount(gameName, tagLine, region) {
  const cluster = REGION_ROUTING[region.toLowerCase()] || 'americas';
  const accountUrl = `https://${cluster}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
  const accountResponse = await axios.get(accountUrl, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
  const { puuid } = accountResponse.data;

  let summonerData = null;
  try {
    const url = `https://${region.toLowerCase()}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`;
    const res = await axios.get(url, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
    summonerData = res.data;
  } catch (err) {
    console.warn('⚠️  LoL summoner não encontrado:', err.message);
  }

  return {
    puuid,
    gameName: accountResponse.data.gameName,
    tagLine: accountResponse.data.tagLine,
    summonerId: summonerData?.id || null
  };
}

async function fetchRankedByPuuid(puuid, region, gameMode = 'lol_solo') {
  try {
    const url = `https://${region.toLowerCase()}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`;
    const response = await axios.get(url, { headers: { 'X-Riot-Token': RIOT_API_KEY } });

    const queueTypeMap = {
      'lol': 'RANKED_SOLO_5x5',
      'lol_solo': 'RANKED_SOLO_5x5',
      'lol_flex': 'RANKED_FLEX_SR'
    };
    const queueType = queueTypeMap[gameMode] || 'RANKED_SOLO_5x5';
    const entry = response.data.find(q => q.queueType === queueType);
    if (!entry) {
      console.log(`ℹ️  ${puuid.slice(0,8)}...: sem entrada para ${queueType}. Disponíveis:`, response.data.map(q => q.queueType));
    }
    return entry || null;
  } catch (err) {
    const status = err.response?.status;
    console.error(`❌ Erro ao buscar ranked [HTTP ${status}]:`, err.response?.data || err.message);
    return null;
  }
}

// ============================================
// Aplica template — aceita (var) e {var}
// ============================================
function applyTemplate(template, playerInfo, ranked, gameMode, lang = 'pt') {
  let rankStr = lang === 'en' ? 'Unranked' : 'Sem rank';
  let tierStr = lang === 'en' ? 'Unranked' : 'Sem rank';
  let divStr = '';
  let lpStr = '0';

  if (ranked) {
    tierStr = traduzirTier(ranked.tier, lang);
    divStr = traduzirDivisao(ranked.rank);
    if (TIERS_SEM_DIVISAO.includes((ranked.tier || '').toUpperCase())) {
      rankStr = tierStr;
      divStr = '';
    } else {
      rankStr = `${tierStr} ${divStr}`.trim();
    }
    lpStr = (ranked.leaguePoints || 0).toString();
  }

  const wins = ranked?.wins || 0;
  const losses = ranked?.losses || 0;
  const total = wins + losses;
  const winrate = total > 0 ? `${Math.round((wins / total) * 100)}%` : '0%';

  const variables = {
    'player': playerInfo.gameName || (lang === 'en' ? 'Unknown' : 'Desconhecido'),
    'tag': playerInfo.tagLine || '',
    'region': (playerInfo.region || '').toUpperCase(),
    'rank': rankStr,
    'tier': tierStr,
    'divisao': divStr,
    'division': divStr,
    'pontos': lpStr,
    'lp': lpStr,
    'vitorias': wins.toString(),
    'wins': wins.toString(),
    'derrotas': losses.toString(),
    'losses': losses.toString(),
    'winrate': winrate,
    'jogos': total.toString(),
    'games': total.toString(),
    'modo': gameMode.toUpperCase(),
    'mode': gameMode.toUpperCase()
  };

  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    const regexParen = new RegExp('\\(' + key + '\\)', 'gi');
    const regexBrace = new RegExp('\\{' + key + '\\}', 'gi');
    result = result.replace(regexParen, value).replace(regexBrace, value);
  }
  return result;
}

// ============================================
// Limpar msg (remove aspas externas se vierem)
// ============================================
function cleanMsg(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  // Remove aspas externas se o usuário copiou com aspas
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s;
}

// ============================================
// Detecta se a request quer HTML bonito ou texto puro
// ============================================
function wantsHtml(req) {
  // Forçar texto via ?format=text
  if (req.query.format === 'text' || req.query.raw === '1') return false;
  // Forçar html via ?format=html
  if (req.query.format === 'html') return true;
  // Detectar pelo Accept header (navegador manda text/html)
  const accept = req.headers.accept || '';
  return accept.includes('text/html');
}

// ============================================
// HTML bonito para visualização no navegador
// ============================================
function renderHtmlResult(result, meta) {
  const safeResult = String(result).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeName = String(meta.player || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeTag = String(meta.tag || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Rank LoL — ${safeName}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Outfit:wght@300;500;700;900&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Outfit',sans-serif;background:#0a0a0f;color:#f5f5fa;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;overflow-x:hidden}
  body::before{content:'';position:fixed;inset:0;background:radial-gradient(circle at 15% 20%,rgba(167,139,250,.13),transparent 42%),radial-gradient(circle at 85% 80%,rgba(244,114,182,.09),transparent 42%);pointer-events:none;z-index:0}
  .card{position:relative;z-index:1;max-width:560px;width:100%;background:#1a1a26;border:1px solid #2a2a3a;border-radius:16px;padding:32px;text-align:center}
  .badge{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;background:#232333;border:1px solid #3a3a4f;border-radius:20px;font-size:11px;color:#9999b3;font-family:'JetBrains Mono',monospace;letter-spacing:1px;text-transform:uppercase;margin-bottom:20px}
  .badge-dot{width:8px;height:8px;background:#34d399;border-radius:50%;box-shadow:0 0 8px #34d399}
  .player{font-size:14px;color:#9999b3;margin-bottom:8px;letter-spacing:.3px}
  .player strong{color:#f5f5fa;font-weight:700}
  .result{font-size:22px;font-weight:700;line-height:1.4;color:#f5f5fa;padding:24px 16px;background:#0a0a0f;border:1px solid #2a2a3a;border-left:4px solid #a78bfa;border-radius:12px;margin:16px 0;word-wrap:break-word}
  .meta{display:flex;justify-content:center;gap:16px;font-size:12px;color:#5c5c75;font-family:'JetBrains Mono',monospace;letter-spacing:.5px;text-transform:uppercase}
  .footer{margin-top:24px;font-size:11px;color:#5c5c75;line-height:1.6}
  .footer a{color:#a78bfa;text-decoration:none;font-weight:700}
  .footer a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="card">
  <div class="badge"><div class="badge-dot"></div>LIVE · LEAGUE OF LEGENDS</div>
  <div class="player">👤 <strong>${safeName}</strong>#${safeTag}</div>
  <div class="result">${safeResult}</div>
  <div class="meta">
    <span>🌎 ${(meta.region || '').toUpperCase()}</span>
    <span>⚔️ ${(meta.gameMode || '').replace('lol_','').toUpperCase()}</span>
  </div>
  <div class="footer">
    Visualização web do comando · gerado por
    <a href="https://www.asrus.app/rank-lol">asrus.app/rank-lol</a><br>
    StreamElements e bots recebem texto puro automaticamente.
  </div>
</div>
</body>
</html>`;
}

// ============================================
// ROTA: Registrar/Buscar jogador (gera UUID customizado)
// ============================================
app.post('/api/register', async (req, res) => {
  const { gameName, tagLine, region } = req.body;
  if (!gameName || !tagLine || !region) {
    return res.status(400).json({ error: 'gameName, tagLine e region são obrigatórios' });
  }
  if (!REGION_ROUTING[region.toLowerCase()]) {
    return res.status(400).json({ error: 'Região inválida' });
  }

  try {
    const riotData = await fetchRiotAccount(gameName, tagLine, region);
    // Gera/atualiza o account_id COMPARTILHADO (ID do zero). É esse ID que o
    // usuário usa nos 3 jogos. Os outros sites passam a reconhecê-lo na hora.
    const accountId = await linkAccountRiot({
      riotPuuid: riotData.puuid,
      gameName: riotData.gameName,
      tagLine: riotData.tagLine,
      riotRegion: region.toLowerCase()
    });
    const existing = await pool.query('SELECT * FROM lol_players WHERE riot_puuid = $1', [riotData.puuid]);

    if (existing.rows.length > 0) {
      const player = existing.rows[0];
      await pool.query(`
        UPDATE lol_players SET current_game_name = $1, current_tag_line = $2, summoner_id = $3, updated_at = CURRENT_TIMESTAMP
        WHERE riot_puuid = $4
      `, [riotData.gameName, riotData.tagLine, riotData.summonerId, riotData.puuid]);

      return res.json({
        account_id: accountId,
        custom_uuid: player.custom_uuid,
        puuid: riotData.puuid,
        gameName: riotData.gameName,
        tagLine: riotData.tagLine,
        region: player.region,
        isNew: false,
        message: '✅ Jogador encontrado'
      });
    }

    const customUuid = uuidv4();
    await pool.query(`
      INSERT INTO lol_players (custom_uuid, riot_puuid, current_game_name, current_tag_line, region, summoner_id)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [customUuid, riotData.puuid, riotData.gameName, riotData.tagLine, region.toLowerCase(), riotData.summonerId]);

    res.json({
      account_id: accountId,
      custom_uuid: customUuid,
      puuid: riotData.puuid,
      gameName: riotData.gameName,
      tagLine: riotData.tagLine,
      region: region.toLowerCase(),
      isNew: true,
      message: '🎉 Jogador registrado com sucesso'
    });
  } catch (err) {
    console.error('Erro:', err.response?.data || err.message);
    if (err.response?.status === 404) return res.status(404).json({ error: 'Jogador não encontrado na Riot API' });
    if (err.response?.status === 403) return res.status(403).json({ error: 'API Key inválida ou sem permissão' });
    if (err.response?.status === 401) return res.status(401).json({ error: 'API Key inválida ou expirada' });
    if (err.response?.status === 429) return res.status(429).json({ error: 'Rate limit excedido' });
    res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
});

// ============================================
// ROTA: Buscar jogador por UUID customizado
// ============================================
app.get('/api/player/:customUuid', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM lol_players WHERE custom_uuid = $1', [req.params.customUuid]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'UUID não encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// HANDLER UNIFICADO DE COMANDO LoL
// Rotas novas (padrão /api/{jogo}/...):  /api/lol/cmd/:id  ·  /api/lol/cmd?...
// Rotas legadas (compatibilidade):       /cmd/lol/:id      ·  /cmd/lol?...
//
// :id = account_id gerado do zero (mesmo ID nos 3 jogos). Também aceita o puuid
// real (compat. legada) e ?nick=&tag=&region=.
// ============================================
async function handleLolCmd(req, res) {
  const template = cleanMsg(req.query.msg) || '(player) está (rank) com (pontos) pontos';
  const gameMode = (req.query.queue || req.query.mode || 'lol_solo').toLowerCase();
  const lang = (req.query.lang || 'pt').toLowerCase();

  // O ID pode vir no path (/api/lol/cmd/:id) ou na query (?id= / ?puuid=)
  const queryId = cleanMsg(req.params.puuid) || cleanMsg(req.query.id) || cleanMsg(req.query.puuid);
  let queryNick = cleanMsg(req.query.nick) || cleanMsg(req.query.gameName);
  let queryTag = cleanMsg(req.query.tag) || cleanMsg(req.query.tagLine);
  // Suporta ?player=Nome#Tag (ex.: comando de chat "!rank Nome#Tag").
  const combined = cleanMsg(req.query.player) || cleanMsg(req.query.riot);
  if ((!queryNick || !queryTag) && combined) {
    const h = combined.lastIndexOf('#');
    if (h > 0 && h < combined.length - 1) {
      queryNick = combined.slice(0, h).trim();
      queryTag = combined.slice(h + 1).trim();
    } else if (!queryNick) {
      queryNick = combined;
    }
  }
  const queryRegion = (cleanMsg(req.query.region) || '').toLowerCase();

  const sendErr = (msg, meta) => {
    if (wantsHtml(req)) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(renderHtmlResult(msg, meta || { player: '—', tag: '—', region: '—', gameMode }));
    }
    res.set('Content-Type', 'text/plain; charset=utf-8');
    return res.send(msg);
  };

  try {
    let player = { puuid: null, gameName: null, tagLine: null, region: null };

    if (queryId) {
      // Caminho A: account_id (ou puuid real). Resolve pela conta compartilhada.
      const acc = await getSharedAccount(queryId);
      if (acc) {
        let region = (queryRegion || acc.riot_region || mapValToRiot(acc.val_region) || '').toLowerCase();
        if (acc.riot_puuid && region && REGION_ROUTING[region]) {
          // Já temos o puuid oficial do LoL — usa direto.
          player = { puuid: acc.riot_puuid, gameName: acc.game_name, tagLine: acc.tag_line, region };
        } else if (acc.game_name && acc.tag_line && region && REGION_ROUTING[region]) {
          // Conta veio de outro jogo (Valorant): resolve o puuid oficial agora.
          const riotData = await fetchRiotAccount(acc.game_name, acc.tag_line, region);
          await linkAccountRiot({
            riotPuuid: riotData.puuid, gameName: riotData.gameName,
            tagLine: riotData.tagLine, riotRegion: region
          });
          player = { puuid: riotData.puuid, gameName: riotData.gameName, tagLine: riotData.tagLine, region };
        } else {
          return sendErr(lang === 'en'
            ? 'Account known from another game. Add the LoL region, e.g. ?region=br1'
            : 'Conta conhecida em outro jogo. Informe a região do LoL, ex: ?region=br1');
        }
      } else {
        // Compat. legada: puuid real ainda no banco local de lol_players.
        const dbRes = await pool.query('SELECT * FROM lol_players WHERE riot_puuid = $1 LIMIT 1', [queryId]);
        if (dbRes.rows.length > 0) {
          player = {
            puuid: queryId,
            gameName: dbRes.rows[0].current_game_name,
            tagLine: dbRes.rows[0].current_tag_line,
            region: dbRes.rows[0].region
          };
          // Migra para a tabela de contas compartilhadas.
          await linkAccountRiot({
            riotPuuid: player.puuid, gameName: player.gameName,
            tagLine: player.tagLine, riotRegion: player.region
          });
        } else {
          return sendErr(lang === 'en'
            ? 'ID not registered. Search the player first at asrus.app/rank-lol'
            : 'ID não registrado. Busque o jogador primeiro em asrus.app/rank-lol');
        }
      }
    } else if (queryNick && queryTag && queryRegion) {
      // Caminho B: nick + tag + região
      if (!REGION_ROUTING[queryRegion]) {
        return sendErr(lang === 'en' ? 'Invalid region' : 'Região inválida');
      }

      // Primeiro tenta achar no banco (evita chamada à Riot)
      const dbRes = await pool.query(`
        SELECT * FROM lol_players
        WHERE LOWER(current_game_name) = LOWER($1)
          AND LOWER(current_tag_line) = LOWER($2)
          AND region = $3
        LIMIT 1
      `, [queryNick, queryTag, queryRegion]);

      if (dbRes.rows.length > 0) {
        player = {
          puuid: dbRes.rows[0].riot_puuid,
          gameName: dbRes.rows[0].current_game_name,
          tagLine: dbRes.rows[0].current_tag_line,
          region: dbRes.rows[0].region
        };
      } else {
        // Não está em cache — pede pra Riot e salva
        try {
          const riotData = await fetchRiotAccount(queryNick, queryTag, queryRegion);
          // Salva/atualiza no banco pra próximas chamadas serem instantâneas
          const existing = await pool.query('SELECT * FROM lol_players WHERE riot_puuid = $1', [riotData.puuid]);
          if (existing.rows.length > 0) {
            await pool.query(`
              UPDATE lol_players SET current_game_name = $1, current_tag_line = $2, summoner_id = $3, updated_at = CURRENT_TIMESTAMP
              WHERE riot_puuid = $4
            `, [riotData.gameName, riotData.tagLine, riotData.summonerId, riotData.puuid]);
          } else {
            const newUuid = uuidv4();
            await pool.query(`
              INSERT INTO lol_players (custom_uuid, riot_puuid, current_game_name, current_tag_line, region, summoner_id)
              VALUES ($1, $2, $3, $4, $5, $6)
            `, [newUuid, riotData.puuid, riotData.gameName, riotData.tagLine, queryRegion, riotData.summonerId]);
          }
          player = {
            puuid: riotData.puuid,
            gameName: riotData.gameName,
            tagLine: riotData.tagLine,
            region: queryRegion
          };
        } catch (riotErr) {
          const status = riotErr.response?.status;
          let errMsg;
          if (status === 404) errMsg = lang === 'en' ? 'Player not found' : 'Jogador não encontrado';
          else if (status === 429) errMsg = lang === 'en' ? 'Rate limit exceeded' : 'Rate limit excedido';
          else errMsg = lang === 'en' ? 'Error contacting Riot API' : 'Erro ao consultar a Riot';
          return sendErr(errMsg);
        }
      }
    } else {
      // Faltam parâmetros
      return sendErr(lang === 'en'
        ? 'Missing parameters. Use /api/lol/cmd/PUUID or ?nick=...&tag=...&region=...'
        : 'Parâmetros faltando. Use /api/lol/cmd/PUUID ou ?nick=...&tag=...&region=...');
    }

    // Mantém a conta compartilhada atualizada: TFT e Valorant reconhecem o
    // mesmo account_id automaticamente.
    await linkAccountRiot({
      riotPuuid: player.puuid,
      gameName: player.gameName,
      tagLine: player.tagLine,
      riotRegion: player.region
    });

    // A partir daqui, `player` está resolvido
    const ranked = await fetchRankedByPuuid(player.puuid, player.region, gameMode);
    const result = applyTemplate(template, player, ranked, gameMode, lang);

    if (wantsHtml(req)) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(renderHtmlResult(result, {
        player: player.gameName,
        tag: player.tagLine,
        region: player.region,
        gameMode
      }));
    }
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(result);
  } catch (err) {
    console.error('Erro em handleLolCmd:', err.message);
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send('Erro ao processar o comando');
  }
}

// Rotas novas (padrão unificado /api/{jogo}/...) + legadas (/cmd/lol)
app.get('/api/lol/cmd/:puuid', handleLolCmd);
app.get('/api/lol/cmd', handleLolCmd);
app.get('/cmd/lol/:puuid', handleLolCmd);
app.get('/cmd/lol', handleLolCmd);

// ============================================
// ROTAS LEGADAS (mantidas para compatibilidade)
// Formato antigo com nome de comando salvo no banco
// ============================================
app.post('/api/command', async (req, res) => {
  const { custom_uuid, command_name, template, game_mode = 'lol_solo' } = req.body;
  if (!custom_uuid || !command_name || !template) {
    return res.status(400).json({ error: 'custom_uuid, command_name e template são obrigatórios' });
  }
  const validModes = ['lol_solo', 'lol_flex'];
  if (!validModes.includes(game_mode)) {
    return res.status(400).json({ error: 'game_mode inválido' });
  }
  try {
    const player = await pool.query('SELECT * FROM lol_players WHERE custom_uuid = $1', [custom_uuid]);
    if (player.rows.length === 0) return res.status(404).json({ error: 'UUID não encontrado' });
    await pool.query(`
      INSERT INTO custom_commands (custom_uuid, command_name, template, game_mode)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (custom_uuid, command_name)
      DO UPDATE SET template = EXCLUDED.template, game_mode = EXCLUDED.game_mode
    `, [custom_uuid, command_name, template, game_mode]);
    res.json({ success: true, message: 'Comando salvo' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/command/:customUuid/:commandName', async (req, res) => {
  const { customUuid, commandName } = req.params;
  try {
    const cmdResult = await pool.query(
      'SELECT template, game_mode FROM custom_commands WHERE custom_uuid = $1 AND command_name = $2',
      [customUuid, commandName]
    );
    if (cmdResult.rows.length === 0) return res.status(404).json({ error: 'Comando não encontrado' });

    const playerResult = await pool.query('SELECT * FROM lol_players WHERE custom_uuid = $1', [customUuid]);
    const player = playerResult.rows[0];
    const { template, game_mode } = cmdResult.rows[0];

    const ranked = await fetchRankedByPuuid(player.riot_puuid, player.region, game_mode);
    const result = applyTemplate(template, {
      gameName: player.current_game_name,
      tagLine: player.current_tag_line,
      region: player.region
    }, ranked, game_mode);

    res.json({
      result, template, game_mode,
      player: { gameName: player.current_game_name, tagLine: player.current_tag_line, uuid: player.custom_uuid },
      ranked
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/cmd/:customUuid/:commandName', async (req, res) => {
  const { customUuid, commandName } = req.params;
  res.set('Content-Type', 'text/plain; charset=utf-8');
  try {
    const cmdResult = await pool.query(
      'SELECT template, game_mode FROM custom_commands WHERE custom_uuid = $1 AND command_name = $2',
      [customUuid, commandName]
    );
    if (cmdResult.rows.length === 0) return res.send('Comando não encontrado');

    const playerResult = await pool.query('SELECT * FROM lol_players WHERE custom_uuid = $1', [customUuid]);
    if (playerResult.rows.length === 0) return res.send('Jogador não encontrado');

    const player = playerResult.rows[0];
    const { template, game_mode } = cmdResult.rows[0];
    const ranked = await fetchRankedByPuuid(player.riot_puuid, player.region, game_mode);
    const result = applyTemplate(template, {
      gameName: player.current_game_name,
      tagLine: player.current_tag_line,
      region: player.region
    }, ranked, game_mode);
    res.send(result);
  } catch (err) {
    console.error('Erro na rota /cmd (legacy):', err.message);
    res.send('Erro ao processar o comando');
  }
});

app.get('/api/commands/:customUuid', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT command_name, template, game_mode, created_at FROM custom_commands WHERE custom_uuid = $1 ORDER BY created_at DESC',
      [req.params.customUuid]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/command/:customUuid/:commandName', async (req, res) => {
  try {
    await pool.query('DELETE FROM custom_commands WHERE custom_uuid = $1 AND command_name = $2',
      [req.params.customUuid, req.params.commandName]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// START
// ============================================
// Inicialização do banco idempotente, rodada uma vez por processo. Em ambiente
// serverless (Vercel) não há app.listen — então garantimos o schema na 1ª request.
let _initPromise = null;
function ensureInit() {
  if (!_initPromise) _initPromise = initDatabase().catch((e) => { _initPromise = null; throw e; });
  return _initPromise;
}

// Local / servidor persistente: escuta uma porta. Na Vercel isso é pulado e o
// app é exportado como handler serverless (ver vercel.json + api/index.js).
if (!process.env.VERCEL) {
  app.listen(PORT, async () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`🔑 RIOT_API_KEY: ${RIOT_API_KEY ? 'definida' : '❌ AUSENTE'}`);
    console.log(`🎮 Modo: somente LoL`);
    console.log(`📍 Rota nova: /api/lol/cmd/:puuid?msg=...&queue=lol_solo&lang=pt (legado: /cmd/lol/:puuid)`);
    await ensureInit();
  });
}

module.exports = app;
module.exports.ensureInit = ensureInit;
