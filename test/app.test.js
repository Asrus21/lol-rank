import { test } from "node:test";
import assert from "node:assert/strict";
import { criarApp } from "../src/app.js";
import { ErroRiot } from "../src/riot.js";
import { applyTemplate, cleanMsg, entradaDaFila } from "../src/template.js";

// ---------- Falsos ----------

function bancoFalso() {
  const jogadores = []; // linhas lol_players
  const comandos = new Map(); // `${uuid}|${nome}` -> { template, game_mode }
  const contas = new Map();
  let seq = 0;
  const porPuuid = (p) => jogadores.find((j) => j.riot_puuid === p) || null;
  return {
    jogadores,
    contas,
    async garantirSchema() {},
    jogadorPorPuuid: async (p) => porPuuid(p),
    jogadorPorUuid: async (u) => jogadores.find((j) => j.custom_uuid === u) || null,
    jogadorPorNome: async (n, t, r) =>
      jogadores.find((j) => j.current_game_name.toLowerCase() === n.toLowerCase() && j.current_tag_line.toLowerCase() === t.toLowerCase() && j.region === r) || null,
    async inserirJogador({ customUuid, puuid, gameName, tagLine, region, summonerId }) {
      if (porPuuid(puuid)) throw new Error("duplicate key");
      jogadores.push({ custom_uuid: customUuid, riot_puuid: puuid, current_game_name: gameName, current_tag_line: tagLine, region, summoner_id: summonerId });
    },
    async atualizarJogador(puuid, { gameName, tagLine, summonerId }) {
      Object.assign(porPuuid(puuid), { current_game_name: gameName, current_tag_line: tagLine, summoner_id: summonerId });
    },
    async salvarComando({ customUuid, nome, template, gameMode }) {
      comandos.set(`${customUuid}|${nome}`, { template, game_mode: gameMode, command_name: nome });
    },
    comandoSalvo: async (u, n) => comandos.get(`${u}|${n}`) || null,
    listarComandos: async (u) => [...comandos.entries()].filter(([k]) => k.startsWith(`${u}|`)).map(([, v]) => v),
    async apagarComando(u, n) {
      comandos.delete(`${u}|${n}`);
    },
    async contaCompartilhada(id) {
      return contas.get(id) || [...contas.values()].find((a) => a.riot_puuid === id || a.val_puuid === id) || null;
    },
    async vincularContaRiot({ riotPuuid, gameName, tagLine, riotRegion }) {
      const acc = [...contas.values()].find((a) => a.riot_puuid === riotPuuid);
      if (acc) return acc.account_id;
      const id = `acc-${++seq}`;
      contas.set(id, { account_id: id, game_name: gameName, tag_line: tagLine, riot_puuid: riotPuuid, riot_region: riotRegion });
      return id;
    },
  };
}

const LIGA = [
  { queueType: "RANKED_SOLO_5x5", tier: "DIAMOND", rank: "II", leaguePoints: 64, wins: 30, losses: 10 },
  { queueType: "RANKED_FLEX_SR", tier: "MASTER", rank: "I", leaguePoints: 120, wins: 5, losses: 5 },
];

function riotFalso({ status } = {}) {
  const contas = { "asrus#BR1": { puuid: "P1", gameName: "asrus", tagLine: "BR1" } };
  return {
    async contaPorRiotId(_c, nome, tag) {
      if (status) throw new ErroRiot(status, "");
      const c = contas[`${nome}#${tag}`];
      if (!c) throw new ErroRiot(404, "");
      return c;
    },
    async invocadorPorPuuid() {
      return { id: "SUMM1" };
    },
    async ligaLol() {
      return LIGA;
    },
  };
}

const post = (app, url, corpo) => app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
const txt = async (app, url, headers) => (await app.request(url, { headers })).text();

async function registrado() {
  const banco = bancoFalso();
  const app = criarApp({ banco, riot: riotFalso() });
  const r = await (await post(app, "/api/register", { gameName: "asrus", tagLine: "BR1", region: "BR1" })).json();
  return { banco, app, r };
}

// ---------- Template ----------

