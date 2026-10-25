import { test } from "node:test";
import assert from "node:assert/strict";
import { criarApp } from "../src/app.js";
import { ErroRiot } from "../src/riot.js";
import { separarRiotId } from "../src/endpoints.js";

const LIGA = [
  { queueType: "RANKED_SOLO_5x5", tier: "DIAMOND", rank: "II", leaguePoints: 64, wins: 30, losses: 10 },
  { queueType: "RANKED_FLEX_SR", tier: "MASTER", rank: "I", leaguePoints: 120, wins: 5, losses: 5 },
];

// Conta as chamadas para provar que cada endpoint vai a um lugar só.
function falsos({ status, statusPlataforma } = {}) {
  const chamadas = [];
  const contas = new Map([["acc-1", { account_id: "acc-1", game_name: "asrus", tag_line: "BR1", riot_puuid: "P1", riot_region: "br1" }]]);
  contas.set("val-1", { account_id: "val-1", game_name: "asrus", tag_line: "BR1", val_puuid: "V1", val_region: "br" });
  const banco = {
    async garantirSchema() {
      chamadas.push("schema");
    },
    async ping() {
      chamadas.push("ping");
    },
    async contaCompartilhada(id) {
      chamadas.push("accounts");
      return contas.get(id) || null;
    },
    async vincularContaRiot() {
      chamadas.push("vincular");
      return "acc-1";
    },
  };
  const riot = {
    async contaPorRiotId(cluster, nome, tag) {
      chamadas.push(`conta:${cluster}`);
      if (status) throw new ErroRiot(status, "");
      if (`${nome}#${tag}`.toLowerCase() !== "asrus#br1") throw new ErroRiot(404, "");
      return { puuid: "P1", gameName: "asrus", tagLine: "BR1" };
    },
    async contaPorPuuid(_c, puuid) {
      chamadas.push("contaPuuid");
      if (puuid !== "P1") throw new ErroRiot(400, "");
      return { puuid, gameName: "asrus", tagLine: "BR1" };
    },
    async invocadorPorPuuid() {
      return { id: "S1" };
    },
    async ligaLol(region, puuid) {
      chamadas.push(`liga:${region}`);
      if (puuid !== "P1") throw new ErroRiot(400, "");
      return LIGA;
    },
    async statusPlataforma() {
      chamadas.push("statusRiot");
      if (statusPlataforma) throw new ErroRiot(statusPlataforma, "");
      return { incidents: [{ id: 1 }], maintenances: [] };
    },
  };
  return { app: criarApp({ banco, riot }), chamadas };
}

const txt = async (app, url) => (await app.request(url)).text();

test("separarRiotId separa no último #", () => {
  assert.deepEqual(separarRiotId("Nome Com #Espaço#BR1"), { nome: "Nome Com #Espaço", tag: "BR1" });
  assert.equal(separarRiotId("semtag"), null);
  assert.equal(separarRiotId("#x"), null);
});

test("/elo/nick: player=Nome#Tag e nick no caminho, sem tocar no banco", async () => {
  const { app, chamadas } = falsos();
  assert.equal(await txt(app, "/api/lol/elo/nick?player=asrus%23BR1&region=br1"), "asrus está Diamante 2 com 64 pontos");
  assert.deepEqual(chamadas, ["conta:americas", "liga:br1"]);
  assert.equal(await txt(app, "/api/lol/elo/nick/asrus/BR1?queue=lol_flex&msg=(rank) (lp)"), "Mestre 120");
  assert.equal(await txt(app, "/api/lol/elo/nick?nick=asrus&tag=BR1&lang=en&msg=(rank)"), "Diamond 2");
  assert.ok(!chamadas.includes("schema") && !chamadas.includes("accounts"));
  const res = await app.request("/api/lol/elo/nick/asrus/BR1");
  assert.equal(res.headers.get("cache-control"), "public, max-age=30");
});

