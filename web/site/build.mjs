// Static site generator: no dependencies. Run `node build.mjs`; output goes to ./dist.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTICLES } from './src/data/articles.mjs';
import { GROUPS, HIGHLIGHTS, NUMBERS, SITE, STACK, STEPS } from './src/data/features.mjs';
import { DEV, NAME } from './src/data/about.mjs';
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

write(
  '/',
  page({
    path: '/',
    body: `
<section class="hero">
  <div class="wrap hero-in">
    <div class="hero-copy">
      <p class="eyebrow">The social music app</p>
      <h1>Music is <em>better</em> together.</h1>
      <p class="lead">Search and play any song, follow lyrics that keep up with you, go live with friends, and share real links that open the app. Dark, fast and private by design.</p>
      <div class="cta">
        <a class="btn primary" href="/features">Explore features ${icon('arrow', 18)}</a>
        <a class="btn" href="/download">${icon('download', 18)} Download for Android</a>
        <a class="btn" href="${SITE.github}" rel="noopener">${icon('github', 18)} View on GitHub</a>
      </div>
      <ul class="pills"><li>iPhone and Android</li><li>Synced lyrics</li><li>Live rooms</li><li>End-to-end encrypted chats</li></ul>
    </div>
    <div class="hero-art">${phone({})}</div>
  </div>
</section>

<section class="wrap sec">
  <div class="grid3">${HIGHLIGHTS.map(card).join('')}</div>
</section>

<section class="wrap sec">
  <div class="name-strip">
    <p class="eyebrow">The name</p>
    <p class="name-line"><span>Zoya</span> <i>+</i> <span>Aura</span> <i>=</i> <b>Zoyra</b></p>
    <p class="muted">${esc(NAME.together)} <a class="more inline" href="/articles/why-zoyra">The story ${icon('arrow', 14)}</a></p>
  </div>
</section>

<section class="wrap sec">
  <div class="forever-band">
    <div>
      <p class="eyebrow gold">Forever</p>
      <h2 class="h2">A promise between two people<span class="inf"> ∞</span></h2>
      <p class="lead2">For the one or two people you never want to lose touch with. A gold ring, a shared vault, calls that always get through, and a reminder when it has been a year.</p>
      <a class="btn gold" href="/forever">Meet Forever ${icon('arrow', 18)}</a>
    </div>
    <div class="ring" aria-hidden="true"><span>∞</span></div>
  </div>
</section>

<section class="wrap sec">
  <h2 class="h2">How it works</h2>
  <ol class="steps">${STEPS.map((s) => `<li><span class="n">${s.n}</span><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></li>`).join('')}</ol>
</section>

${gallery}

<section class="wrap sec">
  <div class="split">
    <div>
      <h2 class="h2">Everything in one place</h2>
      <p class="lead2">Listening, discovering, chatting, calling and sharing, in one app that looks the same from the first screen to the last.</p>
      <ul class="ticks">${GROUPS.map((g) => `<li><a href="/features#${g.id}"><b>${esc(g.title)}</b> <span>${esc(g.blurb)}</span></a></li>`).join('')}</ul>
    </div>
    <div class="stats">${NUMBERS.map((n) => `<div><b>${esc(n.value)}</b><span>${esc(n.label)}</span></div>`).join('')}</div>
  </div>
</section>

<section class="wrap sec">
  <div class="head-row"><h2 class="h2">Read about it</h2><a class="more" href="/articles">All articles ${icon('arrow', 16)}</a></div>
  <div class="grid3">${ARTICLES.slice(0, 3).map(articleCard).join('')}</div>
</section>

<section class="wrap sec">
  <div class="band">
    <div>
      <h2 class="h2">Open on GitHub</h2>
      <p class="lead2">The app, the backend and this website live in one public repository. Read it, run it, or send a fix.</p>
    </div>
    <a class="btn primary" href="${SITE.github}" rel="noopener">${icon('github', 18)} Kotti13/Zoyra</a>
  </div>
</section>`,
  }),
);

function articleCard(a) {
  return `<a class="card art-card" href="/articles/${a.slug}"><span class="tag">${esc(a.tag)}</span><h3>${esc(a.title)}</h3><p>${esc(a.summary)}</p><span class="meta">${fmtDate(a.date)} · ${a.minutes} min read</span></a>`;
}

