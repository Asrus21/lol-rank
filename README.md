# Rank LoL — asrus.app

Sistema web que gera **comandos customizados** para streamers da Twitch exibirem o próprio rank de **League of Legends** no chat, em tempo real, com elos traduzidos para o português. Os comandos são compatíveis com **StreamElements** (e qualquer bot que suporte `$(customapi ...)`).

Acessível em: **https://www.asrus.app/rank-lol**

---

## Como funciona

1. O streamer busca a conta dele por **Nick + Tag + Região** ou por um **UUID** já gerado anteriormente
2. O sistema cria um `custom_uuid` persistente vinculado ao `puuid` da Riot — esse UUID não muda mesmo que o jogador troque de nick ou tag
3. O streamer monta um template, ex: `(player) está (rank) com (pontos) pontos`
4. O sistema gera um link `$(customapi https://www.asrus.app/cmd/UUID/comando)` pronto pra colar no StreamElements
5. Quando alguém digita `!comando` no chat, o bot busca o link, recebe o texto com o rank atualizado e posta

---

## Arquitetura

```
┌──────────────────────────────────────────┐
│  Vercel — asrus.app                       │
│  • Landing (raiz)                         │
│  • Rewrites:                              │
│      /api/*  → Railway                    │
│      /cmd/*  → Railway                    │
│      /rank-lol/* → projeto rank-lol-tft   │
└──────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────┐
│  Vercel — rank-lol-tft                    │
│  Frontend estático (index.html)           │
│  Acessível em www.asrus.app/rank-lol      │
└──────────────────────────────────────────┘
                    ↓ fetch /api/* /cmd/*
┌──────────────────────────────────────────┐
│  Railway — lol-tft-rank-production        │
│  Backend Node.js + Express                │
│  • Consulta Riot API (Account + League)   │
│  • PostgreSQL para persistência           │
└──────────────────────────────────────────┘
```

---

## Stack

- **Backend:** Node.js 18+ · Express · PostgreSQL (Railway)
- **Frontend:** HTML/CSS/JS puro (Vercel, estático)
- **APIs Riot utilizadas:** `ACCOUNT-V1`, `SUMMONER-V4`, `LEAGUE-V4`
- **Hosting:** Vercel (frontend) + Railway (backend + Postgres)

---

## Estrutura do repositório

```
.
├── server.js              # Backend Express (Railway)
├── package.json
├── public/
│   └── index.html         # Frontend (Vercel - rank-lol-tft)
├── vercel.json            # Configuração do projeto Vercel
├── vercel-asrus-app.json  # Rewrites do projeto pai (asrus.app)
└── README.md
```

---

## Variáveis de ambiente (Railway)

| Variável | Descrição |
|---|---|
| `RIOT_API_KEY` | Personal API Key da Riot (obtida no portal de developers) |
| `DATABASE_URL` | Injetada automaticamente pelo PostgreSQL do Railway |
| `NODE_ENV` | `production` |
| `CORS_ORIGIN` | `https://www.asrus.app` |
| `PORT` | Injetada automaticamente pelo Railway |

> **Nota sobre Personal Key:** o produto está registrado na Riot com a Personal API Key cobrindo `ACCOUNT-V1`, `SUMMONER-V4` e `LEAGUE-V4`. Personal Keys têm rate limits superiores às Development Keys e não expiram a cada 24h.

---

## Rodar localmente

```bash
git clone <repositório>
cd <repositório>
npm install
cp .env.example .env
# Editar .env e preencher RIOT_API_KEY e DATABASE_URL
npm start
```

Abrir http://localhost:3000

---

## Endpoints da API

### `POST /api/register`
Busca um jogador por Riot ID e retorna o `custom_uuid`. Se for a primeira vez, gera um UUID novo; se já existir, retorna o existente e atualiza nick/tag.

```json
{ "gameName": "asrus", "tagLine": "BR1", "region": "br1" }
```

### `GET /api/player/:customUuid`
Retorna os dados do jogador a partir do UUID customizado.

### `POST /api/command`
Cria ou atualiza um template de comando.

```json
{
  "custom_uuid": "uuid-aqui",
  "command_name": "elo",
  "template": "(player) está (rank) com (pontos) pontos",
  "game_mode": "lol_solo"
}
```

