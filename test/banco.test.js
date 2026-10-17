// Testa o SQL de verdade (src/banco.js) contra um Postgres. Só roda com
// TEST_DATABASE_URL apontando para um banco DESCARTÁVEL — as tabelas são
// apagadas no começo. Ex.:
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { criarApp } from "../src/app.js";
import { criarBanco } from "../src/banco.js";
import { ErroRiot } from "../src/riot.js";

const URL_TESTE = process.env.TEST_DATABASE_URL;
const pular = !URL_TESTE && "defina TEST_DATABASE_URL para testar o SQL";

let pool;
let q;

before(async () => {
  if (pular) return;
  pool = new pg.Pool({ connectionString: URL_TESTE });
  q = (texto, params = []) => pool.query(texto, params).then((r) => r.rows);
  await q("DROP TABLE IF EXISTS custom_commands, lol_players, accounts");
});
after(async () => pool?.end());

const riot = {
  async contaPorRiotId(_c, nome, tag) {
    if (`${nome}#${tag}`.toLowerCase() !== "asrus#br1") throw new ErroRiot(404, "");
    return { puuid: "P1", gameName: "asrus", tagLine: "BR1" };
  },
  async invocadorPorPuuid() {
    return { id: "S1" };
  },
  async ligaLol() {
    return [{ queueType: "RANKED_SOLO_5x5", tier: "GOLD", rank: "IV", leaguePoints: 10, wins: 1, losses: 3 }];
  },
};

const post = (app, url, corpo) => app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });

test("fluxo completo com o SQL real", { skip: pular }, async () => {
  const banco = criarBanco(q);
  const app = criarApp({ banco, riot });
  await banco.garantirSchema();
  await criarBanco(q).garantirSchema(); // idempotente

  const r1 = await (await post(app, "/api/register", { gameName: "asrus", tagLine: "BR1", region: "br1" })).json();
  assert.equal(r1.isNew, true);
  const r2 = await (await post(app, "/api/register", { gameName: "asrus", tagLine: "BR1", region: "br1" })).json();
  assert.equal(r2.isNew, false);
  assert.equal(r2.account_id, r1.account_id);

  // comando por account_id, por nick (achado no banco, sem duplicar) e legado
  assert.equal(await (await app.request(`/api/lol/cmd/${r1.account_id}`)).text(), "asrus está Ouro 4 com 10 pontos");
  assert.equal(await (await app.request("/api/lol/cmd?nick=ASRUS&tag=br1&region=br1&msg=(rank)")).text(), "Ouro 4");
  assert.equal((await q("SELECT count(*)::int AS n FROM lol_players"))[0].n, 1);

  // comandos salvos (FK com lol_players, upsert, lista e apagar)
  await post(app, "/api/command", { custom_uuid: r1.custom_uuid, command_name: "elo", template: "a (rank)" });
  await post(app, "/api/command", { custom_uuid: r1.custom_uuid, command_name: "elo", template: "b (rank)", game_mode: "lol_flex" });
  assert.equal(await (await app.request(`/cmd/${r1.custom_uuid}/elo`)).text(), "b Sem rank");
  const lista = await (await app.request(`/api/commands/${r1.custom_uuid}`)).json();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].game_mode, "lol_flex");
  await app.request(`/api/command/${r1.custom_uuid}/elo`, { method: "DELETE" });
  assert.equal((await (await app.request(`/api/commands/${r1.custom_uuid}`)).json()).length, 0);

  // conta que só existia no Valorant
  await q("INSERT INTO accounts (account_id, game_name, tag_line, val_puuid, val_region) VALUES ('val-1','asrus','BR1','V1','br')");
  await q("UPDATE accounts SET riot_puuid = NULL, game_name = 'outro' WHERE account_id = $1", [r1.account_id]);
  assert.equal(await (await app.request("/api/lol/cmd/val-1?msg=(player) (rank)")).text(), "asrus Ouro 4");
});
