// Server-rendered HTML: Open Graph + Twitter card meta for link previews, and a small landing page
// (cover, title, "Open in Zoyra", store buttons) in the app's dark red look.
import { createHash } from 'node:crypto';

export const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const clip = (s, n) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n - 1).trimEnd()}…` : v;
};

// Android: turn the zoyra:// button into an intent:// link that falls back to the Play Store.
// Static text → its CSP hash is constant (no 'unsafe-inline').
const SCRIPT = `(function(){var d=document,ua=navigator.userAgent||'';var b=d.getElementById('open');if(b&&/Android/i.test(ua)&&b.dataset.intent){b.href=b.dataset.intent;}var i=d.getElementById('ios'),a=d.getElementById('android');if(/iPhone|iPad|iPod/i.test(ua)&&a)a.classList.add('dim');if(/Android/i.test(ua)&&i)i.classList.add('dim');var u=location.href.split('#')[0],t=d.title;var c=d.getElementById('copy'),s=d.getElementById('share');function flash(el,m){var l=el.querySelector('span'),o=l.textContent;l.textContent=m;el.classList.add('ok');setTimeout(function(){l.textContent=o;el.classList.remove('ok');},1600);}if(c)c.addEventListener('click',function(){var done=function(){flash(c,'Link copied');};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(u).then(done,function(){});}else{var x=d.createElement('textarea');x.value=u;x.style.position='fixed';x.style.opacity='0';d.body.appendChild(x);x.select();try{d.execCommand('copy');done();}catch(e){}d.body.removeChild(x);}});if(s&&navigator.share){s.hidden=false;s.addEventListener('click',function(){navigator.share({title:t,url:u}).catch(function(){});});}})();`;
const SCRIPT_HASH = `sha256-${createHash('sha256').update(SCRIPT).digest('base64')}`;

export const CSP = [
  "default-src 'none'",
  "img-src https: data:",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  `script-src '${SCRIPT_HASH}'`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const STYLE = `
