// node --test test/   (no network: fetch is mocked)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appleAppSiteAssociation, assetLinks, handleShare } from '../lib/handler.js';
import { validateOg } from '../scripts/check-og.mjs';

const ENV = {
  PUBLIC_HOST: 'https://zoyra-share.vercel.app',
  SUPABASE_URL: 'https://abc.supabase.co',
  SUPABASE_ANON_KEY: 'eyJ.anon.key',
  APPLE_TEAM_ID: 'ABCDE12345',
  ANDROID_SHA256_FINGERPRINTS: `${'AB:'.repeat(31)}CD, not-a-fingerprint`,
};

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const ART = { '150x150': 'https://cdn.audius.test/a/150.jpg', '480x480': 'https://cdn.audius.test/a/480.jpg', '1000x1000': 'https://cdn.audius.test/a/1000.jpg' };

/** Routes → responses. Records calls so we can assert what was (not) requested. */
function mockFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [re, fn] of routes) if (re.test(String(url))) return fn(String(url), init);
    return new Response('not found', { status: 404 });
  };
  f.calls = calls;
  return f;
}

test('track: Audius song renders a full rich card', async () => {
  const f = mockFetch([
    [/api\.audius\.co\/v1\/tracks\/D7KyD\?app_name=zoyra/, () => json({ data: { id: 'D7KyD', title: ' Midnight <Drive> ', duration: 225, genre: 'Electronic', play_count: 10, artwork: ART, user: { name: 'Nova & Co', handle: 'nova' } } })],
  ]);
  const r = await handleShare({ kind: 't', id: 'D7KyD' }, ENV, f);
  assert.equal(r.status, 200);
  assert.match(r.headers['Cache-Control'], /s-maxage=3600/);
  assert.match(r.headers['Cache-Control'], /stale-while-revalidate/);
  assert.match(r.headers['Content-Security-Policy'], /script-src 'sha256-/);
  const { tags, canonical, errors } = validateOg(r.body);
  assert.deepEqual(errors, []);
  assert.equal(tags['og:type'], 'music.song');
  assert.equal(tags['og:title'], 'Midnight <Drive>');
  assert.equal(tags['og:image'], ART['1000x1000']);
  assert.equal(tags['og:image:width'], '1000');
  assert.equal(tags['og:url'], 'https://zoyra-share.vercel.app/t/D7KyD');
  assert.equal(canonical, 'https://zoyra-share.vercel.app/t/D7KyD');
  assert.equal(tags['twitter:card'], 'summary_large_image');
  assert.equal(tags['music:duration'], '225');
  assert.match(tags['og:description'], /Midnight <Drive> by Nova & Co · 3:45 · Electronic/);
  // Upstream text is escaped, never raw HTML.
  assert.ok(!r.body.includes('<Drive>'));
  assert.ok(r.body.includes('Midnight &lt;Drive&gt;'));
  assert.ok(r.body.includes('href="zoyra://t/D7KyD"'));
  assert.ok(r.body.includes('intent://t/D7KyD#Intent;scheme=zoyra;package=com.zoyra.app;'));
  assert.ok(r.body.includes('play.google.com/store/apps/details?id=com.zoyra.app'));
});

test('lyric card: same song, framed as lyrics', async () => {
  const f = mockFetch([[/\/tracks\/D7KyD/, () => json({ data: { title: 'Song', duration: 0, artwork: ART, user: { name: 'A' } } })]]);
  const r = await handleShare({ kind: 'l', id: 'D7KyD' }, ENV, f);
  const { tags, errors } = validateOg(r.body);
  assert.deepEqual(errors, []);
  assert.match(tags['og:description'], /^Lyric card from “Song” by A/);
  assert.equal(tags['og:url'], 'https://zoyra-share.vercel.app/l/D7KyD');
});

test('track: yt_ song falls back to YouTube oEmbed when the backend is not configured', async () => {
  const f = mockFetch([[/youtube\.com\/oembed/, () => json({ title: 'Live Session', author_name: 'Some Channel' })]]);
  const r = await handleShare({ kind: 't', id: 'yt_dQw4w9WgXcQ' }, ENV, f);
  assert.equal(r.status, 200);
  const { tags, errors } = validateOg(r.body);
  assert.deepEqual(errors, []);
  assert.equal(tags['og:image'], 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  assert.equal(tags['og:title'], 'Live Session');
});

test('playlist: public user playlist via anon RPC only', async () => {
  const f = mockFetch([
    [/\/rest\/v1\/rpc\/share_playlist_card/, () =>
      json([{ id: '0b7c1e1e-1111-4222-8333-444455556666', title: 'Late Night', description: 'Chill', cover_url: null, track_count: 24, owner_name: 'Priya', owner_username: 'priya', artwork: ['https://cdn.audius.test/x.jpg'], preview: [{ title: 'One', artist: 'X' }, { title: 'Two', artist: 'Y' }] }])],
  ]);
  const r = await handleShare({ kind: 'p', id: '0b7c1e1e-1111-4222-8333-444455556666' }, ENV, f);
  assert.equal(r.status, 200);
  const { tags, errors } = validateOg(r.body);
  assert.deepEqual(errors, []);
  assert.equal(tags['og:type'], 'music.playlist');
  assert.equal(tags['og:image'], 'https://cdn.audius.test/x.jpg');
  assert.match(tags['og:description'], /Playlist by Priya · 24 songs\. Featuring One — X, Two — Y\./);
  assert.match(r.body, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(r.headers['Cache-Control'], /s-maxage=600/);
  // Only the RPC was called, with the anon key, never a table and never a service key.
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.headers.apikey, 'eyJ.anon.key');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { pid: '0b7c1e1e-1111-4222-8333-444455556666' });
});

test('playlist: private/missing playlist → graceful 404', async () => {
  const f = mockFetch([[/share_playlist_card/, () => json([])]]);
  const r = await handleShare({ kind: 'p', id: '0b7c1e1e-1111-4222-8333-444455556666' }, ENV, f);
  assert.equal(r.status, 404);
  assert.match(r.body, /private or no longer exists/);
  assert.deepEqual(validateOg(r.body).errors, []);
});

test('playlist: catalogue (Audius) playlist id and album', async () => {
  const f = mockFetch([[/\/playlists\/ABC12/, () => json({ data: [{ playlist_name: 'Fresh Finds', is_album: true, user: { name: 'Band' }, artwork: ART, track_count: 9, description: '' }] })]]);
  const p = await handleShare({ kind: 'p', id: 'ABC12' }, ENV, f);
  assert.equal(validateOg(p.body).tags['og:type'], 'music.album');
  const a = await handleShare({ kind: 'a', id: 'ABC12' }, ENV, f);
  const { tags, errors } = validateOg(a.body);
  assert.deepEqual(errors, []);
  assert.equal(tags['og:title'], 'Fresh Finds');
  assert.match(tags['og:description'], /^Album by Band · 9 songs\./);
});

test('artist: Audius user and yta_ name-only artist', async () => {
  const f = mockFetch([[/\/users\/nQx9/, () => json({ data: { name: 'Nova', handle: 'nova', follower_count: 12500, track_count: 40, profile_picture: ART } })]]);
  const r = await handleShare({ kind: 'ar', id: 'nQx9' }, ENV, f);
  const { tags, errors } = validateOg(r.body);
  assert.deepEqual(errors, []);
  assert.equal(tags['og:type'], 'profile');
  assert.match(tags['og:description'], /12\.5K followers · 40 tracks/);
  const y = await handleShare({ kind: 'ar', id: encodeURIComponent('yta_Arijit Singh') }, ENV, f);
  assert.equal(y.status, 200);
  assert.equal(validateOg(y.body).tags['og:title'], 'Arijit Singh');
  assert.equal(validateOg(y.body).tags['og:image'], 'https://zoyra-share.vercel.app/og-default.png');
});

test('profile: public profile by username', async () => {
  const f = mockFetch([[/share_profile_card/, () => json([{ is_private: false, id: '11111111-2222-4333-8444-555555555555', username: 'priya', display_name: 'Priya', bio: 'Loves lo-fi', avatar_url: 'https://abc.supabase.co/storage/v1/object/public/avatars/p.jpg', followers: 3, following: 5, public_playlists: 2 }])]]);
  const r = await handleShare({ kind: 'u', id: '@priya' }, ENV, f);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { lookup: 'priya' });
  const { tags, errors } = validateOg(r.body);
  assert.deepEqual(errors, []);
  assert.equal(tags['og:title'], 'Priya (@priya)');
  assert.match(tags['og:description'], /Loves lo-fi · 3 followers · 2 playlists on Zoyra\./);
  assert.match(r.body, /noindex/);
});

