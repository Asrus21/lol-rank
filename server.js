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

// PostgreSQL connection (Railway fornece DATABASE_URL automaticamente)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// CORS configurável para Vercel
const corsOptions = {
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
};
app.use(cors(corsOptions));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// REGIÕES DA RIOT
// ============================================
const REGION_ROUTING = {
  'br1': 'americas', 'la1': 'americas', 'la2': 'americas', 'na1': 'americas',
  'euw1': 'europe', 'eun1': 'europe', 'tr1': 'europe', 'ru': 'europe',
  'kr': 'asia', 'jp1': 'asia',
  'oc1': 'sea', 'ph2': 'sea', 'sg2': 'sea', 'th2': 'sea', 'tw2': 'sea', 'vn2': 'sea'
};

// ============================================
// TRADUÇÃO DE ELOS PARA PORTUGUÊS
// ============================================
const TIER_PT = {
  'IRON': 'Ferro',
  'BRONZE': 'Bronze',
  'SILVER': 'Prata',
  'GOLD': 'Ouro',
  'PLATINUM': 'Platina',
  'EMERALD': 'Esmeralda',
  'DIAMOND': 'Diamante',
  'MASTER': 'Mestre',
  'GRANDMASTER': 'Grão-Mestre',
  'CHALLENGER': 'Desafiante',
  // TFT Hyper Roll (Turbo) usa tiers de cor
  'GRAY': 'Cinza',
  'GREEN': 'Verde',
  'BLUE': 'Azul',
  'PURPLE': 'Roxo',
  'ORANGE': 'Laranja'
};

// Conversão de divisão (numeral romano -> número)
const DIVISION_NUM = {
  'I': '1', 'II': '2', 'III': '3', 'IV': '4', 'V': '5'
};

// Tiers que não possuem divisão real
const TIERS_SEM_DIVISAO = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];

function traduzirTier(tier) {
  if (!tier) return 'Unranked';
  return TIER_PT[tier.toUpperCase()] || tier;
}

function traduzirDivisao(div) {
  if (!div) return '';
  return DIVISION_NUM[div.toUpperCase()] || div;
}