test("template: solo, flex sem divisão, inglês, {var} e maiúsculas", () => {
  const p = { gameName: "asrus", tagLine: "BR1", region: "br1" };
  assert.equal(applyTemplate("(player) está (rank) com (pontos) pontos", p, entradaDaFila(LIGA, "lol_solo"), "lol_solo"), "asrus está Diamante 2 com 64 pontos");
  assert.equal(applyTemplate("{RANK} (lp) (winrate) (modo)", p, entradaDaFila(LIGA, "lol_flex"), "lol_flex"), "Mestre 120 50% LOL_FLEX");
  assert.equal(applyTemplate("(rank)", p, entradaDaFila(LIGA, "lol_solo"), "lol_solo", "en"), "Diamond 2");
  assert.equal(applyTemplate("(rank) (jogos)", p, null, "lol_solo"), "Sem rank 0");
  assert.equal(cleanMsg(" 'oi' "), "oi");
});

// ---------- Registro ----------

test("register: valida, mapeia erros da Riot, registra e reconhece", async () => {
  const banco = bancoFalso();
  const app = criarApp({ banco, riot: riotFalso() });
  assert.equal((await post(app, "/api/register", { gameName: "a" })).status, 400);
  assert.equal((await post(app, "/api/register", { gameName: "a", tagLine: "b", region: "xx" })).status, 400);
  assert.equal((await post(app, "/api/register", { gameName: "x", tagLine: "y", region: "br1" })).status, 404);
  for (const s of [401, 403, 429]) {
    const res = await post(criarApp({ banco, riot: riotFalso({ status: s }) }), "/api/register", { gameName: "a", tagLine: "b", region: "br1" });
    assert.equal(res.status, s);
  }

  const r1 = await (await post(app, "/api/register", { gameName: "asrus", tagLine: "BR1", region: "BR1" })).json();
  assert.deepEqual([r1.isNew, r1.account_id, r1.puuid, r1.region], [true, "acc-1", "P1", "br1"]);
  assert.equal(banco.jogadores[0].summoner_id, "SUMM1");
  const r2 = await (await post(app, "/api/register", { gameName: "asrus", tagLine: "BR1", region: "br1" })).json();
  assert.deepEqual([r2.isNew, r2.custom_uuid, r2.account_id], [false, r1.custom_uuid, "acc-1"]);

  assert.equal((await (await app.request(`/api/player/${r1.custom_uuid}`)).json()).riot_puuid, "P1");
  assert.equal((await app.request("/api/player/nada")).status, 404);
});

// ---------- Comando do bot ----------

test("comando por ID: account_id, puuid antigo, caminho legado, ID desconhecido", async () => {
  const { app } = await registrado();
  assert.equal(await txt(app, "/api/lol/cmd/acc-1"), "asrus está Diamante 2 com 64 pontos");
  assert.equal(await txt(app, '/cmd/lol/P1?msg="(rank) (lp)"&queue=lol_flex'), "Mestre 120");
  assert.equal(await txt(app, "/api/lol/cmd?id=acc-1&mode=LOL_FLEX&msg=(rank)"), "Mestre");
  assert.equal(await txt(app, "/api/lol/cmd/xyz"), "ID não registrado. Busque o jogador primeiro em elorank-games.com.br/rank-lol");
  assert.equal(await txt(app, "/api/lol/cmd/xyz?lang=en"), "ID not registered. Search the player first at elorank-games.com.br/rank-lol");
  const res = await app.request("/api/lol/cmd/acc-1");
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
});

test("comando: puuid antigo que só existe na lol_players ganha conta compartilhada", async () => {
  const banco = bancoFalso();
  banco.jogadores.push({ custom_uuid: "u0", riot_puuid: "OLD", current_game_name: "velho", current_tag_line: "BR1", region: "br1" });
  const app = criarApp({ banco, riot: riotFalso() });
  assert.equal(await txt(app, "/api/lol/cmd/OLD?msg=(player) (rank)"), "velho Diamante 2");
  assert.equal([...banco.contas.values()][0].riot_puuid, "OLD");
});

test("comando: conta vinda do Valorant resolve o puuid do LoL; sem região pede região", async () => {
  const banco = bancoFalso();
  banco.contas.set("val-1", { account_id: "val-1", game_name: "asrus", tag_line: "BR1", val_puuid: "V1", val_region: "br" });
  banco.contas.set("val-2", { account_id: "val-2", game_name: "x", tag_line: "y", val_puuid: "V2", val_region: "ap" });
  const app = criarApp({ banco, riot: riotFalso() });
  assert.equal(await txt(app, "/api/lol/cmd/val-1?msg=(player) (rank)"), "asrus Diamante 2");
  assert.equal(await txt(app, "/api/lol/cmd/val-2"), "Conta conhecida em outro jogo. Informe a região do LoL, ex: ?region=br1");
});