test('profile: private profile shows a minimal card and leaks nothing', async () => {
  // Even if the RPC ever returned more, the renderer must not show it.
  const f = mockFetch([[/share_profile_card/, () => json([{ is_private: true, display_name: 'Secret Name', bio: 'secret bio', avatar_url: 'https://x.test/secret.jpg', username: 'secretuser' }])]]);
  const r = await handleShare({ kind: 'u', id: 'secretuser' }, ENV, f);
  assert.equal(r.status, 200);
  const { tags, errors } = validateOg(r.body);
  assert.deepEqual(errors, []);
  assert.equal(tags['og:title'], 'Private profile');
  for (const s of ['Secret Name', 'secret bio', 'secret.jpg']) assert.ok(!r.body.includes(s), `leaked ${s}`);
  assert.equal(tags['og:image'], 'https://zoyra-share.vercel.app/og-default.png');
});

test('bad ids are rejected without echoing them', async () => {
  const f = mockFetch([]);
  for (const id of ['<script>alert(1)</script>', '../../etc', 'a'.repeat(400), '%E0%A4%A']) {
    const r = await handleShare({ kind: 't', id }, ENV, f);
    assert.equal(r.status, 404);
    assert.ok(!r.body.includes('<script>alert'));
  }
  assert.equal(f.calls.length, 0);
  const unknown = await handleShare({ kind: 'zz', id: 'abc' }, ENV, f);
  assert.equal(unknown.status, 404);
});