// ============================================
// INICIALIZAÇÃO DO BANCO
// ============================================
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
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

    // Migrações
    await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS tft_summoner_id VARCHAR(100);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS custom_commands (
        id SERIAL PRIMARY KEY,
        custom_uuid VARCHAR(36) NOT NULL REFERENCES players(custom_uuid) ON DELETE CASCADE,
        command_name VARCHAR(50) NOT NULL,
        template TEXT NOT NULL,
        game_mode VARCHAR(20) DEFAULT 'lol_solo',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(custom_uuid, command_name)
      );
    `);

    await pool.query(`ALTER TABLE custom_commands ADD COLUMN IF NOT EXISTS game_mode VARCHAR(20) DEFAULT 'lol_solo';`);

    console.log('✅ Banco de dados inicializado');
  } catch (err) {
    console.error('❌ Erro ao inicializar banco:', err);
  }
}

// ============================================
// Buscar dados na API da Riot (LoL + TFT)
// ============================================
async function fetchRiotAccount(gameName, tagLine, region) {
  const cluster = REGION_ROUTING[region.toLowerCase()] || 'americas';

  // 1. Conta universal (Riot ID)
  const accountUrl = `https://${cluster}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
  const accountResponse = await axios.get(accountUrl, {
    headers: { 'X-Riot-Token': RIOT_API_KEY }
  });
  const { puuid } = accountResponse.data;

  // 2. Summoner ID do LoL (opcional, mantido para compatibilidade)
  let summonerData = null;
  try {
    const url = `https://${region.toLowerCase()}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`;
    const res = await axios.get(url, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
    summonerData = res.data;
  } catch (err) {
    console.warn('⚠️  LoL summoner não encontrado:', err.message);
  }

  // 3. Summoner ID do TFT (opcional, mantido para compatibilidade)
  let tftSummonerData = null;
  try {
    const url = `https://${region.toLowerCase()}.api.riotgames.com/tft/summoner/v1/summoners/by-puuid/${puuid}`;
    const res = await axios.get(url, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
    tftSummonerData = res.data;
  } catch (err) {
    console.warn('⚠️  TFT summoner não encontrado:', err.message);
  }

  return {
    puuid,
    gameName: accountResponse.data.gameName,
    tagLine: accountResponse.data.tagLine,
    summonerId: summonerData?.id || null,
    tftSummonerId: tftSummonerData?.id || null
  };
}

// ============================================
// Buscar dados de ranked (LoL ou TFT) — via PUUID
// ============================================
async function fetchRankedData(player, gameMode = 'lol_solo') {
  const region = player.region.toLowerCase();
  const puuid = player.riot_puuid;

  if (!puuid) {
    console.warn('⚠️  Player sem PUUID salvo');
    return null;
  }

  try {
    const isTft = gameMode.startsWith('tft');

    // TFT: /tft/league/v1/by-puuid/{puuid}  (atenção: NÃO tem "entries")
    // LoL: /lol/league/v4/entries/by-puuid/{puuid}
    const url = isTft
      ? `https://${region}.api.riotgames.com/tft/league/v1/by-puuid/${puuid}`
      : `https://${region}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`;

    const response = await axios.get(url, {
      headers: { 'X-Riot-Token': RIOT_API_KEY }
    });

    const queueTypeMap = {
      'lol': 'RANKED_SOLO_5x5',
      'lol_solo': 'RANKED_SOLO_5x5',
      'lol_flex': 'RANKED_FLEX_SR',
      'tft': 'RANKED_TFT',
      'tft_double_up': 'RANKED_TFT_DOUBLE_UP',
      'tft_turbo': 'RANKED_TFT_TURBO'
    };

    const queueType = queueTypeMap[gameMode];
    const entry = response.data.find(q => q.queueType === queueType);

    if (!entry) {
      console.log(`ℹ️  ${player.current_game_name}: sem entrada ranked para ${queueType}. Filas disponíveis:`,
        response.data.map(q => q.queueType));
    }

    return entry || null;
  } catch (err) {
    const status = err.response?.status;
    console.error(`❌ Erro ao buscar ranked (${gameMode}) [HTTP ${status}]:`, err.response?.data || err.message);
    return null;
  }
}

// ============================================
// Substituir variáveis no template
// ============================================
function applyTemplate(template, player, ranked, gameMode) {
  const isTurbo = gameMode === 'tft_turbo';

  let rankStr = 'Unranked';
  let tierStr = 'Unranked';
  let divStr = '';
  let lpStr = '0';

  if (ranked) {
    if (isTurbo && ranked.ratedTier) {
      // TFT Hyper Roll: GRAY, GREEN, BLUE, PURPLE, ORANGE (sem divisão)
      tierStr = traduzirTier(ranked.ratedTier);
      rankStr = tierStr;
      lpStr = (ranked.ratedRating || 0).toString();
    } else {
      tierStr = traduzirTier(ranked.tier);
      divStr = traduzirDivisao(ranked.rank);

      // Mestre / Grão-Mestre / Desafiante não têm divisão real
      if (TIERS_SEM_DIVISAO.includes((ranked.tier || '').toUpperCase())) {
        rankStr = tierStr;
        divStr = '';
      } else {
        rankStr = `${tierStr} ${divStr}`.trim();
      }

      lpStr = (ranked.leaguePoints || 0).toString();
    }
  }

  const wins = ranked?.wins || 0;
  const losses = ranked?.losses || 0;
  const total = wins + losses;
  const winrate = total > 0 ? `${Math.round((wins / total) * 100)}%` : '0%';

  // No TFT, "wins" significa Top 4 (não vitória de 1º lugar)
  const variables = {
    '(player)': player.current_game_name || 'Desconhecido',
    '(tag)': player.current_tag_line || '',
    '(uuid)': player.custom_uuid,
    '(region)': player.region?.toUpperCase() || '',
    '(rank)': rankStr,
    '(tier)': tierStr,
    '(divisao)': divStr,
    '(pontos)': lpStr,
    '(lp)': lpStr,
    '(vitorias)': wins.toString(),
    '(derrotas)': losses.toString(),
    '(winrate)': winrate,
    '(top4)': wins.toString(),
    '(top4rate)': winrate,
    '(jogos)': total.toString(),
    '(modo)': gameMode.toUpperCase()
  };

  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(key.replace(/[()]/g, '\\$&'), 'gi');
    result = result.replace(regex, value);
  }
  return result;
}

