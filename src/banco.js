// Banco Postgres (Neon). `q(texto, params)` devolve as linhas.
//
// Tabelas:
//   lol_players     — jogadores do LoL (puuid da Riot, nome atual, região)
//   custom_commands — comandos salvos no formato antigo /cmd/UUID/NOME
//   accounts        — COMPARTILHADA entre LoL, TFT e Valorant. `account_id` é
//                     um ID gerado do zero, o mesmo nos 3 jogos. Exige a MESMA
//                     DATABASE_URL nos 3 projetos.
import { mapRiotToVal } from "./riot.js";

export function criarBanco(q) {
  let schemaPronto = null;

  async function criarSchema() {
    await q(`
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
      )`);
    await q(`ALTER TABLE lol_players ADD COLUMN IF NOT EXISTS tft_summoner_id VARCHAR(100)`);
    await q(`
      CREATE TABLE IF NOT EXISTS custom_commands (
        id SERIAL PRIMARY KEY,
        custom_uuid VARCHAR(36) NOT NULL REFERENCES lol_players(custom_uuid) ON DELETE CASCADE,
        command_name VARCHAR(50) NOT NULL,
        template TEXT NOT NULL,
        game_mode VARCHAR(20) DEFAULT 'lol_solo',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(custom_uuid, command_name)
      )`);
    await q(`ALTER TABLE custom_commands ADD COLUMN IF NOT EXISTS game_mode VARCHAR(20) DEFAULT 'lol_solo'`);
    await q(`
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
      )`);
    await q(`CREATE INDEX IF NOT EXISTS accounts_riotid ON accounts (LOWER(game_name), LOWER(tag_line))`);
    await q(`CREATE INDEX IF NOT EXISTS accounts_riot_puuid ON accounts (riot_puuid)`);
    await q(`CREATE INDEX IF NOT EXISTS accounts_val_puuid ON accounts (val_puuid)`);
  }

  const primeira = (rows) => rows[0] || null;

  return {
    // Uma vez por instância do Worker; se falhar, tenta de novo na próxima.
    // Como no servidor antigo, falha aqui não derruba a requisição: só registra.
    async garantirSchema() {
      if (!schemaPronto) {
        schemaPronto = criarSchema().catch((e) => {
          schemaPronto = null;
          console.error("[db] erro ao inicializar o banco:", e.message);
        });
      }
      return schemaPronto;
    },

    // ---------- lol_players ----------
    jogadorPorPuuid: (puuid) => q("SELECT * FROM lol_players WHERE riot_puuid = $1 LIMIT 1", [puuid]).then(primeira),
    jogadorPorUuid: (uuid) => q("SELECT * FROM lol_players WHERE custom_uuid = $1", [uuid]).then(primeira),
    jogadorPorNome: (nick, tag, region) =>
      q(
        `SELECT * FROM lol_players
         WHERE LOWER(current_game_name) = LOWER($1) AND LOWER(current_tag_line) = LOWER($2) AND region = $3
         LIMIT 1`,
        [nick, tag, region]
      ).then(primeira),
    async inserirJogador({ customUuid, puuid, gameName, tagLine, region, summonerId }) {
      await q(
        `INSERT INTO lol_players (custom_uuid, riot_puuid, current_game_name, current_tag_line, region, summoner_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [customUuid, puuid, gameName, tagLine, region, summonerId]
      );
    },
    async atualizarJogador(puuid, { gameName, tagLine, summonerId }) {
      await q(
        `UPDATE lol_players SET current_game_name = $1, current_tag_line = $2, summoner_id = $3, updated_at = CURRENT_TIMESTAMP
         WHERE riot_puuid = $4`,
        [gameName, tagLine, summonerId, puuid]
      );
    },

    // ---------- custom_commands (formato antigo) ----------
    async salvarComando({ customUuid, nome, template, gameMode }) {
      await q(
        `INSERT INTO custom_commands (custom_uuid, command_name, template, game_mode)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (custom_uuid, command_name)
         DO UPDATE SET template = EXCLUDED.template, game_mode = EXCLUDED.game_mode`,
        [customUuid, nome, template, gameMode]
      );
    },
    comandoSalvo: (uuid, nome) =>
      q("SELECT template, game_mode FROM custom_commands WHERE custom_uuid = $1 AND command_name = $2", [uuid, nome]).then(primeira),
    listarComandos: (uuid) =>
      q("SELECT command_name, template, game_mode, created_at FROM custom_commands WHERE custom_uuid = $1 ORDER BY created_at DESC", [uuid]),
    async apagarComando(uuid, nome) {
      await q("DELETE FROM custom_commands WHERE custom_uuid = $1 AND command_name = $2", [uuid, nome]);
    },

    // ---------- accounts (compartilhada) ----------
    async contaCompartilhada(id) {
      if (!id) return null;
      try {
        return primeira(await q("SELECT * FROM accounts WHERE account_id = $1 OR riot_puuid = $1 OR val_puuid = $1 LIMIT 1", [id]));
      } catch (err) {
        console.warn("[accounts] leitura falhou:", err.message);
        return null;
      }
    },

    // Upsert do lado Riot. Acha pelo puuid e, se não achar, pelo nome#tag;
    // senão cria com um ID novo. Devolve o account_id.
    async vincularContaRiot({ riotPuuid, gameName, tagLine, riotRegion }) {
      const valRegion = mapRiotToVal(riotRegion);
      try {
        let rows = await q("SELECT * FROM accounts WHERE riot_puuid = $1 LIMIT 1", [riotPuuid]);
        if (rows.length === 0 && gameName && tagLine) {
          rows = await q("SELECT * FROM accounts WHERE LOWER(game_name) = LOWER($1) AND LOWER(tag_line) = LOWER($2) LIMIT 1", [
            gameName, tagLine,
          ]);
        }
        if (rows.length > 0) {
          const acc = rows[0];
          await q(
            `UPDATE accounts SET
               game_name = $1, tag_line = $2, riot_puuid = $3, riot_region = $4,
               val_region = COALESCE(val_region, $5), updated_at = CURRENT_TIMESTAMP
             WHERE account_id = $6`,
            [gameName, tagLine, riotPuuid, riotRegion, valRegion, acc.account_id]
          );
          return acc.account_id;
        }
        const accountId = crypto.randomUUID();
        await q(
          `INSERT INTO accounts (account_id, game_name, tag_line, riot_puuid, riot_region, val_region)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [accountId, gameName, tagLine, riotPuuid, riotRegion, valRegion]
        );
        return accountId;
      } catch (err) {
        console.warn("[accounts] upsert (riot) falhou:", err.message);
        return null;
      }
    },
  };
}