test('upstream outage → 503 with short cache, still a valid preview', async () => {
  const f = mockFetch([[/audius/, () => new Response('boom', { status: 502 })]]);
  const r = await handleShare({ kind: 't', id: 'D7KyD' }, ENV, f);
  assert.equal(r.status, 503);
  assert.match(r.headers['Cache-Control'], /s-maxage=30/);
  assert.deepEqual(validateOg(r.body).errors, []);
  // Missing Supabase config is an error, not "not found".
  const noSb = await handleShare({ kind: 'u', id: 'priya' }, { PUBLIC_HOST: ENV.PUBLIC_HOST }, f);
  assert.equal(noSb.status, 503);
});

test('home page', async () => {
  const r = await handleShare({ kind: 'home', id: '' }, ENV, mockFetch([]));
  assert.equal(r.status, 200);
  const { tags, errors } = validateOg(r.body);
  assert.deepEqual(errors, []);
  assert.equal(tags['og:type'], 'website');
  assert.ok(!r.body.includes('noindex'));
});

test('apple-app-site-association', () => {
  const r = appleAppSiteAssociation(ENV);
  assert.equal(r.headers['Content-Type'], 'application/json');
  const d = JSON.parse(r.body).applinks.details[0];
  assert.deepEqual(d.appIDs, ['ABCDE12345.com.zoyra.app']);
  assert.equal(d.appID, 'ABCDE12345.com.zoyra.app');
  assert.deepEqual(d.paths, ['/t/*', '/p/*', '/a/*', '/ar/*', '/u/*', '/l/*', '/s/*', '/lv/*', '/rm/*', '/fam/*', '/inv/*']);
  assert.equal(d.components.length, 11);
  assert.equal(JSON.parse(appleAppSiteAssociation({}).body).applinks.details[0].appID, 'TEAMID_NOT_SET.com.zoyra.app');
});

test('assetlinks.json keeps only valid SHA-256 fingerprints', () => {
  const r = assetLinks(ENV);
  assert.equal(r.headers['Content-Type'], 'application/json');
  const [entry] = JSON.parse(r.body);
  assert.equal(entry.target.package_name, 'com.zoyra.app');
  assert.deepEqual(entry.target.sha256_cert_fingerprints, [`${'AB:'.repeat(31)}CD`]);
  assert.deepEqual(entry.relation, ['delegate_permission/common.handle_all_urls']);
});

/* ------------------------------------------------------------------ share snapshots (/s/<token>) */

const TOK = 'a1b2c3d4e5f6a7';
const snap = (kind, payload, extra = {}) => mockFetch([[/share_snapshot_card/, () => json([{ kind, payload, owner_name: 'Priya Rao', owner_username: 'priya', owner_avatar: null, ...extra }])]]);

test('snapshot: run card', async () => {
  const f = snap('w', { dist: 5230, dur: 1710, steps: 6400, wk: 'run', on: '2026-11-17', songs: ['Midnight Drive — Nova', 'Run <script>x</script>'] });
  const r = await handleShare({ kind: 's', id: TOK }, ENV, f);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { tok: TOK });
  const { tags, errors } = validateOg(r.body);
  assert.deepEqual(errors, []);
  assert.equal(tags['og:title'], '5.23 km run with Zoyra');
  assert.match(tags['og:description'], /Priya Rao ran 5\.23 km in 28:30/);
  assert.match(r.body, /noindex/);
  assert.ok(!r.body.includes('<script>x'), 'payload text must be escaped');
  assert.match(r.body, /zoyra:\/\/s\/a1b2c3d4e5f6a7/);
});