// ------------------------------------------------------------------ features
write(
  '/features',
  page({
    path: '/features',
    title: 'Features',
    description: 'Everything Zoyra can do: listen, discover, listen together, message and call, and make the app your own.',
    body: `
<section class="wrap page-head">
  <p class="eyebrow">Features</p>
  <h1>Everything Zoyra can do</h1>
  <p class="lead">Grouped the way the app groups it. Tap a section to jump.</p>
  <nav class="chips" aria-label="Sections">${GROUPS.map((g) => `<a href="#${g.id}">${esc(g.title)}</a>`).join('')}</nav>
</section>
${GROUPS.map(
  (g) => `<section class="wrap sec" id="${g.id}">
  <div class="sec-head"><h2 class="h2">${esc(g.title)}</h2><p class="muted">${esc(g.blurb)}</p></div>
  <div class="grid3">${g.items.map(card).join('')}</div>
</section>`,
).join('\n')}
<section class="wrap sec"><div class="band"><div><h2 class="h2">Built on a small, honest stack</h2><p class="lead2">${STACK.map((s) => esc(s.name)).join(', ')}.</p></div><a class="btn" href="/articles/how-zoyra-is-built">How it is built ${icon('arrow', 18)}</a></div></section>`,
  }),
);

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
write(
  '/forever',
  page({
    path: '/forever',
    title: 'Forever',
    description: 'Forever is Zoyra’s feature for love: a promise between two people, with a gold ring, a shared vault and calls that always get through.',
    body: `
<section class="forever-hero">
  <div class="wrap fh-in">
    <p class="eyebrow gold">Forever</p>
    <h1>${esc(FOREVER.tagline)} <span class="inf">∞</span></h1>
    <p class="lead">${esc(FOREVER.lead)}</p>
    <div class="cta"><a class="btn gold" href="/articles/forever-a-promise-in-an-app">Read why we made it ${icon('arrow', 18)}</a><a class="btn" href="/features">All features</a></div>
  </div>
</section>

<section class="wrap sec">
  <h2 class="h2">What you get</h2>
  <div class="grid3 gold-cards">${FOREVER.perks.map(card).join('')}</div>
</section>

<section class="wrap sec">
  <h2 class="h2">How it works</h2>
  <ol class="steps four gold-steps">${FOREVER.steps.map((s) => `<li><span class="n">${s.n}</span><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></li>`).join('')}</ol>
</section>

<section class="wrap sec">
  <div class="quote"><p>“A song is the message. The person who gets it is the point.”</p></div>
</section>

<section class="wrap sec">
  <h2 class="h2">Good to know</h2>
  <div class="faq">${FOREVER.faq.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div>
</section>

<section class="wrap sec">
  <div class="forever-band">
    <div><h2 class="h2">Say it with a song</h2><p class="lead2">Forever lives inside Zoyra, next to the player, the lyrics and your chats.</p></div>
    <a class="btn gold" href="/features">Explore the app ${icon('arrow', 18)}</a>
  </div>
</section>`,
  }),
);

// ------------------------------------------------------------------ about
write(
  '/about',
  page({
    path: '/about',
    title: 'About',
    description: 'Why the app is called Zoyra (Zoya + Aura), and who builds it.',
    body: `
<section class="wrap page-head">
  <p class="eyebrow">About</p>
  <h1>The name, and the person</h1>
</section>

<section class="wrap sec">
  <div class="name-strip big">
    <p class="eyebrow">The name</p>
    <p class="name-line"><span>Zoya</span> <i>+</i> <span>Aura</span> <i>=</i> <b>Zoyra</b></p>
    <div class="name-cols">
      <div><h3>Zoya</h3><p class="muted">${esc(NAME.zoya)}</p></div>
      <div><h3>Aura</h3><p class="muted">${esc(NAME.aura)}</p></div>
      <div><h3>Zoyra</h3><p class="muted">${esc(NAME.together)}</p></div>
    </div>
  </div>
</section>

<section class="wrap sec">
  <div class="dev">
    <div class="dev-card">
      <div class="avatar" aria-hidden="true">KS</div>
      <h2>${esc(DEV.name)}</h2>
      <p class="muted">${esc(DEV.role)}</p>
      <ul class="facts">${DEV.facts.map((f) => `<li><span>${esc(f.k)}</span><b>${esc(f.v)}</b></li>`).join('')}</ul>
      <div class="cta">
        <a class="btn" href="${DEV.github}" rel="noopener">${icon('github', 18)} GitHub</a>
        <a class="btn" href="${DEV.portfolio}" rel="noopener">${icon('link', 18)} Portfolio</a>
      </div>
    </div>
    <div class="dev-copy">
      <h2 class="h2">Hi, I am ${esc(DEV.name)}</h2>
      ${DEV.bio.map((t) => `<p>${esc(t)}</p>`).join('')}
      <p><a class="more" href="/open-source">See how it is built ${icon('arrow', 16)}</a></p>
    </div>
  </div>
</section>`,
  }),
);


