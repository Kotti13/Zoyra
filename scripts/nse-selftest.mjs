// Zoyra NSE crypto test: generates fixtures with the app's JS crypto (src/lib/e2ee/crypto.ts), then compiles and
// runs the Swift harness (plugins/zoyra-nse/tests/main.swift + plugins/zoyra-nse/ZoyraE2EE.swift) against them.
//
//   node --no-warnings scripts/nse-selftest.mjs            (needs Xcode command line tools for swiftc; macOS)
//   node --no-warnings scripts/nse-selftest.mjs --fixtures out.json   (only write fixtures)
//
// Exits non-zero when any check fails. Without swiftc it checks the fixtures in JS and reports SKIP for Swift.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes as nodeRandom, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const C = await import('../src/lib/e2ee/crypto.ts');
const { xchacha20poly1305 } = await import('@noble/ciphers/chacha.js');
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
const rnd = (n) => new Uint8Array(nodeRandom(n));

// The draft vector must hold for noble too (guards against a typo in the Swift harness constants).
{
  const out = xchacha20poly1305(unhex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f'), unhex('404142434445464748494a4b4c4d4e4f5051525354555657'), unhex('50515253c0c1c2c3c4c5c6c7')).encrypt(
    new TextEncoder().encode("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it."),
  );
  assert.equal(
    hex(out),
    'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52e' +
      'c0875924c1c7987947deafd8780acf49',
  );
  console.log('  ok  noble matches draft-irtf-cfrg-xchacha-03 §A.3.1');
}

const xchacha = [0, 1, 15, 16, 63, 64, 65, 300].map((n) => {
  const key = rnd(32), nonce = rnd(24), pt = rnd(n), aad = rnd(n % 7 === 0 ? 0 : 13);
  return { key: hex(key), nonce: hex(nonce), pt: hex(pt), aad: hex(aad), sealed: hex(xchacha20poly1305(key, nonce, aad).encrypt(pt)) };
});

// A sender (account + device) and a recipient device, like two phones.
const senderId = randomUUID();
const account = C.generateSignKeyPair();
const sender = C.generateDeviceKeys(randomUUID());
const cert = C.signDevice(account.priv, senderId, sender);
const me = C.generateDeviceKeys(randomUUID());
const other = C.generateDeviceKeys(randomUUID());
const cid = randomUUID();

/** What supabase/functions/push/index.ts puts in `zx` for `me`. */
function zxFor(payload, kind = 'text', mid = randomUUID()) {
  const sealed = C.sealPayload({ conversationId: cid, messageId: mid, sender, recipients: [me, other].map((d) => ({ deviceId: d.deviceId, encPub: d.encPub })), plaintext: C.utf8(JSON.stringify(payload)) });
  const env = sealed.envelopes.find((e) => e.device_id === me.deviceId);
  return {
    v: 1, m: mid, ci: cid, k: kind, c: sealed.ciphertext, cn: sealed.nonce, s: sealed.signature, sd: sender.deviceId,
    sp: C.toB64(sender.signPub), se: C.toB64(sender.encPub), sa: C.toB64(cert), ap: C.toB64(account.pub), su: senderId,
    d: me.deviceId, w: env.wrapped_key, e: env.eph_pub, n: env.nonce,
  };
}
const flip = (b64) => {
  const b = C.fromB64(b64);
  b[Math.floor(b.length / 2)] ^= 1;
  return C.toB64(b);
};