test('snapshot: taste match, insights, DNA and badges render', async () => {
  const cases = [
    ['m', { me: 'Priya', you: 'Sam', pct: 87, artists: ['Nova'], genres: [{ n: 'Lo-fi', p: 60 }] }, /87% taste match/],
    ['i', { per: 'week', min: 305, plays: 90, artists: ['Nova'], genres: [{ n: 'Pop', p: 40 }] }, /5h 5m of music/],
    ['d', { genres: [{ n: 'Indie', p: 55 }, { n: 'Pop', p: 30 }] }, /Indie 55%/],
    ['b', { got: 3, total: 20, names: ['Night Owl'] }, /3 of 20 badges/],
  ];
  for (const [kind, payload, re] of cases) {
    const r = await handleShare({ kind: 's', id: TOK }, ENV, snap(kind, payload));
    assert.equal(r.status, 200, kind);
    const { tags, errors } = validateOg(r.body);
    assert.deepEqual(errors, [], kind);
    assert.match(tags['og:title'], re, kind);
  }
});

test('snapshot: private owner is never named; bad/missing tokens 404', async () => {
  const r = await handleShare({ kind: 's', id: TOK }, ENV, snap('b', { got: 1, total: 5, names: ['X'] }, { owner_name: null, owner_avatar: null }));
  assert.equal(r.status, 200);
  assert.match(r.body, /A Zoyra listener/);
  const f = mockFetch([]);
  assert.equal((await handleShare({ kind: 's', id: 'not-a-token' }, ENV, f)).status, 404);
  assert.equal(f.calls.length, 0);
  assert.equal((await handleShare({ kind: 's', id: TOK }, ENV, mockFetch([[/share_snapshot_card/, () => json([])]]))).status, 404);
});

/* ------------------------------------------------------------------ live rooms and join links */

const LIVE_ID = '3f2b8c1e-4d5a-4e6f-9a7b-1c2d3e4f5a6b';

test('live: a live room renders a "Live now" card with the host and listener count', async () => {
  const f = mockFetch([[/rpc\/share_live_card/, () => json([{ title: 'Friday <night> set', status: 'live', listeners: 1240, host_name: 'Marina', avatar_url: 'https://cdn.test/m.jpg' }])]]);
  const r = await handleShare({ kind: 'lv', id: LIVE_ID }, ENV, f);
  assert.equal(r.status, 200);
  assert.match(r.body, /Live now/);
  assert.match(r.body, /Marina/);
  assert.match(r.body, /1\.2K listeners/);
  assert.doesNotMatch(r.body, /<night>/); // title is escaped
  assert.match(r.body, /noindex/);
  assert.equal(JSON.parse(f.calls[0].init.body).lookup, LIVE_ID);
});

test('live: an ended room says so, and a private host is not named', async () => {
  const f = mockFetch([[/rpc\/share_live_card/, () => json([{ title: 'Quiet set', status: 'ended', listeners: 3, host_name: null, avatar_url: null }])]]);
  const r = await handleShare({ kind: 'lv', id: LIVE_ID }, ENV, f);
  assert.equal(r.status, 200);
  assert.match(r.body, /Live ended/);
  assert.match(r.body, /A Zoyra host/);
});

test('live: a missing room is a 404, and a bad id never reaches the database', async () => {
  const none = mockFetch([[/rpc\/share_live_card/, () => json([])]]);
  assert.equal((await handleShare({ kind: 'lv', id: LIVE_ID }, ENV, none)).status, 404);
  const bad = mockFetch([]);
  assert.equal((await handleShare({ kind: 'lv', id: 'not-a-uuid' }, ENV, bad)).status, 404);
  assert.equal(bad.calls.length, 0);
});

test('join links (room, family, playlist invite): generic card, no data lookup, bad codes rejected', async () => {
  for (const [kind, id, title] of [
    ['rm', 'group-ABC123', /Join the listening room/],
    ['rm', 'party-ZX81', /Join the listening room/],
    ['fam', '1A2B3C4D', /Family plan/],
    ['inv', LIVE_ID, /Join a playlist/],
  ]) {
    const f = mockFetch([]);
    const r = await handleShare({ kind, id }, ENV, f);
    assert.equal(r.status, 200, `${kind}/${id}`);
    assert.match(r.body, title);
    assert.equal(f.calls.length, 0);
  }
  for (const [kind, id] of [['rm', 'ABC123'], ['rm', 'club-ABC123'], ['fam', 'x'], ['fam', '<script>'], ['inv', 'nope']]) {
    assert.equal((await handleShare({ kind, id }, ENV, mockFetch([]))).status, 404, `${kind}/${id}`);
  }
});

test('app links: the new kinds are claimed for Universal Links / App Links', () => {
  const aasa = JSON.stringify(appleAppSiteAssociation(ENV));
  for (const p of ['/lv/*', '/rm/*', '/fam/*', '/inv/*']) assert.ok(aasa.includes(p), p);
});
