// Static site generator: no dependencies. Run `node build.mjs`; output goes to ./dist.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTICLES } from './src/data/articles.mjs';
import { GROUPS, HIGHLIGHTS, NUMBERS, SITE, STACK, STEPS } from './src/data/features.mjs';
import { FOREVER } from './src/data/forever.mjs';
import { esc, icon, page, phone } from './src/layout.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const pub = join(root, 'public');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(pub, dist, { recursive: true });

const shots = existsSync(join(pub, 'assets/screens'))
  ? readdirSync(join(pub, 'assets/screens')).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort()
  : [];

const out = [];
const write = (path, html) => {
  const file = path === '/' ? join(dist, 'index.html') : join(dist, path.replace(/^\//, '') + '.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  out.push(path);
};

const fmtDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const card = (f) => `<article class="card"><div class="ico">${icon(f.icon)}</div><h3>${esc(f.title)}</h3><p>${esc(f.text)}</p></article>`;

// ------------------------------------------------------------------ home
const gallery = shots.length
  ? `<section class="wrap sec" id="screens"><h2 class="h2">See it</h2><div class="shots">${shots.map((s) => phone({ shot: s })).join('')}</div></section>`
  : '';


function articleCard(a) {
  return `<a class="card art-card" href="/articles/${a.slug}"><span class="tag">${esc(a.tag)}</span><h3>${esc(a.title)}</h3><p>${esc(a.summary)}</p><span class="meta">${fmtDate(a.date)} · ${a.minutes} min read</span></a>`;
}

// ------------------------------------------------------------------ features

// ------------------------------------------------------------------ articles
write(
  '/articles',
  page({
    path: '/articles',
    title: 'Articles',
    description: 'How Zoyra works, why it is built the way it is, and what is inside.',
    body: `
<section class="wrap page-head">
  <p class="eyebrow">Articles</p>
  <h1>How Zoyra works</h1>
  <p class="lead">Short reads on the product, the engineering and the privacy choices behind it.</p>
</section>
<section class="wrap sec"><div class="grid3">${ARTICLES.map(articleCard).join('')}</div></section>`,
  }),
);

const block = (b) => {
  if (b.h) return `<h2>${esc(b.h)}</h2>`;
  if (b.p) return `<p>${esc(b.p)}</p>`;
  if (b.ul) return `<ul>${b.ul.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
  if (b.code) return `<pre><code>${esc(b.code)}</code></pre>`;
  return '';
};

ARTICLES.forEach((a, i) => {
  const next = ARTICLES[(i + 1) % ARTICLES.length];
  write(
    `/articles/${a.slug}`,
    page({
      path: `/articles/${a.slug}`,
      title: a.title,
      description: a.summary,
      ogType: 'article',
      body: `
<article class="wrap prose">
  <a class="back" href="/articles">← All articles</a>
  <span class="tag">${esc(a.tag)}</span>
  <h1>${esc(a.title)}</h1>
  <p class="meta">${fmtDate(a.date)} · ${a.minutes} min read</p>
  <p class="lead">${esc(a.summary)}</p>
  ${a.body.map(block).join('\n')}
  <hr>
  <p class="next">Next: <a href="/articles/${next.slug}">${esc(next.title)}</a></p>
</article>`,
    }),
  );
});


// ------------------------------------------------------------------ forever

// ------------------------------------------------------------------ about

// ------------------------------------------------------------------ download
const APK = `${SITE.github}/releases/latest/download/zoyra.apk`;

// ------------------------------------------------------------------ open source
write(
  '/open-source',
  page({
    path: '/open-source',
    title: 'Open source',
    description: 'Where the Zoyra code lives, how it is organised, and how to run it.',
    body: `
<section class="wrap page-head">
  <p class="eyebrow">Open source</p>
  <h1>The code is public</h1>
  <p class="lead">Everything lives in one repository: the phone app, the music backend, the share-link site and this website.</p>
  <div class="cta"><a class="btn primary" href="${SITE.github}" rel="noopener">${icon('github', 18)} github.com/Kotti13/Zoyra</a></div>
</section>
<section class="wrap sec">
  <h2 class="h2">What is where</h2>
  <div class="grid3">
    <article class="card"><h3><code>src/app</code></h3><p>Every screen of the app, as an Expo Router file.</p></article>
    <article class="card"><h3><code>services/gateway</code></h3><p>The Python API the app talks to: search, streaming, lyrics, downloads.</p></article>
    <article class="card"><h3><code>services/newpipe</code></h3><p>The Java service that finds songs and audio streams.</p></article>
    <article class="card"><h3><code>supabase</code></h3><p>Database migrations and server functions.</p></article>
    <article class="card"><h3><code>web/share</code></h3><p>Share-link pages with preview cards and app-link files.</p></article>
    <article class="card"><h3><code>web/site</code></h3><p>This website, generated by a small script with no dependencies.</p></article>
  </div>
</section>
<section class="wrap sec">
  <h2 class="h2">Run it</h2>
  <div class="code-card"><pre><code>git clone ${SITE.github}.git
cd Zoyra
npm install
npx expo start</code></pre></div>
  <p class="muted">The backend, hosting and launch steps are written up in <code>services/HOSTING.md</code> and <code>LAUNCH.md</code> in the repository.</p>
</section>
<section class="wrap sec">
  <h2 class="h2">The stack</h2>
  <div class="grid3">${STACK.map((s) => `<article class="card"><h3>${esc(s.name)}</h3><p>${esc(s.text)}</p></article>`).join('')}</div>
</section>`,
  }),
);

// ------------------------------------------------------------------ privacy


// ------------------------------------------------------------------ pages built from the Claude Design canvas (src/design/*.html)
// Each file: <!--title:…--> then the page's own <style> then its markup. Converted from the canvas with the placeholders filled in.
const FONTS = 'https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap';
function designPage(path, slug, description, ogType = 'website') {
  const raw = readFileSync(join(root, 'src/design', slug + '.html'), 'utf8');
  const title = /^<!--title:(.*?)-->/.exec(raw)[1];
  const inner = raw.replace(/^<!--title:.*?-->\n/, '');
  const url = SITE.host + (path === '/' ? '' : path);
  write(
    path,
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#050505">
<link rel="canonical" href="${esc(url)}">
<link rel="icon" href="/assets/favicon.png">
<link rel="apple-touch-icon" href="/assets/icon.png">
<meta property="og:site_name" content="${SITE.name}">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${SITE.host}/assets/icon.png">
<meta name="twitter:card" content="summary">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="${FONTS}">
<style>body{margin:0;background:#050505}</style>
${inner.replace(/<\/style>\n/, '</style>\n</head>\n<body>\n')}
<script src="/assets/design.js" defer></script>
</body>
</html>
`,
  );
}

designPage('/', 'home', SITE.description);
designPage('/features', 'features', 'Eight things that make Zoyra feel different, from the player to the people you share it with.');
designPage('/forever', 'forever', 'Forever: an opt-in, permanent bond between two people, with a gold ring, a shared streak and a private vault.');
designPage('/developer', 'developer', 'Kottai Samy, the software engineer who designed and built Zoyra.');
designPage('/download', 'download', 'Install the Zoyra Android app directly. Updates arrive inside the app.');
designPage('/privacy', 'privacy', 'A plain-language summary of what Zoyra stores, what stays on your device, and the controls you have.');
designPage('/articles/songs-we-couldnt-say-out-loud', 'story', 'On love, courage, and the three minutes and forty seconds it takes to tell someone how you feel without saying a word.', 'article');

// ------------------------------------------------------------------ 404, sitemap, robots
writeFileSync(
  join(dist, '404.html'),
  page({
    path: '/404',
    title: 'Page not found',
    body: `<section class="wrap page-head"><p class="eyebrow">404</p><h1>That page took a different track</h1><p class="lead">The page you wanted is not here.</p><div class="cta"><a class="btn primary" href="/">Back home</a></div></section>`,
  }),
);
writeFileSync(
  join(dist, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${out
    .map((p) => `  <url><loc>${SITE.host}${p === '/' ? '' : p}</loc></url>`)
    .join('\n')}\n</urlset>\n`,
);
writeFileSync(join(dist, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE.host}/sitemap.xml\n`);

console.log(`Built ${out.length} pages into dist/: ${out.join(', ')}`);
