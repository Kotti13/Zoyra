import { SITE } from './data/features.mjs';

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// 24x24 stroke icons (paths only). Simple on purpose: one weight, round caps.
const P = {
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  lyrics: '<path d="M5 7h14M5 12h10M5 17h12"/>',
  video: '<rect x="3" y="6" width="14" height="12" rx="3"/><path d="m17 10 4-2.5v9L17 14"/>',
  download: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14"/>',
  eq: '<path d="M6 4v16M12 4v16M18 4v16"/><circle cx="6" cy="9" r="2"/><circle cx="12" cy="15" r="2"/><circle cx="18" cy="8" r="2"/>',
  car: '<path d="M4 15v-3l2-5h12l2 5v3zM4 15v3M20 15v3"/><circle cx="8" cy="15" r="1"/><circle cx="16" cy="15" r="1"/>',
  wave: '<path d="M4 12h2M8 8v8M12 5v14M16 8v8M20 12h-2"/>',
  compass: '<circle cx="12" cy="12" r="8"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  sparkle: '<path d="M12 4l1.8 4.7L18.5 10l-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.3zM18 16l.7 1.8 1.8.7-1.8.7L18 21l-.7-1.8-1.8-.7 1.8-.7z"/>',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  mix: '<path d="M4 7h4l8 10h4M4 17h4l2-2.5M14 9.5 16 7h4"/>',
  mic: '<rect x="9" y="4" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v3"/>',
  ticket: '<path d="M4 8a2 2 0 0 0 0 4v0a2 2 0 0 1 0 4v2h16v-2a2 2 0 0 1 0-4v0a2 2 0 0 0 0-4V6H4z"/><path d="M14 6v12" stroke-dasharray="2 2"/>',
  live: '<circle cx="12" cy="12" r="2.2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
  group: '<circle cx="9" cy="9" r="3"/><circle cx="17" cy="10" r="2.4"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M15 15.5a4.5 4.5 0 0 1 5.5 3.5"/>',
  family: '<circle cx="8" cy="8" r="2.5"/><circle cx="16" cy="8" r="2.5"/><circle cx="12" cy="15" r="2"/><path d="M4 18a4 4 0 0 1 8-1M12 17a4 4 0 0 1 8 1"/>',
  chat: '<path d="M5 6h14v9H10l-4 3.5V15H5z"/>',
  note: '<path d="M6 4h9l3 3v13H6z"/><path d="M9 11h6M9 15h4"/>',
  blend: '<circle cx="9.5" cy="12" r="5"/><circle cx="14.5" cy="12" r="5"/>',
  trophy: '<path d="M8 5h8v5a4 4 0 0 1-8 0zM8 7H5v1.5A3 3 0 0 0 8 11.5M16 7h3v1.5a3 3 0 0 1-3 3M12 14v4M9 19h6"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  phone: '<path d="M6 4h4l1.5 4-2 1.5a10 10 0 0 0 5 5L16 12.5l4 1.5v4a2 2 0 0 1-2 2A14 14 0 0 1 4 6a2 2 0 0 1 2-2z"/>',
  shield: '<path d="M12 4 5 7v5c0 4 3 6.5 7 8 4-1.5 7-4 7-8V7z"/><path d="m9 12 2 2 4-4"/>',
  palette: '<path d="M12 4a8 8 0 1 0 0 16c1.2 0 1.8-.8 1.4-1.8-.4-1 .2-2.2 1.3-2.2H17a3 3 0 0 0 3-3A8 8 0 0 0 12 4z"/><circle cx="8" cy="11" r="1"/><circle cx="11.5" cy="8" r="1"/><circle cx="15.5" cy="9.5" r="1"/>',
  user: '<circle cx="12" cy="9" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  heart: '<path d="M12 19s-7-4.3-7-9.5A3.8 3.8 0 0 1 12 7.8a3.8 3.8 0 0 1 7 1.7C19 14.7 12 19 12 19z"/>',
  access: '<circle cx="12" cy="6" r="1.8"/><path d="M5 9l7 1.5L19 9M12 10.5V15l-3 5M12 15l3 5"/>',
  game: '<rect x="3" y="8" width="18" height="9" rx="4"/><path d="M8 10.5v4M6 12.5h4M16 11.5h.01M18 13.5h.01"/>',
  link: '<path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1"/>',
  github: '<path d="M12 3.5a8.5 8.5 0 0 0-2.7 16.6c.4.1.6-.2.6-.4v-1.5c-2.4.5-2.9-1-2.9-1-.4-1-1-1.3-1-1.3-.8-.6.1-.6.1-.6.9.1 1.4.9 1.4.9.8 1.4 2.1 1 2.6.8.1-.6.3-1 .6-1.2-1.9-.2-3.9-1-3.9-4.2 0-.9.3-1.7.9-2.3-.1-.2-.4-1.1.1-2.3 0 0 .7-.2 2.4.9a8.3 8.3 0 0 1 4.4 0c1.7-1.1 2.4-.9 2.4-.9.5 1.2.2 2.1.1 2.3.6.6.9 1.4.9 2.3 0 3.2-2 4-3.9 4.2.3.3.6.8.6 1.6v2.3c0 .2.2.5.6.4A8.5 8.5 0 0 0 12 3.5z"/>',
  arrow: '<path d="M5 12h14m0 0-5-5m5 5-5 5"/>',
};