test("comando por nick/tag/região e por player=Nome#Tag", async () => {
  const banco = bancoFalso();
  const app = criarApp({ banco, riot: riotFalso() });
  assert.equal(await txt(app, "/api/lol/cmd?nick=asrus&tag=BR1&region=br1"), "asrus está Diamante 2 com 64 pontos");
  assert.equal(banco.jogadores.length, 1);
  assert.equal(await txt(app, "/cmd/lol?player=asrus%23BR1&region=br1&msg=(rank)"), "Diamante 2");
  assert.equal(banco.jogadores.length, 1);
  assert.equal(await txt(app, "/api/lol/cmd?nick=x&tag=y&region=br1"), "Jogador não encontrado");
  assert.equal(await txt(app, "/api/lol/cmd?nick=x&tag=y&region=zz"), "Região inválida");
  assert.match(await txt(app, "/api/lol/cmd"), /^Parâmetros faltando/);
  const app429 = criarApp({ banco: bancoFalso(), riot: riotFalso({ status: 429 }) });
  assert.equal(await txt(app429, "/api/lol/cmd?nick=x&tag=y&region=br1&lang=en"), "Rate limit exceeded");
});

test("comando no navegador vira página; ?format=text força texto", async () => {
  const { app } = await registrado();
  const html = await txt(app, "/api/lol/cmd/acc-1", { accept: "text/html,application/xhtml+xml" });
  assert.match(html, /<!doctype html>/);
  assert.match(html, /asrus está Diamante 2 com 64 pontos/);
  assert.match(html, /elorank-games\.com\.br\/rank-lol/);
  assert.equal(await txt(app, "/api/lol/cmd/acc-1?format=text", { accept: "text/html" }), "asrus está Diamante 2 com 64 pontos");
  // texto do jogador é escapado na página
  const esc = await txt(app, "/api/lol/cmd/acc-1?format=html&msg=<b>oi</b>");
  assert.match(esc, /&lt;b&gt;oi&lt;\/b&gt;/);
});

// ---------- Comandos salvos (formato antigo) ----------

test("comandos salvos: salvar, rodar (JSON e texto), listar e apagar", async () => {
  const { app, r } = await registrado();
  const u = r.custom_uuid;
  assert.equal((await post(app, "/api/command", { custom_uuid: u })).status, 400);
  assert.equal((await post(app, "/api/command", { custom_uuid: u, command_name: "elo", template: "x", game_mode: "aram" })).status, 400);
  assert.equal((await post(app, "/api/command", { custom_uuid: "nada", command_name: "elo", template: "x" })).status, 404);
  assert.equal((await (await post(app, "/api/command", { custom_uuid: u, command_name: "elo", template: "(player): (rank)" })).json()).success, true);

  const j = await (await app.request(`/api/command/${u}/elo`)).json();
  assert.equal(j.result, "asrus: Diamante 2");
  assert.equal(j.player.uuid, u);
  assert.equal(await txt(app, `/cmd/${u}/elo`), "asrus: Diamante 2");
  assert.equal(await txt(app, `/cmd/${u}/nada`), "Comando não encontrado");
  assert.equal((await app.request(`/api/command/${u}/nada`)).status, 404);
  assert.equal((await (await app.request(`/api/commands/${u}`)).json()).length, 1);
  await app.request(`/api/command/${u}/elo`, { method: "DELETE" });
  assert.equal((await (await app.request(`/api/commands/${u}`)).json()).length, 0);
});

test("Riot fora do ar no rank vira 'Sem rank'; erro inesperado no comando vira texto", async () => {
  const banco = bancoFalso();
  const riot = { ...riotFalso(), ligaLol: async () => { throw new ErroRiot(503, ""); } };
  const app = criarApp({ banco, riot });
  await post(app, "/api/register", { gameName: "asrus", tagLine: "BR1", region: "br1" });
  assert.equal(await txt(app, "/api/lol/cmd/acc-1?msg=(rank)"), "Sem rank");

  const quebrado = criarApp({ banco: { ...bancoFalso(), contaCompartilhada: async () => { throw new Error("db"); } }, riot: riotFalso() });
  const res = await quebrado.request("/api/lol/cmd/acc-1");
  assert.equal(await res.text(), "Erro ao processar o comando");
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
});