// ============================================
// ROTA: Registrar/Buscar jogador
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

    const existing = await pool.query('SELECT * FROM players WHERE riot_puuid = $1', [riotData.puuid]);

    if (existing.rows.length > 0) {
      const player = existing.rows[0];

      // Atualiza tudo que possa ter mudado
      await pool.query(`
        UPDATE players
        SET current_game_name = $1, current_tag_line = $2,
            summoner_id = $3, tft_summoner_id = $4, updated_at = CURRENT_TIMESTAMP
        WHERE riot_puuid = $5
      `, [riotData.gameName, riotData.tagLine, riotData.summonerId, riotData.tftSummonerId, riotData.puuid]);

      return res.json({
        custom_uuid: player.custom_uuid,
        gameName: riotData.gameName,
        tagLine: riotData.tagLine,
        region: player.region,
        isNew: false,
        message: '✅ Jogador encontrado no banco de dados'
      });
    }

    const customUuid = uuidv4();

    await pool.query(`
      INSERT INTO players (custom_uuid, riot_puuid, current_game_name, current_tag_line, region, summoner_id, tft_summoner_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [customUuid, riotData.puuid, riotData.gameName, riotData.tagLine, region.toLowerCase(), riotData.summonerId, riotData.tftSummonerId]);

    res.json({
      custom_uuid: customUuid,
      gameName: riotData.gameName,
      tagLine: riotData.tagLine,
      region: region.toLowerCase(),
      isNew: true,
      message: '🎉 UUID customizado gerado e salvo permanentemente'
    });

  } catch (err) {
    console.error('Erro:', err.response?.data || err.message);

    if (err.response?.status === 404) return res.status(404).json({ error: 'Jogador não encontrado na Riot API' });
    if (err.response?.status === 403) return res.status(403).json({ error: 'API Key da Riot inválida ou sem permissão' });
    if (err.response?.status === 401) return res.status(401).json({ error: 'API Key da Riot inválida ou expirada' });
    if (err.response?.status === 429) return res.status(429).json({ error: 'Rate limit excedido. Tente novamente em alguns segundos' });

    res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
});

// ============================================
// ROTA: Buscar jogador pelo UUID
// ============================================
app.get('/api/player/:customUuid', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM players WHERE custom_uuid = $1', [req.params.customUuid]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'UUID não encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ROTA: Criar/Atualizar custom command
// ============================================
app.post('/api/command', async (req, res) => {
  const { custom_uuid, command_name, template, game_mode = 'lol_solo' } = req.body;

  if (!custom_uuid || !command_name || !template) {
    return res.status(400).json({ error: 'custom_uuid, command_name e template são obrigatórios' });
  }

  const validModes = ['lol_solo', 'lol_flex', 'tft', 'tft_double_up', 'tft_turbo'];
  if (!validModes.includes(game_mode)) {
    return res.status(400).json({ error: 'game_mode inválido. Use: ' + validModes.join(', ') });
  }

  try {
    const player = await pool.query('SELECT * FROM players WHERE custom_uuid = $1', [custom_uuid]);
    if (player.rows.length === 0) return res.status(404).json({ error: 'UUID não encontrado' });

    await pool.query(`
      INSERT INTO custom_commands (custom_uuid, command_name, template, game_mode)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (custom_uuid, command_name)
      DO UPDATE SET template = EXCLUDED.template, game_mode = EXCLUDED.game_mode
    `, [custom_uuid, command_name, template, game_mode]);

    res.json({ success: true, message: 'Comando salvo com sucesso' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ROTA: Executar custom command
// ============================================
app.get('/api/command/:customUuid/:commandName', async (req, res) => {
  const { customUuid, commandName } = req.params;

  try {
    const cmdResult = await pool.query(
      'SELECT template, game_mode FROM custom_commands WHERE custom_uuid = $1 AND command_name = $2',
      [customUuid, commandName]
    );

    if (cmdResult.rows.length === 0) return res.status(404).json({ error: 'Comando não encontrado' });

    const playerResult = await pool.query('SELECT * FROM players WHERE custom_uuid = $1', [customUuid]);
    const player = playerResult.rows[0];
    const { template, game_mode } = cmdResult.rows[0];

    const ranked = await fetchRankedData(player, game_mode);
    const result = applyTemplate(template, player, ranked, game_mode);

    res.json({
      result, template, game_mode,
      player: {
        gameName: player.current_game_name,
        tagLine: player.current_tag_line,
        uuid: player.custom_uuid
      },
      ranked
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ROTA: Listar comandos
// ============================================
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

// ============================================
// ROTA: Deletar comando
// ============================================
app.delete('/api/command/:customUuid/:commandName', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM custom_commands WHERE custom_uuid = $1 AND command_name = $2',
      [req.params.customUuid, req.params.commandName]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  await initDatabase();
});