export const icon = (name, size = 22) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? P.play}</svg>`;

const NAV = [
  ['/features', 'Features'],
  ['/articles', 'Articles'],
  ['/open-source', 'Open source'],
  ['/privacy', 'Privacy'],
];

export function page({ path, title, description, body, ogType = 'website' }) {
  const url = SITE.host + (path === '/' ? '' : path);
  const full = path === '/' ? `${SITE.name}: ${SITE.tagline}` : `${title} · ${SITE.name}`;
  const desc = description || SITE.description;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#050505">
<link rel="canonical" href="${esc(url)}">
<link rel="icon" href="/assets/favicon.png">
<link rel="apple-touch-icon" href="/assets/icon.png">
<meta property="og:site_name" content="${SITE.name}">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${SITE.host}/assets/icon.png">
<meta name="twitter:card" content="summary">
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="nav">
  <div class="wrap nav-in">
    <a class="brand" href="/"><img src="/assets/icon.png" alt="" width="32" height="32"><span>Zoyra</span></a>
    <nav aria-label="Main" class="links">
      ${NAV.map(([h, l]) => `<a href="${h}"${path === h || (h !== '/' && path.startsWith(h + '/')) ? ' aria-current="page"' : ''}>${l}</a>`).join('')}
      <a class="gh" href="${SITE.github}" rel="noopener" aria-label="Zoyra on GitHub">${icon('github', 20)}<span>GitHub</span></a>
    </nav>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="foot">
  <div class="wrap foot-in">
    <div>
      <a class="brand" href="/"><img src="/assets/icon.png" alt="" width="28" height="28"><span>Zoyra</span></a>
      <p class="muted small">${SITE.tagline}.</p>
    </div>
    <nav aria-label="Footer" class="foot-links">
      <a href="/features">Features</a>
      <a href="/articles">Articles</a>
      <a href="/open-source">Open source</a>
      <a href="/privacy">Privacy</a>
      <a href="${SITE.github}" rel="noopener">GitHub</a>
    </nav>
  </div>
  <div class="wrap small muted foot-note">© ${new Date().getFullYear()} Zoyra. Built with care in the open.</div>
</footer>
<script src="/assets/site.js" defer></script>
</body>
</html>
`;
}

/** A CSS-drawn phone showing a stylised Now Playing screen, or a real screenshot when one exists. */
export function phone({ shot, track = 'Midnight Drive', artist = 'Zoyra Sessions', line = 'Follow every word as it plays' }) {
  const inner = shot
    ? `<img src="/assets/screens/${esc(shot)}" alt="Zoyra screenshot" loading="lazy">`
    : `<div class="ph-art"><span>♪</span></div>
       <div class="ph-title">${esc(track)}</div>
       <div class="ph-sub">${esc(artist)}</div>
       <div class="ph-lyric"><span class="dim">…and the city lights fade</span><b>${esc(line)}</b><span class="dim">Keep the volume up</span></div>
       <div class="ph-bar"><i></i></div>
       <div class="ph-ctl"><s></s><u></u><s></s></div>`;
  return `<div class="phone" role="img" aria-label="Zoyra now playing screen"><div class="ph-notch"></div><div class="ph-screen">${inner}</div></div>`;
}