const encPriv = C.toB64(me.encPriv);
const messages = [
  { name: 'text', zx: zxFor({ body: 'Hey! Are we still on for the gig tonight? 🎸' }), expect: 'Hey! Are we still on for the gig tonight? 🎸' },
  { name: 'shared song', zx: zxFor({ track: { title: 'Glass Hours', artist: { name: 'Nova Lane' } } }, 'track'), expect: 'Sent you a song: Glass Hours' },
  { name: 'photo with caption', zx: zxFor({ body: 'sunset', meta: { media: { path: 'x', key: 'y' } } }, 'photo'), expect: '📷 sunset' },
  { name: 'voice note', zx: zxFor({ meta: { media: { path: 'x', key: 'y' } } }, 'voice'), expect: 'Sent a voice note' },
  { name: 'poll', zx: zxFor({ meta: { question: 'Pizza or tacos?', options: ['Pizza', 'Tacos'] } }, 'poll'), expect: 'Poll: Pizza or tacos?' },
  { name: 'playlist', zx: zxFor({ meta: { id: 'p1', title: 'Road trip' } }, 'playlist'), expect: 'Sent you a playlist: Road trip' },
];
const base = zxFor({ body: 'tamper me' });
messages.push(
  { name: 'tampered ciphertext', zx: { ...base, c: flip(base.c) } },
  { name: 'tampered envelope', zx: { ...base, w: flip(base.w) } },
  { name: 'tampered signature', zx: { ...base, s: flip(base.s) } },
  { name: 'wrong conversation id', zx: { ...base, ci: randomUUID() } },
  { name: 'wrong message id', zx: { ...base, m: randomUUID() } },
  { name: 'sender device not signed by account', zx: { ...base, ap: C.toB64(C.generateSignKeyPair().pub) } },
  { name: 'other device envelope', zx: (() => { const z = zxFor({ body: 'x' }); return { ...z, d: other.deviceId }; })() },
  { name: 'unsupported version', zx: { ...base, v: 2 } },
);

// Same checks in JS first, so a Swift failure clearly points at the Swift side.
for (const c of messages) {
  let got = null;
  try {
    const z = c.zx;
    if (z.v !== 1) throw new Error('version');
    const ck = C.openEnvelope({ messageId: z.m, deviceId: z.d, encPriv: me.encPriv, envelope: { wrapped_key: z.w, eph_pub: z.e, nonce: z.n } });
    if (!C.verifyDevice(C.fromB64(z.ap), z.su, z.sd, C.fromB64(z.se), C.fromB64(z.sp), C.fromB64(z.sa))) throw new Error('device');
    const pt = C.openPayload({ version: 1, conversationId: z.ci, messageId: z.m, senderDeviceId: z.sd, senderSignPub: C.fromB64(z.sp), ciphertext: z.c, nonce: z.cn, signature: z.s, contentKey: ck });
    got = JSON.parse(C.fromUtf8(pt));
  } catch {
    got = null;
  }
  assert.equal(got !== null, c.expect !== undefined, `JS ${c.name}`);
}
console.log(`  ok  JS reference accepts ${messages.filter((m) => m.expect).length} / rejects ${messages.filter((m) => !m.expect).length} fixtures`);

const fixtures = { xchacha, messages: messages.map((m) => ({ ...m, enc_priv: encPriv })) };
const fxArg = process.argv.indexOf('--fixtures');
if (fxArg > 0) {
  writeFileSync(process.argv[fxArg + 1], JSON.stringify(fixtures, null, 1));
  console.log(`fixtures written to ${process.argv[fxArg + 1]}`);
  process.exit(0);
}

let swiftc = null;
try {
  execFileSync('swiftc', ['--version'], { stdio: 'ignore' });
  swiftc = 'swiftc';
} catch {
  console.log('  SKIP Swift harness (swiftc not found; run on macOS with Xcode command line tools)');
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), 'zoyra-nse-'));
try {
  const fx = join(dir, 'fixtures.json');
  writeFileSync(fx, JSON.stringify(fixtures));
  const bin = join(dir, 'nse-test');
  execFileSync(swiftc, ['-O', join(root, 'plugins/zoyra-nse/ZoyraE2EE.swift'), join(root, 'plugins/zoyra-nse/tests/main.swift'), '-o', bin], { stdio: 'inherit' });
  execFileSync(bin, [fx], { stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