:root{--bg:#050505;--card:rgba(255,255,255,.045);--line:rgba(255,255,255,.1);--text:#f5f5f5;--muted:#a1a1aa;--accent:#FA2D48;--accent2:#ff5a5f}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
body{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;overflow-x:hidden}
.bg{position:fixed;inset:-15%;z-index:0;background-size:cover;background-position:center;filter:blur(70px) saturate(1.5);opacity:.4;transform:scale(1.1)}
.bg:after{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at 50% 0%,rgba(250,45,72,.3),transparent 60%),linear-gradient(180deg,rgba(5,5,5,.15),var(--bg) 80%)}
header{position:relative;z-index:1;width:100%;max-width:960px;padding:18px 20px 0;display:flex;align-items:center;gap:10px}
header img{width:34px;height:34px;border-radius:10px;box-shadow:0 4px 18px rgba(250,45,72,.45)}
header b{font-weight:800;letter-spacing:-.02em;font-size:19px}
header a{margin-left:auto;font-size:13px;font-weight:600;color:var(--text);text-decoration:none;border:1px solid var(--line);background:var(--card);padding:8px 14px;border-radius:999px}
main{position:relative;z-index:1;width:100%;max-width:960px;padding:26px 20px 36px;display:flex;flex-direction:column;align-items:center;gap:22px;flex:1;justify-content:center}
.panel{width:100%;max-width:440px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:16px;padding:26px 20px 22px;border-radius:32px;background:var(--card);border:1px solid var(--line);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);box-shadow:0 30px 90px rgba(0,0,0,.55)}
.art{position:relative;width:min(68vw,280px);aspect-ratio:1}
.art:before{content:"";position:absolute;inset:8% 6% -6%;border-radius:28px;background:var(--accent);filter:blur(36px);opacity:.45}
.cover{position:relative;width:100%;height:100%;border-radius:26px;object-fit:cover;background:#151515;box-shadow:0 0 0 1px var(--line);animation:rise .6s cubic-bezier(.2,.8,.2,1) both}
.cover.round{border-radius:50%}
.label{font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#fff;background:linear-gradient(135deg,var(--accent),#8e0b14);padding:6px 12px;border-radius:999px}
h1{font-size:clamp(24px,6.5vw,32px);font-weight:800;letter-spacing:-.03em;line-height:1.15;overflow-wrap:anywhere}
.sub{font-size:16px;color:var(--muted);font-weight:500;overflow-wrap:anywhere;margin-top:-6px}
.meta{display:flex;flex-wrap:wrap;justify-content:center;gap:8px}
.meta span{font-size:13px;color:#d4d4d8;border:1px solid var(--line);background:rgba(255,255,255,.04);padding:6px 11px;border-radius:999px}
.desc{font-size:14px;color:var(--muted);line-height:1.55;max-width:380px;overflow-wrap:anywhere}
.btn{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;min-height:52px;border-radius:999px;font-weight:700;font-size:16px;text-decoration:none;transition:transform .15s ease,opacity .15s,background .15s;font-family:inherit;cursor:pointer;border:0;color:inherit}
.btn:active{transform:scale(.98)}
.btn:focus-visible{outline:2px solid #fff;outline-offset:3px}
.primary{background:var(--accent);color:#fff;box-shadow:0 12px 34px rgba(250,45,72,.5)}
.primary:hover{background:#f01a25}
.row{display:flex;gap:10px;width:100%}
.ghost{flex:1;min-height:48px;border:1px solid var(--line);background:rgba(255,255,255,.06);color:var(--text);font-size:14px;font-weight:600}
.ghost:hover{background:rgba(255,255,255,.11)}
.ghost.ok{border-color:#34d399;color:#34d399}
.ghost[hidden]{display:none}
.store.dim{opacity:.5}
.hint{font-size:12px;color:#71717a}
.ring{width:120px;height:120px;border-radius:50%;display:grid;place-items:center;font-size:30px;font-weight:800;letter-spacing:-.03em;background:conic-gradient(var(--accent) calc(var(--pct)*1%),rgba(255,255,255,.08) 0);position:relative}
.ring:before{content:"";position:absolute;inset:9px;border-radius:50%;background:#101010}
.ring b{position:relative}
.stat{width:100%;display:flex;flex-direction:column;gap:8px;text-align:left}
.stat h2{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.stat ol{list-style:none;display:flex;flex-direction:column;gap:6px}
.stat li{font-size:14px;padding:10px 14px;border-radius:16px;background:rgba(255,255,255,.05);border:1px solid var(--line);overflow-wrap:anywhere}
.bar{display:flex;flex-direction:column;gap:5px;font-size:13px}
.bar i{display:block;height:8px;border-radius:4px;background:rgba(255,255,255,.08);overflow:hidden}
.bar i u{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,var(--accent),var(--accent2))}
.bar span{display:flex;justify-content:space-between;color:#d4d4d8}
.perks{display:flex;flex-wrap:wrap;justify-content:center;gap:10px 18px;font-size:13px;color:var(--muted);font-weight:500}
.perks i{font-style:normal;color:var(--accent2);margin-right:6px}
footer{position:relative;z-index:1;padding:0 16px 28px;font-size:12px;color:#52525b;text-align:center}
footer a{color:#71717a}
@keyframes rise{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.cover{animation:none}}
@media (min-width:820px){main{padding-top:40px}.panel{max-width:460px;padding:32px 28px 26px}}
`;

const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">';

const APPLE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.37 12.6c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.47.83-.72 0-1.82-.81-3-.79-1.54.02-2.96.9-3.75 2.27-1.6 2.78-.41 6.88 1.15 9.13.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.78.74 2.99.72 1.23-.02 2.01-1.12 2.77-2.23.87-1.28 1.23-2.52 1.25-2.58-.03-.01-2.39-.92-2.41-3.65zM14.1 5.86c.63-.77 1.06-1.83.94-2.89-.91.04-2.02.61-2.67 1.37-.58.67-1.1 1.76-.96 2.8 1.02.08 2.06-.52 2.69-1.28z"/></svg>';
const PLAY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.6 1.8 13.8 12 3.6 22.2c-.4-.2-.6-.6-.6-1.1V2.9c0-.5.2-.9.6-1.1zm11.6 8.8 2.6 1.4-2.6 1.4L13.1 12l2.1-1.4zM5 1l10.4 6-2 2L5 1zm0 22 8.4-8 2 2L5 23zm14.5-12.2 2.6 1.5c.8.5.8 1.6 0 2.1l-2.6 1.5L17.3 12l2.2-1.2z"/></svg>';

/**
 * @param {import('./data.js').Card} card
 * @param {ReturnType<import('./config.js').readConfig>} cfg
 * @param {{ path: string }} opts  path = canonical path, e.g. "/t/abc"
 */
export function renderCard(card, cfg, { path }) {
  const host = cfg.publicHost;
  const url = `${host}${path}`;
  const img = card.image?.url ?? `${host}/og-default.png`;
  const imgW = card.image ? card.image.width : 1200;
  const imgH = card.image ? card.image.height : 630;
  const imgAlt = card.image?.alt ?? 'Zoyra';
  const pageTitle = clip(card.subtitle && card.kind !== 'u' && card.kind !== 'ar' ? `${card.title} · ${card.subtitle}` : card.title, 90);
  const ogTitle = clip(card.title, 90);
  const desc = clip(card.description, 200);
  const deep = `${cfg.appScheme}://${card.appPath}`;
  const intent = `intent://${card.appPath}#Intent;scheme=${cfg.appScheme};package=${cfg.androidPackage};S.browser_fallback_url=${encodeURIComponent(url)};end`;
  const round = card.kind === 'u' || card.kind === 'ar';

  const meta = [
    ['og:site_name', 'Zoyra'],
    ['og:type', card.ogType],
    ['og:title', ogTitle],
    ['og:description', desc],
    ['og:url', url],
    ['og:image', img],
    ['og:image:secure_url', img],
    ...(imgW && imgH ? [['og:image:width', String(imgW)], ['og:image:height', String(imgH)]] : []),
    ['og:image:alt', imgAlt],
    ['og:locale', 'en_US'],
    ...card.extraMeta,
  ];
  const twitter = [
    ['twitter:card', 'summary_large_image'],
    ['twitter:title', ogTitle],
    ['twitter:description', desc],
    ['twitter:image', img],
    ['twitter:image:alt', imgAlt],
  ];

  const stores = [
    cfg.appStoreUrl ? `<a id="ios" class="btn ghost store" href="${esc(cfg.appStoreUrl)}" rel="noopener">${APPLE}App Store</a>` : '',
    `<a id="android" class="btn ghost store" href="${esc(cfg.playStoreUrl)}" rel="noopener">${PLAY}Google Play</a>`,
  ].join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(pageTitle)} | Zoyra</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">
${card.noindex ? '<meta name="robots" content="noindex,nofollow">' : ''}
<meta name="theme-color" content="#050505">
<meta name="color-scheme" content="dark">
${meta.map(([k, v]) => `<meta property="${esc(k)}" content="${esc(v)}">`).join('\n')}
${twitter.map(([k, v]) => `<meta name="${esc(k)}" content="${esc(v)}">`).join('\n')}
${/id(\d+)/.test(cfg.appStoreUrl) ? `<meta name="apple-itunes-app" content="app-id=${/id(\d+)/.exec(cfg.appStoreUrl)[1]}, app-argument=${esc(url)}">` : ''}
<link rel="icon" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
${FONTS}
<style>${STYLE}</style>
</head>
<body>
<div class="bg" style="background-image:url('${esc(img)}')"></div>
<header><img src="/icon.png" alt="" width="34" height="34"><b>Zoyra</b><a href="/">What is Zoyra?</a></header>
<main>
<section class="panel">
${card.ring != null ? `<div class="ring" style="--pct:${Number(card.ring) || 0}" role="img" aria-label="${Number(card.ring) || 0} percent match"><b>${Number(card.ring) || 0}%</b></div>` : ''}
<div class="art"${card.ring != null ? ' hidden' : ''}><img class="cover${round ? ' round' : ''}" src="${esc(img)}" alt="${esc(imgAlt)}" width="280" height="280" decoding="async" fetchpriority="high"></div>
<p class="label">${esc(card.label)}</p>
<h1>${esc(card.title)}</h1>
${card.subtitle ? `<p class="sub">${esc(card.subtitle)}</p>` : ''}
${card.meta.length > 1 || (card.meta.length === 1 && card.meta[0] !== card.subtitle) ? `<div class="meta">${card.meta.filter((m) => m && m !== card.subtitle).map((m) => `<span>${esc(m)}</span>`).join('')}</div>` : ''}
<p class="desc">${esc(desc)}</p>
${card.bars?.length ? `<div class="stat">${card.bars.map((b) => `<div class="bar"><span><b>${esc(b.n)}</b><em>${Number(b.p) || 0}%</em></span><i><u style="width:${Math.max(2, Math.min(100, Number(b.p) || 0))}%"></u></i></div>`).join('')}</div>` : ''}
${card.songs?.length ? `<div class="stat"><h2>${esc(card.songsTitle ?? 'Highlights')}</h2><ol>${card.songs.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></div>` : ''}
<a id="open" class="btn primary" href="${esc(deep)}" data-intent="${esc(intent)}">Open in Zoyra</a>
<div class="row"><button id="copy" type="button" class="btn ghost"><span>Copy link</span></button><button id="share" type="button" class="btn ghost" hidden><span>Share</span></button></div>
<div class="row">${stores}</div>
<p class="hint">Don’t have Zoyra yet? Get it free, then tap Open in Zoyra.</p>
</section>
<p class="perks"><span><i>●</i>Synced lyrics</span><span><i>●</i>Listen together</span><span><i>●</i>Free to start</span></p>
</main>
<footer>Shared from Zoyra · <a href="/">zoyra</a></footer>
<script>${SCRIPT}</script>
</body>
</html>`;
}

/** 404 / unavailable page (still has a neutral Zoyra preview card). */
export function renderMessage(cfg, { title, body, path = '/', status = 404, label, index = false }) {
  const card = {
    kind: 'msg',
    ogType: 'website',
    label: label ?? (status === 404 ? 'Not found' : 'Unavailable'),
    title,
    subtitle: '',
    description: body,
    image: null,
    meta: [],
    extraMeta: [],
    noindex: !index,
    appPath: '',
    cache: 'user',
  };
  return renderCard(card, cfg, { path });
}
