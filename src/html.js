// Página que aparece quando alguém abre o link do comando no navegador (o bot
// recebe texto puro). Mesmo visual do resto do elorank-games.com.br.

const escapar = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const DS = "https://elorank-games.com.br/ds";

export function renderHtmlResult(result, meta) {
  const fila = (meta.gameMode || "").replace("lol_", "").toUpperCase();
  return `<!doctype html>
<html lang="pt-BR" data-jogo="lol">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rank LoL — ${escapar(meta.player)}</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="#040506">
<link rel="icon" href="https://elorank-games.com.br/favicon.svg" type="image/svg+xml">
<script src="${DS}/elorank.js?v=4"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap">
<link rel="stylesheet" href="${DS}/elorank.css?v=3">
<style>
  main { min-height: 100vh; display: grid; place-items: center; padding: var(--s3) var(--gutter); position: relative; isolation: isolate; }
  .cartao { width: 100%; max-width: 560px; display: grid; gap: var(--s2); text-align: center; justify-items: center; padding: var(--s4) var(--s3); }
  .jogador { margin: 0; color: var(--text-2); }
  .jogador strong { color: var(--text); font-weight: 500; }
  .resultado { width: 100%; margin: 0; padding: var(--s3) var(--s2); border-radius: 12px; background: var(--recessed);
    box-shadow: inset 0 0 0 1px var(--badge), inset 3px 0 0 var(--accent); font-size: 22px; font-weight: 500; line-height: 1.4; word-wrap: break-word; }
  .rodape { margin: 0; font-size: 13px; color: var(--text-3); line-height: 1.6; }
  .rodape a { color: var(--text-2); text-decoration: underline; text-underline-offset: 3px; white-space: nowrap; }
</style>
</head>
<body>
<main>
  <div class="er-atmos" aria-hidden="true"></div>
  <div class="er-card cartao">
    <span class="er-badge er-badge-dot">League of Legends</span>
    <p class="jogador"><strong>${escapar(meta.player)}</strong>#${escapar(meta.tag)}</p>
    <p class="resultado">${escapar(result)}</p>
    <div class="er-meta"><span>${escapar((meta.region || "").toUpperCase())}</span><span>${escapar(fila)}</span></div>
    <p class="rodape">Visualização do comando no navegador · gerado em
      <a href="https://elorank-games.com.br/rank-lol">elorank-games.com.br/rank-lol</a><br>
      O StreamElements e outros bots recebem só o texto.</p>
  </div>
</main>
</body>
</html>`;
}
