// Rotas da API do Rank LoL — as mesmas do servidor Express antigo, com as
// mesmas respostas (os comandos de bot no ar dependem delas). Recebe banco e
// Riot prontos (criarApp) para os testes trocarem por versões falsas.
//
//   POST   /api/register                    nick#tag → registra, devolve o ID
//   GET    /api/player/:customUuid          dados do jogador
//   GET    /api/lol/cmd/:id  · /api/lol/cmd comando do bot (texto, ou página no navegador)
//   GET    /cmd/lol/:id      · /cmd/lol     o mesmo, caminho antigo
//   POST   /api/command                     salva comando (formato antigo)
//   GET    /api/command/:uuid/:nome         roda comando salvo (JSON)
//   GET    /cmd/:uuid/:nome                 roda comando salvo (texto)
//   GET    /api/commands/:uuid              lista comandos salvos
//   DELETE /api/command/:uuid/:nome         apaga comando salvo
import { Hono } from "hono";
import { cors } from "hono/cors";
import { renderHtmlResult } from "./html.js";
import { REGION_ROUTING, buscarContaRiot, mapValToRiot } from "./riot.js";
import { TEMPLATE_PADRAO, applyTemplate, cleanMsg, entradaDaFila } from "./template.js";

export const SITE = "elorank-games.com.br/rank-lol";

