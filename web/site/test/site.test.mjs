import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
execFileSync('node', ['build.mjs'], { cwd: root, stdio: 'ignore' });

const htmlFiles = (d) =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? (f === 'assets' ? [] : htmlFiles(p)) : f.endsWith('.html') ? [p] : [];
  });

const resolves = (href) => {
  const clean = href.split('#')[0].split('?')[0];
  if (!clean || clean === '/') return existsSync(join(dist, 'index.html'));
  return existsSync(join(dist, clean)) || existsSync(join(dist, clean + '.html'));
};

test('every internal link and asset resolves', () => {
  const bad = [];
  for (const file of htmlFiles(dist)) {
    const html = readFileSync(file, 'utf8');
    for (const m of html.matchAll(/(?:href|src)="(\/[^"]*)"/g)) if (!resolves(m[1])) bad.push(`${file.replace(dist, '')} -> ${m[1]}`);
  }
  assert.deepEqual(bad, []);
});

test('every page has a title, description, canonical and one h1', () => {
  for (const file of htmlFiles(dist)) {
    const html = readFileSync(file, 'utf8');
    const name = file.replace(dist, '');
    assert.match(html, /<title>[^<]+<\/title>/, name);
    assert.match(html, /<meta name="description" content="[^"]+">/, name);
    assert.match(html, /<link rel="canonical"/, name);
    assert.equal((html.match(/<h1[ >]/g) || []).length, 1, `${name}: exactly one h1`);
  }
});

test('sitemap lists every page except 404', () => {
  const sm = readFileSync(join(dist, 'sitemap.xml'), 'utf8');
  const pages = htmlFiles(dist).filter((f) => !f.endsWith('404.html'));
  assert.equal((sm.match(/<loc>/g) || []).length, pages.length);
});

test('no external scripts and github link present', () => {
  const home = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.doesNotMatch(home, /<script[^>]+src="https?:/);
  assert.match(home, /github\.com\/Kotti13\/Zoyra/);
});
