import { usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';

import { clearDecryptedMedia } from './chat-e2ee';
import { initE2EE, resetE2EEMemory, useE2EE } from './e2ee';
import { registerForPush } from './push';

/** Chat screens: opening one retries a failed key load (e.g. back online). */
const CHAT_ROUTES = new Set(['/chat-pro', '/group-chat', '/chat', '/messages']);

/**
 * Mounted once by the root AuthGate. After sign-in (past 2FA) it loads this phone's E2EE keys, creating them
 * silently when needed (WhatsApp-style: no PIN, no screen), and re-registers the push token with the E2EE device
 * id (so the server can address per-device notification envelopes). Nothing is ever routed from here: a restore
 * offer on a new phone is a dismissible card in the Messages inbox (RestoreHistoryCard), and sends never block.
 */
export function useE2EEBootstrap(userId: string | null, pushOn: boolean) {
  const snap = useE2EE();
  const pathname = usePathname();
  const hadUser = useRef(false);

  useEffect(() => {
    if (userId) {
      hadUser.current = true;
      if (snap.userId !== userId || snap.status === 'idle' || snap.status === 'error') void initE2EE(userId);
    } else if (hadUser.current) {
      hadUser.current = false;
      clearDecryptedMedia();
      resetE2EEMemory(); // keys stay in the keychain for this user id; only memory is cleared
    }
    // `error` retries only when the user / status changes (e.g. back online → next chat open re-inits).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, snap.userId]);

  // Push token ↔ E2EE device id (register_push_token p_device_id).
  useEffect(() => {
    if (userId && pushOn && snap.status === 'ready' && snap.deviceId && snap.userId === userId) void registerForPush(userId, { prompt: false });
  }, [userId, pushOn, snap.status, snap.deviceId, snap.userId]);

  const chatOpen = CHAT_ROUTES.has(pathname);
  const retriedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!chatOpen) {
      retriedFor.current = null;
      return;
    }
    if (!userId || snap.userId !== userId || snap.status !== 'error' || retriedFor.current === pathname) return;
    retriedFor.current = pathname; // once per chat screen visit (no retry loop while offline)
    void initE2EE(userId);
  }, [chatOpen, pathname, userId, snap.status, snap.userId]);
}
