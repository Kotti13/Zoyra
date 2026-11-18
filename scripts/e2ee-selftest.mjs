// Zoyra E2EE crypto self-test. Runs the exact app module (src/lib/e2ee/crypto.ts) under Node ≥ 22.18
// / 23.6 (built-in TypeScript type stripping):
//
//   node --no-warnings scripts/e2ee-selftest.mjs
//
// Exits non-zero on the first failure. Also prints rough timings.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes as nodeRandom, randomUUID } from 'node:crypto';

const rnd = (n) => new Uint8Array(nodeRandom(n));

const C = await import('../src/lib/e2ee/crypto.ts');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n`, e);
    process.exit(1);
  }
}
const throwsCode = (fn, code) => {
  try {
    fn();
  } catch (e) {
    assert.equal(e.code, code, `expected ${code}, got ${e.code} (${e.message})`);
    return;
  }
  assert.fail(`expected E2EEError ${code}`);
};
const rejectsCode = async (p, code) => {
  try {
    await p;
  } catch (e) {
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`expected E2EEError ${code}`);
};
const time = (fn) => {
  const s = performance.now();
  const r = fn();
  return [r, performance.now() - s];
};

// ── fixtures: two users, alice with 2 devices, bob with 1, carol with 1
const mkUser = (devices) => {
  const userId = randomUUID();
  const account = C.generateSignKeyPair();
  const devs = Array.from({ length: devices }, () => C.generateDeviceKeys(randomUUID()));
  const certs = devs.map((d) => C.signDevice(account.priv, userId, d));
  return { userId, account, devs, certs };
};
const alice = mkUser(2);
const bob = mkUser(1);
const carol = mkUser(1);
const cid = randomUUID();
const recipientsOf = (...users) => users.flatMap((u) => u.devs.map((d) => ({ deviceId: d.deviceId, encPub: d.encPub })));

function open(sealed, mid, dev, senderSignPub, conversationId = cid) {
  const env = sealed.envelopes.find((e) => e.device_id === dev.deviceId);
  if (!env) throw new C.E2EEError('no_envelope');
  const key = C.openEnvelope({ messageId: mid, deviceId: dev.deviceId, encPriv: dev.encPriv, envelope: env });
  return JSON.parse(
    C.fromUtf8(
      C.openPayload({
        version: sealed.e2ee_version,
        conversationId,
        messageId: mid,
        senderDeviceId: sealed.sender_device_id,
        senderSignPub,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        signature: sealed.signature,
        contentKey: key,
      }),
    ),
  );
}

console.log('E2EE self-test');

await test('base64 round-trip (all lengths 0..70, random bytes)', () => {
  for (let n = 0; n <= 70; n++) {
    const b = C.random(n);
    const s = C.toB64(b);
    assert.equal(s, Buffer.from(b).toString('base64'));
    assert.deepEqual(C.fromB64(s), b);
  }
});

await test('device certificate verifies; wrong account / tampered key fails', () => {
  const d = alice.devs[0];
  assert.ok(C.verifyDevice(alice.account.pub, alice.userId, d.deviceId, d.encPub, d.signPub, alice.certs[0]));
  assert.ok(!C.verifyDevice(bob.account.pub, alice.userId, d.deviceId, d.encPub, d.signPub, alice.certs[0]));
  assert.ok(!C.verifyDevice(alice.account.pub, bob.userId, d.deviceId, d.encPub, d.signPub, alice.certs[0]));
  assert.ok(!C.verifyDevice(alice.account.pub, alice.userId, d.deviceId, bob.devs[0].encPub, d.signPub, alice.certs[0]));
});

const payload = { body: 'hey 👋 this is secret', meta: { poll: { q: 'Best album?', options: ['A', 'B'] }, voice: { path: 'x/y', key: 'k' } } };
const mid = randomUUID();
const sender = alice.devs[0];
const sealed = C.sealPayload({ conversationId: cid, messageId: mid, sender, recipients: recipientsOf(alice, bob), plaintext: C.utf8(JSON.stringify(payload)) });

await test('round-trip: recipient decrypts', () => {
  assert.deepEqual(open(sealed, mid, bob.devs[0], sender.signPub), payload);
});

await test("multi-device fan-out: sender's own devices + every recipient device decrypt", () => {
  assert.equal(sealed.envelopes.length, 3);
  for (const d of [...alice.devs, ...bob.devs]) assert.deepEqual(open(sealed, mid, d, sender.signPub), payload);
});

await test('non-recipient (carol) has no envelope; using another envelope with her key fails', () => {
  throwsCode(() => open(sealed, mid, carol.devs[0], sender.signPub), 'no_envelope');
  const env = sealed.envelopes.find((e) => e.device_id === bob.devs[0].deviceId);
  throwsCode(() => C.openEnvelope({ messageId: mid, deviceId: bob.devs[0].deviceId, encPriv: carol.devs[0].encPriv, envelope: env }), 'bad_envelope');
});

await test('wrong key: wrong device id / message id in envelope context fails', () => {
  const env = sealed.envelopes.find((e) => e.device_id === bob.devs[0].deviceId);
  throwsCode(() => C.openEnvelope({ messageId: mid, deviceId: alice.devs[1].deviceId, encPriv: bob.devs[0].encPriv, envelope: env }), 'bad_envelope');
  throwsCode(() => C.openEnvelope({ messageId: randomUUID(), deviceId: bob.devs[0].deviceId, encPriv: bob.devs[0].encPriv, envelope: env }), 'bad_envelope');
});

await test('tampered ciphertext fails (signature)', () => {
  const ct = C.fromB64(sealed.ciphertext);
  ct[5] ^= 1;
  throwsCode(() => open({ ...sealed, ciphertext: C.toB64(ct) }, mid, bob.devs[0], sender.signPub), 'bad_signature');
});

await test('tampered wrapped key fails', () => {
  const envelopes = sealed.envelopes.map((e) => {
    if (e.device_id !== bob.devs[0].deviceId) return e;
    const w = C.fromB64(e.wrapped_key);
    w[0] ^= 1;
    return { ...e, wrapped_key: C.toB64(w) };
  });
  throwsCode(() => open({ ...sealed, envelopes }, mid, bob.devs[0], sender.signPub), 'bad_envelope');
});

await test('substituted content key (server swaps envelope for another message) fails', () => {
  const other = C.sealPayload({ conversationId: cid, messageId: mid, sender: bob.devs[0], recipients: recipientsOf(bob), plaintext: C.utf8('{"body":"forged"}') });
  // valid envelope for bob, same message id, but different content key → commitment in signature breaks
  const forged = { ...sealed, envelopes: other.envelopes };
  throwsCode(() => open(forged, mid, bob.devs[0], sender.signPub), 'bad_signature');
});

await test('signature: wrong sender key / moved to another conversation / spoofed sender device fails', () => {
  throwsCode(() => open(sealed, mid, bob.devs[0], alice.devs[1].signPub), 'bad_signature');
  throwsCode(() => open(sealed, mid, bob.devs[0], sender.signPub, randomUUID()), 'bad_signature');
  throwsCode(() => open({ ...sealed, sender_device_id: alice.devs[1].deviceId }, mid, bob.devs[0], sender.signPub), 'bad_signature');
});

await test('edit: re-encrypting the same message id gives fresh ciphertext; old envelopes do not open it', () => {
  const edited = C.sealPayload({ conversationId: cid, messageId: mid, sender, recipients: recipientsOf(alice, bob), plaintext: C.utf8('{"body":"edited"}') });
  assert.notEqual(edited.ciphertext, sealed.ciphertext);
  assert.equal(open(edited, mid, bob.devs[0], sender.signPub).body, 'edited');
  throwsCode(() => open({ ...edited, envelopes: sealed.envelopes }, mid, bob.devs[0], sender.signPub), 'bad_signature');
});

await test('group fan-out: 64 members × 2 devices', () => {
  const members = Array.from({ length: 63 }, () => mkUser(2));
  const recips = recipientsOf(alice, ...members);
  const [g, ms] = time(() => C.sealPayload({ conversationId: cid, messageId: mid, sender, recipients: recips, plaintext: C.utf8('{"body":"hi all"}') }));
  assert.equal(g.envelopes.length, 128);
  assert.equal(open(g, mid, members[40].devs[1], sender.signPub).body, 'hi all');
  console.log(`       seal for 128 devices: ${ms.toFixed(0)} ms (V8)`);
});

await test('files: round-trip (empty, small, multi-chunk); tamper / truncate / wrong key fail', () => {
  for (const n of [0, 1, 1000, C.FILE_CHUNK, C.FILE_CHUNK * 3 + 17]) {
    const data = rnd(n);
    const enc = C.encryptFile(data);
    assert.deepEqual(C.decryptFile(enc.key, enc.data), data);
  }
  const data = rnd(C.FILE_CHUNK * 2 + 5);
  const enc = C.encryptFile(data);
  const bad = enc.data.slice();
  bad[100] ^= 1;
  throwsCode(() => C.decryptFile(enc.key, bad), 'decrypt_failed');
  throwsCode(() => C.decryptFile(enc.key, enc.data.slice(0, 24 + C.FILE_CHUNK + 16)), 'decrypt_failed'); // dropped last chunks
  throwsCode(() => C.decryptFile(C.random(32), enc.data), 'decrypt_failed');
  const big = rnd(1024 * 1024);
  const [, ms] = time(() => {
    const e = C.encryptFile(big);
    assert.equal(C.decryptFile(e.key, e.data).length, big.length);
  });
  console.log(`       1 MiB file encrypt+decrypt: ${ms.toFixed(0)} ms (V8)`);
});

await test('PIN backup: round-trip; wrong PIN fails; verifier differs per PIN', async () => {
  const salt = C.random(16);
  const s = performance.now();
  const k = await C.stretchPin('482913', salt);
  console.log(`       scrypt N=2^15 r=8: ${(performance.now() - s).toFixed(0)} ms (V8)`);
  const blob = { v: 1, account_sign_priv: C.toB64(alice.account.priv), keys: alice.devs.map((d) => ({ device_id: d.deviceId, enc_priv: C.toB64(d.encPriv), created_at: new Date().toISOString() })) };
  const sealedBackup = C.sealBackup(k.backupKey, alice.userId, blob);
  const k2 = await C.stretchPin('482913', salt);
  assert.deepEqual(k2.verifier, k.verifier);
  const restored = C.openBackup(k2.backupKey, alice.userId, sealedBackup.ciphertext, sealedBackup.nonce);
  assert.deepEqual(restored, blob);
  // restored keys decrypt old history
  const dev = { ...alice.devs[1], encPriv: C.fromB64(restored.keys[1].enc_priv) };
  assert.deepEqual(open(sealed, mid, dev, sender.signPub), payload);
  const wrong = await C.stretchPin('482914', salt);
  assert.notDeepEqual(wrong.verifier, k.verifier);
  throwsCode(() => C.openBackup(wrong.backupKey, alice.userId, sealedBackup.ciphertext, sealedBackup.nonce), 'wrong_pin');
  throwsCode(() => C.openBackup(k.backupKey, bob.userId, sealedBackup.ciphertext, sealedBackup.nonce), 'wrong_pin');
  await rejectsCode(C.stretchPin('1', salt, { N: 1024, r: 8, p: 1 }), 'bad_format');
});

await test('local sealing round-trip; wrong aad fails', () => {
  const key = C.random(32);
  const s = C.sealLocal(key, C.utf8('cached'), 'msg:1');
  assert.equal(C.fromUtf8(C.openLocal(key, s, 'msg:1')), 'cached');
  assert.throws(() => C.openLocal(key, s, 'msg:2'));
});

await test('safety number: 60 digits, symmetric, changes with key', () => {
  const [n1, ms] = time(() => C.safetyNumber({ userId: alice.userId, accountPub: alice.account.pub }, { userId: bob.userId, accountPub: bob.account.pub }));
  const n2 = C.safetyNumber({ userId: bob.userId, accountPub: bob.account.pub }, { userId: alice.userId, accountPub: alice.account.pub });
  assert.match(n1, /^\d{60}$/);
  assert.equal(n1, n2);
  const n3 = C.safetyNumber({ userId: alice.userId, accountPub: C.generateSignKeyPair().pub }, { userId: bob.userId, accountPub: bob.account.pub });
  assert.notEqual(n1, n3);
  assert.equal(C.formatSafetyNumber(n1).split(' ').length, 12);
  console.log(`       safety number: ${ms.toFixed(0)} ms (V8)`);
});

await test('CSPRNG present (globalThis.crypto.getRandomValues) and output not constant', () => {
  assert.equal(typeof globalThis.crypto.getRandomValues, 'function');
  assert.notDeepEqual(C.random(32), C.random(32));
});

console.log(`\nall ${passed} tests passed`);