### `GET /api/command/:customUuid/:commandName`
Executa o comando e retorna **JSON** (usado pelo frontend ao testar).

### `GET /cmd/:customUuid/:commandName`
Executa o comando e retorna **texto puro**. É o endpoint que o StreamElements chama via `$(customapi ...)`.

---

## Sintaxe dos templates

Aceita tanto parênteses quanto chaves. `(player)` e `{player}` funcionam igual.

### Variáveis disponíveis

**Geral:** `(player)` · `(tag)` · `(region)` · `(uuid)`

**Ranked:** `(rank)` · `(tier)` · `(divisao)` · `(pontos)` ou `(lp)`

**Estatísticas:** `(vitorias)` · `(derrotas)` · `(winrate)` · `(jogos)`

### Tradução de elos (português)

| API Riot | Exibido |
|---|---|
| IRON | Ferro |
| BRONZE | Bronze |
| SILVER | Prata |
| GOLD | Ouro |
| PLATINUM | Platina |
| EMERALD | Esmeralda |
| DIAMOND | Diamante |
| MASTER | Mestre |
| GRANDMASTER | Grão-Mestre |
| CHALLENGER | Desafiante |

Divisões aparecem em número: `I→1, II→2, III→3, IV→4`. Mestre, Grão-Mestre e Desafiante não exibem divisão.

### Filas suportadas

- `lol_solo` — Ranked Solo/Duo
- `lol_flex` — Ranked Flex

---

## Exemplos de uso no StreamElements

**Comando `!elo`:**

Template no painel:
```
(player) está (rank) com (pontos) pontos · (winrate) de winrate
```

Resposta no StreamElements:
```
$(customapi https://www.asrus.app/cmd/4270c04e-529b-4d07-8949-519923fc1828/elo)
```

No chat aparece:
```
asrus está Prata 2 com 50 pontos · 58% de winrate
```

---

## UUID persistente

O sistema gera um `custom_uuid` (UUID v4) vinculado ao `puuid` da Riot. O `puuid` é o identificador imutável que a Riot atribui à conta — ele **não muda** quando o jogador troca de nick ou tag. Aproveitando isso, o `custom_uuid` herda essa estabilidade.

**Na prática:** o streamer cria o comando uma vez no StreamElements e nunca mais precisa atualizar, mesmo trocando de nick.

---

## TFT (desativado)

O código tem suporte parcial a Teamfight Tactics, mas está **comentado** em blocos marcados como `// ===== TFT DESATIVADO =====` no `server.js`. Foi removido temporariamente porque a Personal API Key atual não cobre o escopo TFT. Para reativar:

1. Solicitar Personal API Key separada cobrindo TFT no portal da Riot
2. Descomentar os blocos no `server.js`
3. Atualizar o `index.html` para reincluir a aba TFT na interface

---

## Roadmap

- [ ] Implementar **RSO (Riot Sign-On)** — login OAuth oficial, exigência da Riot para mostrar dados de jogadores
- [ ] Reativar suporte a TFT (depende de Personal Key separada)
- [ ] Avaliar suporte a Valorant (requer Personal Key específica + RSO obrigatório)

---

## Deploy

### Backend (Railway)
1. Conectar o repositório no Railway
2. Adicionar serviço **PostgreSQL** no mesmo projeto
3. Configurar variáveis de ambiente
4. Generate Domain em Settings → Networking

### Frontend (Vercel — rank-lol-tft)
1. Conectar o repositório no Vercel
2. Output directory: `public`
3. Apontar como destino do rewrite `/rank-lol/*` no projeto pai

### Projeto pai (Vercel — asrus.app)
Configurar `vercel.json` com os rewrites:
```json
{
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://lol-tft-rank-production.up.railway.app/api/:path*" },
    { "source": "/cmd/:path*", "destination": "https://lol-tft-rank-production.up.railway.app/cmd/:path*" },
    { "source": "/rank-lol/:path*", "destination": "https://lol-tft-rank.vercel.app/:path*" }
  ]
}
```

---

## Disclaimer

asrus.app isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games and all associated properties are trademarks or registered trademarks of Riot Games, Inc.
