// Worker do Rank LoL (elorank-games.com.br/rank-lol).
//
// - Página (public/): servida direto pela Cloudflare (Workers Static Assets).
// - API (/api/*, /cmd/*): src/app.js.
//
// Segredos (Settings → Variables and Secrets): RIOT_API_KEY e DATABASE_URL — a
// MESMA DATABASE_URL (Neon) do TFT e do Valorant, por causa da tabela accounts.
import { neon } from "@neondatabase/serverless";
import { criarApp } from "./app.js";
import { criarBanco } from "./banco.js";
import { criarRiot } from "./riot.js";

let cache = null;

// Monta banco + Riot uma vez por instância (e de novo se os segredos mudarem).
function app(env) {
  const chave = `${env.DATABASE_URL}|${env.RIOT_API_KEY}`;
  if (!cache || cache.chave !== chave) {
    const url = env.DATABASE_URL || env.POSTGRES_URL;
    const sql = url ? neon(url) : null;
    const q = (texto, params = []) => {
      if (!sql) throw new Error("DATABASE_URL não configurada");
      return sql.query(texto, params);
    };
    cache = { chave, app: criarApp({ banco: criarBanco(q), riot: criarRiot(env.RIOT_API_KEY) }) };
  }
  return cache.app;
}

// Tudo que não é página é API: /api/* e /cmd/* (inclui o antigo /cmd/UUID/NOME).
const API = /^\/(api|cmd)(\/|$)/;

// Endpoints de um comando só que vão para o cache de borda (30s, ver
// CACHE_OK em endpoints.js). O mesmo !elo repetido no chat nem chega à Riot.
const CACHEAVEL = /^\/api\/lol\/(elo|puuid)(\/|$)/;

// Chave sempre no host público: não importa se veio direto, pelo gateway ou
// pelo api.elorank-games.com.br.
const chaveCache = (url) => new Request(`https://elorank-games.com.br/__cache/rank-lol${url.pathname}${url.search}`);

async function comCache(request, ctx, responder) {
  const url = new URL(request.url);
  const cache = request.method === "GET" && CACHEAVEL.test(url.pathname) && typeof caches !== "undefined" ? caches.default : null;
  if (!cache) return responder();

  const guardada = await cache.match(chaveCache(url)).catch(() => null);
  if (guardada) {
    const r = new Response(guardada.body, guardada);
    r.headers.set("X-Edge-Cache", "HIT");
    return r;
  }
  const resposta = await responder();
  if (resposta.status === 200 && /max-age=\d+/.test(resposta.headers.get("Cache-Control") || "") && !/no-store/.test(resposta.headers.get("Cache-Control"))) {
    ctx.waitUntil(cache.put(chaveCache(url), resposta.clone()).catch((e) => console.warn("[borda]", e?.message || e)));
  }
  return resposta;
}

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    // Normalmente a Cloudflare já entrega os arquivos de public/ antes de
    // chegar aqui. Mas a chamada pode vir do gateway (Service Binding): aí
    // entregamos a página explicitamente, para não depender desse detalhe.
    if (!API.test(pathname) && env.ASSETS) return env.ASSETS.fetch(request);
    return comCache(request, ctx, () => app(env).fetch(request, env, ctx));
  },
};
