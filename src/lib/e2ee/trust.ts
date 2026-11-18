import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Trust on first use. For every contact we remember the first account key we saw (and every device we
 * verified). If a contact's account key later changes (they reset their keys / new phone without the
 * PIN, or someone is interfering) we record a "security code changed" notice the chat can show as a
 * local system row. Marking a contact verified (after comparing safety numbers) pins that key.
 *
 * Stored in AsyncStorage (public keys only — nothing secret here).
 */

export type TrustEntry = { pub: string; verified: boolean; firstSeen: string; changedAt?: string; previousPub?: string };
export type IdentityChange = { userId: string; at: string; verifiedBefore: boolean };
type Book = { users: Record<string, TrustEntry>; devices: Record<string, { userId: string; signPub: string }>; changes: IdentityChange[] };

const key = (me: string) => `zoyra.e2ee.trust.${me}`;
const books = new Map<string, Book>();
const listeners = new Set<(changes: IdentityChange[]) => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function book(me: string): Promise<Book> {
  const cached = books.get(me);
  if (cached) return cached;
  let b: Book = { users: {}, devices: {}, changes: [] };
  try {
    const raw = await AsyncStorage.getItem(key(me));
    if (raw) b = { users: {}, devices: {}, changes: [], ...(JSON.parse(raw) as Partial<Book>) };
  } catch {
    // start fresh
  }
  books.set(me, b);
  return b;
}

function persist(me: string) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const b = books.get(me);
    if (b) AsyncStorage.setItem(key(me), JSON.stringify(b)).catch(() => {});
  }, 300);
}

/** Records / compares `userId`'s account key. Returns true when it changed since we last saw it. */
export async function observeAccountKey(me: string, userId: string, pub: string): Promise<boolean> {
  if (userId === me) return false;
  const b = await book(me);
  const cur = b.users[userId];
  const now = new Date().toISOString();
  if (!cur) {
    b.users[userId] = { pub, verified: false, firstSeen: now };
    persist(me);
    return false;
  }
  if (cur.pub === pub) return false;
  const change: IdentityChange = { userId, at: now, verifiedBefore: cur.verified };
  b.users[userId] = { pub, verified: false, firstSeen: cur.firstSeen, changedAt: now, previousPub: cur.pub };
  b.changes = [...b.changes.filter((c) => c.userId !== userId), change].slice(-200);
  persist(me);
  listeners.forEach((l) => l(b.changes));
  return true;
}

export async function getTrust(me: string, userId: string): Promise<TrustEntry | null> {
  return (await book(me)).users[userId] ?? null;
}

export async function setVerified(me: string, userId: string, pub: string, verified: boolean): Promise<void> {
  const b = await book(me);
  const cur = b.users[userId];
  b.users[userId] = { ...(cur ?? { firstSeen: new Date().toISOString() }), pub, verified };
  persist(me);
}

/** Devices whose account signature we have checked (kept so history from later-revoked devices still verifies). */
export async function rememberDevice(me: string, deviceId: string, userId: string, signPub: string): Promise<void> {
  const b = await book(me);
  if (b.devices[deviceId]?.signPub === signPub) return;
  b.devices[deviceId] = { userId, signPub };
  persist(me);
}

export async function knownDevice(me: string, deviceId: string): Promise<{ userId: string; signPub: string } | null> {
  return (await book(me)).devices[deviceId] ?? null;
}

/** "Security code changed" notices not yet acknowledged, oldest first. */
export async function identityChanges(me: string): Promise<IdentityChange[]> {
  return (await book(me)).changes;
}

export async function acknowledgeIdentityChange(me: string, userId: string): Promise<void> {
  const b = await book(me);
  b.changes = b.changes.filter((c) => c.userId !== userId);
  persist(me);
  listeners.forEach((l) => l(b.changes));
}

export function subscribeIdentityChanges(l: (changes: IdentityChange[]) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
