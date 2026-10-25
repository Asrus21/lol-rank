# Rank LoL — EloRank Games

Rank de **League of Legends** de qualquer jogador e comando pronto para o chat
da live (StreamElements). Endereço: **https://elorank-games.com.br/rank-lol**

Roda em **Cloudflare Workers**. O gateway do domínio (repositório
`elorank-games`) repassa `/rank-lol`, as APIs (`/api/lol/*`, `/api/register`,
`/api/player/*`, `/api/command*`), os comandos (`/cmd/lol/*`, `/cmd/UUID/NOME`) e
`api.elorank-games.com.br/lol/*` para este Worker.

## Estrutura

```
src/
  index.js     entrada do Worker (monta banco Neon + Riot com os segredos)
  app.js       rotas (Hono) — as mesmas do servidor antigo
  banco.js     SQL: lol_players, custom_commands e accounts (compartilhada)
  riot.js      API da Riot (conta, invocador, liga) e regiões
  template.js  monta o texto do comando (funções puras)
  html.js      página do comando quando aberto no navegador
public/
  index.html   página (design system EloRank: /ds/elorank.css)
test/          testes (npm test)
wrangler.jsonc configuração do Worker
server.js      servidor ANTIGO (Express na Vercel) — ver "Transição"
```

## Rotas

| Rota | O que faz |
|---|---|
| `POST /api/register` | `{ gameName, tagLine, region }` → registra e devolve o ID EloRank (`account_id`) |
| `GET /api/player/:uuid` | Dados do jogador |
| `GET /api/lol/cmd/:id` | Comando do bot. `:id` = ID EloRank ou puuid antigo |
| `GET /api/lol/cmd?nick=&tag=&region=` | Comando por nick (também `?player=Nome%23Tag`) |
| `GET /cmd/lol/...` | O mesmo, caminho antigo |
| `GET /cmd/:uuid/:nome` | Comando salvo no formato antigo (texto) |
| `POST /api/command` · `GET /api/command/:uuid/:nome` · `GET /api/commands/:uuid` · `DELETE /api/command/:uuid/:nome` | Comandos salvos (formato antigo) |

Parâmetros do comando: `msg` (template; aspas externas são removidas), `queue`
ou `mode` (`lol_solo`, `lol_flex`), `lang` (`pt`, `en`), `region`. Aberto no
navegador, o comando mostra uma página; bots recebem texto puro
(`?format=text` / `?format=html` forçam um ou outro).

Comando gerado pelo site:
```
$(customapi https://api.elorank-games.com.br/lol/cmd/ID?region=br1&msg="(player) está (rank) com (pontos) pontos"&queue=lol_solo&lang=pt)
```

Variáveis: `(player)` `(tag)` `(region)` · `(rank)` `(tier)` `(divisao)`
`(pontos)` `(lp)` · `(vitorias)` `(derrotas)` `(winrate)` `(jogos)` — também
`{var}`, sem diferenciar maiúsculas.

## Endpoints de um comando só

Cada comando do bot chama um endereço que faz uma coisa só (`src/endpoints.js`;
documentação pública em **elorank-games.com.br/docs**).

| Rota | O que faz | Busca em |
|---|---|---|
| `GET /api/lol/elo/nick?player=Nome%23Tag` (ou `/elo/nick/Nome/Tag`) | Elo pelo nick | Riot (sem banco) |
| `GET /api/lol/elo/puuid/:puuid` | Elo pelo PUUID | Riot (sem banco) |
| `GET /api/lol/elo/id/:id` | Elo pelo ID EloRank | 1 leitura da `accounts` + Riot |
| `GET /api/lol/puuid?player=Nome%23Tag` | Só o PUUID | Riot |
| `GET /api/lol/status` | Saúde da API, do banco e da Riot (`?format=text` para o chat) | banco + da Riot |

Parâmetros: `region` (br1 padrão), `msg`, `format=json`, `queue` (lol_solo, lol_flex), `lang`. Texto sai sempre
com status 200 (o bot imprime até o erro); respostas boas ficam em cache curto.

```
${customapi https://api.elorank-games.com.br/lol/elo/nick?player=${queryescape ${1:}}&region=br1}
```

## Publicar (Cloudflare)

1. **Workers & Pages → Create → Import a repository** → `Asrus21/lol-rank`.
   O nome do Worker precisa ser **`rank-lol`**. Comando de deploy:
   `npx wrangler deploy`.
2. **Settings → Variables and Secrets**, como *Secret*: `RIOT_API_KEY` e
   `DATABASE_URL` (a mesma do TFT e do Valorant).
3. No repositório `elorank-games`, ative o binding `RANK_LOL`.

## Desenvolvimento

```sh
npm install
npm test          # rotas e template (banco e Riot falsos)
npm run check     # valida o build do Worker
npx wrangler dev  # local; segredos em .dev.vars (não vai para o git)
```

SQL de verdade contra um Postgres descartável:
`TEST_DATABASE_URL=postgres://... npm test` (as tabelas são apagadas).

## Transição

`server.js` + `vercel.json` são o servidor antigo, ainda publicado na Vercel
(`lol-tft-rank.vercel.app`). Os comandos de bot antigos (`api.asrus.app/lol/...`,
`asrus.app/cmd/...`, `asrus.app/api/...`) dependem dele. Quando o `asrus.app`
passar a repassar esses caminhos para o domínio novo, apague `server.js`,
`vercel.json` e as dependências do Express, e desligue o projeto na Vercel.

## Aviso

EloRank Games não é endossado pela Riot Games e não reflete as opiniões da Riot
Games ou de quem está envolvido oficialmente com seus produtos. Riot Games,
League of Legends e todas as marcas associadas são marcas registradas da Riot
Games, Inc.
