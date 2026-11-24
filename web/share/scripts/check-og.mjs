#!/usr/bin/env node
// Validate Open Graph / Twitter card tags.
//   node scripts/check-og.mjs https://share.zoyra.site/t/<id> [more urls…]
// Also imported by the tests (validateOg).

const REQUIRED_OG = ['og:title', 'og:description', 'og:image', 'og:url', 'og:type', 'og:site_name'];
const REQUIRED_TW = ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'];

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** @returns {{ tags: Record<string,string>, canonical: string | null, errors: string[] }} */
export function validateOg(html) {
  const tags = {};
  for (const m of html.matchAll(/<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"\s*\/?>/g)) {
    if (!(m[1] in tags)) tags[m[1]] = decode(m[2]);
  }
  const canonical = /<link rel="canonical" href="([^"]+)">/.exec(html)?.[1] ?? null;
  const errors = [];
  for (const k of [...REQUIRED_OG, ...REQUIRED_TW]) if (!tags[k]) errors.push(`missing ${k}`);
  for (const k of ['og:image', 'twitter:image', 'og:url']) if (tags[k] && !/^https:\/\//.test(tags[k])) errors.push(`${k} must be absolute https: ${tags[k]}`);
  if (tags['twitter:card'] && !['summary', 'summary_large_image'].includes(tags['twitter:card'])) errors.push(`bad twitter:card ${tags['twitter:card']}`);
  if (tags['og:title'] && tags['og:title'].length > 95) errors.push('og:title longer than 95 chars');
  if (tags['og:description'] && tags['og:description'].length > 200) errors.push('og:description longer than 200 chars');
  if (!canonical) errors.push('missing canonical link');
  else if (tags['og:url'] && decode(canonical) !== tags['og:url']) errors.push('canonical and og:url differ');
  if (!/^<!doctype html>/i.test(html.trimStart())) errors.push('missing doctype');
  // WhatsApp only reads roughly the first 300 KB of the page; keep meta near the top.
  const head = html.indexOf('</head>');
  if (head < 0 || head > 300_000) errors.push('</head> missing or too far down');
  return { tags, canonical, errors };
}

async function main(urls) {
  let failed = false;
  for (const url of urls) {
    // Pretend to be a link-preview bot (WhatsApp/Facebook) like the real scrapers.
    const res = await fetch(url, { headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' } });
    const html = await res.text();
    const { tags, errors } = validateOg(html);
    console.log(`\n${url}  →  HTTP ${res.status}  cache: ${res.headers.get('cache-control')}`);
    for (const k of ['og:type', 'og:title', 'og:description', 'og:image', 'twitter:card']) console.log(`  ${k.padEnd(16)} ${tags[k] ?? '—'}`);
    if (tags['og:image']) {
      const img = await fetch(tags['og:image'], { method: 'HEAD' }).catch(() => null);
      if (!img?.ok) errors.push(`og:image not reachable (${img?.status ?? 'network error'})`);
      else if (!/^image\//.test(img.headers.get('content-type') ?? '')) errors.push(`og:image content-type ${img.headers.get('content-type')}`);
    }
    if (errors.length) {
      failed = true;
      for (const e of errors) console.log(`  ✗ ${e}`);
    } else console.log('  ✓ OG / Twitter tags look good');
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error('usage: node scripts/check-og.mjs <url> [url…]');
    process.exit(2);
  }
  main(urls);
}
