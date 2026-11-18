/**
 * Sign-out housekeeping shared by every way out (Settings › Log out, Account switcher, Delete account, 2FA
 * "use another account", a session revoked elsewhere).
 *
 *   beforeSignOut()    needs the session, so `useAuth().signOut` runs it BEFORE supabase.auth.signOut: ends a
 *                      call in progress and unregisters this phone's push / VoIP tokens. Capped at 4 s.
 *   clearUserMemory()  after the session is gone or switched to another account (AuthGate): drops the previous
 *                      user's in-memory chat / E2EE state. E2EE keys stay in the keychain, namespaced by user id.
 */
import { clearAsyncCache } from '../components/media';
import { clearForeverCache } from './forever';
import { clearDecryptedMedia, invalidateKeyCoverage } from './chat-e2ee';
import { chatBus } from './chat';
import { getCallSession, hangUp } from './call-session';
import { resetE2EEMemory } from './e2ee';
import { unregisterThisDevice } from './push';

export async function beforeSignOut(): Promise<void> {
  const work = (async () => {
    const call = getCallSession();
    if (call) await hangUp(call.callId).catch(() => undefined);
    await unregisterThisDevice();
  })().catch(() => undefined);
  await Promise.race([work, new Promise((resolve) => setTimeout(resolve, 4000))]);
}

export function clearUserMemory(): void {
  clearForeverCache();
  clearAsyncCache();
  invalidateKeyCoverage();
  clearDecryptedMedia();
  resetE2EEMemory();
  chatBus.reset();
}