// ------------------------------------------------------------------ download
const APK = `${SITE.github}/releases/latest/download/zoyra.apk`;
write(
  '/download',
  page({
    path: '/download',
    title: 'Download',
    description: 'Download the latest Zoyra Android test build (APK) and see how to install it.',
    body: `
<section class="wrap page-head">
  <p class="eyebrow">Download</p>
  <h1>Get Zoyra on Android</h1>
  <p class="lead">This is the newest test build, published automatically every time the app changes. It is not on the Play Store yet.</p>
</section>

<section class="wrap sec">
  <div class="dl" id="dl">
    <div class="dl-main">
      <div class="dl-ico"><img src="/assets/icon.png" alt="" width="72" height="72"></div>
      <div>
        <h2>Zoyra for Android</h2>
        <p class="muted" id="dl-meta">Latest APK for Android phones</p>
      </div>
    </div>
    <a class="btn primary big" id="dl-btn" href="${APK}" rel="noopener">${icon('download', 20)} Download APK</a>
    <p class="small muted" id="dl-note">The download starts from GitHub Releases. If it says “not found”, the first build has not finished yet.</p>
  </div>
</section>

<section class="wrap sec">
  <h2 class="h2">Install in four steps</h2>
  <ol class="steps four">
    <li><span class="n">1</span><h3>Download</h3><p>Tap the button above on your Android phone. Your browser may warn that APK files can be harmful. That is normal for apps outside the Play Store.</p></li>
    <li><span class="n">2</span><h3>Allow the install</h3><p>When asked, allow your browser to “install unknown apps” for this one install. You can turn it off again afterwards.</p></li>
    <li><span class="n">3</span><h3>Open the file</h3><p>Tap the downloaded file, then <b>Install</b>.</p></li>
    <li><span class="n">4</span><h3>Sign up and play</h3><p>Pick your genres, languages and artists, then search a song. To update later, download the newest build again.</p></li>
  </ol>
</section>

<section class="wrap sec">
  <div class="grid3">
    <article class="card"><div class="ico">${icon('shield')}</div><h3>Check the source</h3><p>The app is built from the public repository, by GitHub, in the open. Anyone can read the code and the build recipe.</p></article>
    <article class="card"><div class="ico">${icon('phone')}</div><h3>iPhone</h3><p>There is no iPhone download yet. iOS builds need Apple’s store or TestFlight, which are not set up for Zoyra.</p></article>
    <article class="card"><div class="ico">${icon('github')}</div><h3>All builds</h3><p>Older builds and notes are on the <a href="${SITE.github}/releases" rel="noopener">releases page</a>.</p></article>
  </div>
</section>`,
  }),
);

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
write(
  '/privacy',
  page({
    path: '/privacy',
    title: 'Privacy',
    description: 'A plain summary of what Zoyra stores, what it shares, and the controls you have.',
    body: `
<article class="wrap prose">
  <p class="eyebrow">Privacy</p>
  <h1>Privacy in plain words</h1>
  <p class="lead">This is a plain summary of how the app treats your data. It is not a legal contract.</p>
  <h2>What the app keeps</h2>
  <ul>
    <li>Your account (email or sign-in provider) and profile, held in the project’s database.</li>
    <li>What you choose to create: playlists, comments, community posts, notes and stories.</li>
    <li>Your settings, such as theme, genres, languages and privacy choices.</li>
  </ul>
  <h2>What is private</h2>
  <ul>
    <li>Chats can be end-to-end encrypted, so the server cannot read them.</li>
    <li>Private playlists and profiles are not shown on share links or to visitors.</li>
    <li>You can block people, limit who can message you, and control last-seen and read receipts.</li>
  </ul>
  <h2>Sharing links</h2>
  <p>A share link shows only what the owner has made public, such as a song, a public playlist, a public profile or a live room. Link pages are served by a site that has read-only access to those public items.</p>
  <h2>Crash reports</h2>
  <p>Crash reporting is off unless the app is built with it enabled. When on, it sends technical details without personal information, and strips everything after the question mark in web addresses.</p>
  <h2>Your choices</h2>
  <ul>
    <li>Turn on two-factor sign-in.</li>
    <li>Delete your account from inside the app.</li>
    <li>Change who can see your profile and activity in Settings.</li>
  </ul>
  <h2>Questions</h2>
  <p>Open an issue on <a href="${SITE.github}/issues" rel="noopener">GitHub</a>.</p>
</article>`,
  }),
);

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