test("/elo/nick: erros viram texto 200; JSON traz status", async () => {
  const { app } = falsos();
  assert.equal(await txt(app, "/api/lol/elo/nick?player=asrus"), "Use: !elo Nome#Tag");
  assert.equal(await txt(app, "/api/lol/elo/nick/x/y"), "Jogador não encontrado");
  assert.equal(await txt(app, "/api/lol/elo/nick/asrus/BR1?region=zz"), "Região inválida (ex.: region=br1)");
  const r = await app.request("/api/lol/elo/nick/x/y");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const j = await app.request("/api/lol/elo/nick/x/y?format=json");
  assert.equal(j.status, 404);
  assert.equal((await j.json()).ok, false);
  const { app: limitado } = falsos({ status: 429 });
  assert.equal(await txt(limitado, "/api/lol/elo/nick/asrus/BR1"), "Muitas consultas agora, tente em instantes");
});

test("/elo/nick?format=json devolve os campos separados", async () => {
  const { app } = falsos();
  const j = await (await app.request("/api/lol/elo/nick/asrus/BR1?format=json")).json();
  assert.equal(j.ok, true);
  assert.equal(j.rank, "Diamante 2");
  assert.equal(j.pontos, 64);
  assert.equal(j.winrate, 75);
  assert.equal(j.puuid, "P1");
  assert.equal(j.texto, "asrus está Diamante 2 com 64 pontos");
});

test("/elo/puuid: conta e liga direto na Riot", async () => {
  const { app, chamadas } = falsos();
  assert.equal(await txt(app, "/api/lol/elo/puuid/P1"), "asrus está Diamante 2 com 64 pontos");
  assert.deepEqual(chamadas.sort(), ["contaPuuid", "liga:br1"]);
  assert.equal(await txt(app, "/api/lol/elo/puuid/zzz"), "PUUID inválido");
});

test("/elo/id: uma leitura da accounts; conta do Valorant resolve o PUUID", async () => {
  const { app, chamadas } = falsos();
  assert.equal(await txt(app, "/api/lol/elo/id/acc-1?msg=(player) (rank)"), "asrus Diamante 2");
  assert.deepEqual(chamadas, ["accounts", "liga:br1"]);
  assert.equal(await txt(app, "/api/lol/elo/id/val-1?msg=(rank)"), "Diamante 2");
  assert.ok(chamadas.includes("vincular"));
  assert.equal(await txt(app, "/api/lol/elo/id/nada"), "ID não encontrado. Busque o jogador em elorank-games.com.br/rank-lol");
});

test("/puuid devolve só o PUUID (ou JSON)", async () => {
  const { app } = falsos();
  assert.equal(await txt(app, "/api/lol/puuid?player=asrus%23BR1"), "P1");
  const j = await (await app.request("/api/lol/puuid?player=asrus%23BR1&format=json")).json();
  assert.deepEqual([j.puuid, j.player, j.region], ["P1", "asrus", "br1"]);
  assert.equal(await txt(app, "/api/lol/puuid"), "Use: ?player=Nome%23Tag");
});

test("/status: JSON com banco e Riot; texto para o chat; 503 quando algo cai", async () => {
  const { app } = falsos();
  const r = await app.request("/api/lol/status");
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.ok, true);
  assert.equal(s.riot.incidentes, 1);
  assert.equal(await txt(app, "/api/lol/status?format=text"), "LoL API: online · Riot BR1: 1 incidente(s), 0 manutenção(ões) · banco OK");

  const { app: caido } = falsos({ statusPlataforma: 503 });
  const r2 = await caido.request("/api/lol/status");
  assert.equal(r2.status, 503);
  assert.equal((await r2.json()).riot.erro, "HTTP 503");
  assert.equal(await txt(caido, "/api/lol/status?format=text"), "LoL API: instável · Riot BR1: fora do ar · banco OK");
});

test("/elo/id aceita PUUID da Riot que não está na accounts (como o /cmd antigo)", async () => {
  const { app } = falsos();
  assert.equal(await txt(app, "/api/lol/elo/id/P1?msg=(player) (rank)"), "asrus Diamante 2");
});