export function criarApp({ banco, riot }) {
  const app = new Hono();

  app.use(
    "*",
    cors({ origin: "*", allowMethods: ["GET", "POST", "DELETE", "OPTIONS"], allowHeaders: ["Content-Type"] })
  );
  app.use("*", async (c, next) => {
    await banco.garantirSchema();
    return next();
  });

  // Entrada da fila pedida; qualquer erro da Riot vira "sem rank".
  async function rankDoJogador(puuid, region, gameMode) {
    try {
      return entradaDaFila(await riot.ligaLol(region.toLowerCase(), puuid), gameMode);
    } catch (err) {
      console.error(`[ranked] HTTP ${err.status}:`, err.corpo || err.message);
      return null;
    }
  }

  async function lerCorpo(c) {
    try {
      return (await c.req.json()) || {};
    } catch {
      return {};
    }
  }

  // Navegador (Accept: text/html) recebe a página; bots, texto puro.
  function querHtml(c) {
    const format = c.req.query("format");
    if (format === "text" || c.req.query("raw") === "1") return false;
    if (format === "html") return true;
    return (c.req.header("accept") || "").includes("text/html");
  }

  function texto(c, corpo) {
    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return c.body(corpo);
  }

  // ---------- Registro ----------
  app.post("/api/register", async (c) => {
    const { gameName, tagLine, region } = await lerCorpo(c);
    if (!gameName || !tagLine || !region) return c.json({ error: "gameName, tagLine e region são obrigatórios" }, 400);
    if (!REGION_ROUTING[String(region).toLowerCase()]) return c.json({ error: "Região inválida" }, 400);
    const regiao = String(region).toLowerCase();

    try {
      const riotData = await buscarContaRiot(riot, gameName, tagLine, regiao);
      const accountId = await banco.vincularContaRiot({
        riotPuuid: riotData.puuid,
        gameName: riotData.gameName,
        tagLine: riotData.tagLine,
        riotRegion: regiao,
      });

      const existente = await banco.jogadorPorPuuid(riotData.puuid);
      if (existente) {
        await banco.atualizarJogador(riotData.puuid, riotData);
        return c.json({
          account_id: accountId,
          custom_uuid: existente.custom_uuid,
          puuid: riotData.puuid,
          gameName: riotData.gameName,
          tagLine: riotData.tagLine,
          region: existente.region,
          isNew: false,
          message: "✅ Jogador encontrado",
        });
      }

      const customUuid = crypto.randomUUID();
      await banco.inserirJogador({ customUuid, puuid: riotData.puuid, gameName: riotData.gameName, tagLine: riotData.tagLine, region: regiao, summonerId: riotData.summonerId });
      return c.json({
        account_id: accountId,
        custom_uuid: customUuid,
        puuid: riotData.puuid,
        gameName: riotData.gameName,
        tagLine: riotData.tagLine,
        region: regiao,
        isNew: true,
        message: "🎉 Jogador registrado com sucesso",
      });
    } catch (err) {
      console.error("[register]", err.status, err.corpo || err.message);
      if (err.status === 404) return c.json({ error: "Jogador não encontrado na Riot API" }, 404);
      if (err.status === 403) return c.json({ error: "API Key inválida ou sem permissão" }, 403);
      if (err.status === 401) return c.json({ error: "API Key inválida ou expirada" }, 401);
      if (err.status === 429) return c.json({ error: "Rate limit excedido" }, 429);
      return c.json({ error: "Erro interno: " + err.message }, 500);
    }
  });

  app.get("/api/player/:customUuid", async (c) => {
    try {
      const jogador = await banco.jogadorPorUuid(c.req.param("customUuid"));
      if (!jogador) return c.json({ error: "UUID não encontrado" }, 404);
      return c.json(jogador);
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ---------- Comando do bot ----------
  // :id = account_id (mesmo ID nos 3 jogos), ou o puuid real (compat. antiga),
  // ou ?nick=&tag=&region= / ?player=Nome#Tag&region=.
  async function comandoLol(c) {
    const template = cleanMsg(c.req.query("msg")) || TEMPLATE_PADRAO;
    const gameMode = (c.req.query("queue") || c.req.query("mode") || "lol_solo").toLowerCase();
    const lang = (c.req.query("lang") || "pt").toLowerCase();
    const en = lang === "en";

    const queryId = cleanMsg(c.req.param("id")) || cleanMsg(c.req.query("id")) || cleanMsg(c.req.query("puuid"));
    let queryNick = cleanMsg(c.req.query("nick")) || cleanMsg(c.req.query("gameName"));
    let queryTag = cleanMsg(c.req.query("tag")) || cleanMsg(c.req.query("tagLine"));
    const junto = cleanMsg(c.req.query("player")) || cleanMsg(c.req.query("riot"));
    if ((!queryNick || !queryTag) && junto) {
      const h = junto.lastIndexOf("#");
      if (h > 0 && h < junto.length - 1) {
        queryNick = junto.slice(0, h).trim();
        queryTag = junto.slice(h + 1).trim();
      } else if (!queryNick) {
        queryNick = junto;
      }
    }
    const queryRegion = (cleanMsg(c.req.query("region")) || "").toLowerCase();

    const responder = (msg, meta) => {
      if (querHtml(c)) return c.html(renderHtmlResult(msg, meta || { player: "—", tag: "—", region: "—", gameMode }));
      return texto(c, msg);
    };

    try {
      let player;

      if (queryId) {
        // Caminho A: account_id (ou puuid real), pela conta compartilhada.
        const acc = await banco.contaCompartilhada(queryId);
        if (acc) {
          const region = (queryRegion || acc.riot_region || mapValToRiot(acc.val_region) || "").toLowerCase();
          if (acc.riot_puuid && region && REGION_ROUTING[region]) {
            player = { puuid: acc.riot_puuid, gameName: acc.game_name, tagLine: acc.tag_line, region };
          } else if (acc.game_name && acc.tag_line && region && REGION_ROUTING[region]) {
            // Conta veio de outro jogo (Valorant): resolve o puuid do LoL agora.
            const riotData = await buscarContaRiot(riot, acc.game_name, acc.tag_line, region);
            await banco.vincularContaRiot({ riotPuuid: riotData.puuid, gameName: riotData.gameName, tagLine: riotData.tagLine, riotRegion: region });
            player = { puuid: riotData.puuid, gameName: riotData.gameName, tagLine: riotData.tagLine, region };
          } else {
            return responder(
              en ? "Account known from another game. Add the LoL region, e.g. ?region=br1" : "Conta conhecida em outro jogo. Informe a região do LoL, ex: ?region=br1"
            );
          }
        } else {
          // Compat. antiga: puuid real ainda só na lol_players.
          const j = await banco.jogadorPorPuuid(queryId);
          if (!j) {
            return responder(en ? `ID not registered. Search the player first at ${SITE}` : `ID não registrado. Busque o jogador primeiro em ${SITE}`);
          }
          player = { puuid: queryId, gameName: j.current_game_name, tagLine: j.current_tag_line, region: j.region };
          await banco.vincularContaRiot({ riotPuuid: player.puuid, gameName: player.gameName, tagLine: player.tagLine, riotRegion: player.region });
        }
      } else if (queryNick && queryTag && queryRegion) {
        // Caminho B: nick + tag + região.
        if (!REGION_ROUTING[queryRegion]) return responder(en ? "Invalid region" : "Região inválida");

        const j = await banco.jogadorPorNome(queryNick, queryTag, queryRegion);
        if (j) {
          player = { puuid: j.riot_puuid, gameName: j.current_game_name, tagLine: j.current_tag_line, region: j.region };
        } else {
          try {
            const riotData = await buscarContaRiot(riot, queryNick, queryTag, queryRegion);
            if (await banco.jogadorPorPuuid(riotData.puuid)) {
              await banco.atualizarJogador(riotData.puuid, riotData);
            } else {
              await banco.inserirJogador({ customUuid: crypto.randomUUID(), puuid: riotData.puuid, gameName: riotData.gameName, tagLine: riotData.tagLine, region: queryRegion, summonerId: riotData.summonerId });
            }
            player = { puuid: riotData.puuid, gameName: riotData.gameName, tagLine: riotData.tagLine, region: queryRegion };
          } catch (riotErr) {
            if (riotErr.status === 404) return responder(en ? "Player not found" : "Jogador não encontrado");
            if (riotErr.status === 429) return responder(en ? "Rate limit exceeded" : "Rate limit excedido");
            return responder(en ? "Error contacting Riot API" : "Erro ao consultar a Riot");
          }
        }
      } else {
        return responder(
          en ? "Missing parameters. Use /api/lol/cmd/PUUID or ?nick=...&tag=...&region=..." : "Parâmetros faltando. Use /api/lol/cmd/PUUID ou ?nick=...&tag=...&region=..."
        );
      }

      // Mantém a conta compartilhada atualizada (TFT e Valorant reconhecem o ID).
      await banco.vincularContaRiot({ riotPuuid: player.puuid, gameName: player.gameName, tagLine: player.tagLine, riotRegion: player.region });

      const ranked = await rankDoJogador(player.puuid, player.region, gameMode);
      const result = applyTemplate(template, player, ranked, gameMode, lang);
      return responder(result, { player: player.gameName, tag: player.tagLine, region: player.region, gameMode });
    } catch (err) {
      console.error("[cmd]", err.message);
      return texto(c, "Erro ao processar o comando");
    }
  }

  app.get("/api/lol/cmd/:id", comandoLol);
  app.get("/api/lol/cmd", comandoLol);
  app.get("/cmd/lol/:id", comandoLol);
  app.get("/cmd/lol", comandoLol);

  // ---------- Comandos salvos (formato antigo) ----------
  app.post("/api/command", async (c) => {
    const { custom_uuid, command_name, template, game_mode = "lol_solo" } = await lerCorpo(c);
    if (!custom_uuid || !command_name || !template) {
      return c.json({ error: "custom_uuid, command_name e template são obrigatórios" }, 400);
    }
    if (!["lol_solo", "lol_flex"].includes(game_mode)) return c.json({ error: "game_mode inválido" }, 400);
    try {
      if (!(await banco.jogadorPorUuid(custom_uuid))) return c.json({ error: "UUID não encontrado" }, 404);
      await banco.salvarComando({ customUuid: custom_uuid, nome: command_name, template, gameMode: game_mode });
      return c.json({ success: true, message: "Comando salvo" });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get("/api/command/:customUuid/:commandName", async (c) => {
    const { customUuid, commandName } = c.req.param();
    try {
      const cmd = await banco.comandoSalvo(customUuid, commandName);
      if (!cmd) return c.json({ error: "Comando não encontrado" }, 404);
      const player = await banco.jogadorPorUuid(customUuid);
      if (!player) return c.json({ error: "Jogador não encontrado" }, 500);
      const ranked = await rankDoJogador(player.riot_puuid, player.region, cmd.game_mode);
      const result = applyTemplate(
        cmd.template,
        { gameName: player.current_game_name, tagLine: player.current_tag_line, region: player.region },
        ranked,
        cmd.game_mode
      );
      return c.json({
        result,
        template: cmd.template,
        game_mode: cmd.game_mode,
        player: { gameName: player.current_game_name, tagLine: player.current_tag_line, uuid: player.custom_uuid },
        ranked,
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get("/cmd/:customUuid/:commandName", async (c) => {
    const { customUuid, commandName } = c.req.param();
    try {
      const cmd = await banco.comandoSalvo(customUuid, commandName);
      if (!cmd) return texto(c, "Comando não encontrado");
      const player = await banco.jogadorPorUuid(customUuid);
      if (!player) return texto(c, "Jogador não encontrado");
      const ranked = await rankDoJogador(player.riot_puuid, player.region, cmd.game_mode);
      return texto(
        c,
        applyTemplate(cmd.template, { gameName: player.current_game_name, tagLine: player.current_tag_line, region: player.region }, ranked, cmd.game_mode)
      );
    } catch (err) {
      console.error("[cmd antigo]", err.message);
      return texto(c, "Erro ao processar o comando");
    }
  });

  app.get("/api/commands/:customUuid", async (c) => {
    try {
      return c.json(await banco.listarComandos(c.req.param("customUuid")));
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.delete("/api/command/:customUuid/:commandName", async (c) => {
    try {
      await banco.apagarComando(c.req.param("customUuid"), c.req.param("commandName"));
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.notFound((c) => c.text("Não encontrado", 404));
  app.onError((err, c) => {
    console.error("[erro]", err.message);
    if (c.req.path.includes("/cmd")) return texto(c, "Erro ao processar o comando");
    return c.json({ error: "Erro interno" }, 500);
  });

  return app;
}
