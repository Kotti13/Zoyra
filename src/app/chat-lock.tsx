import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, Sheet, T, Toggle, IconBadge } from '../components';
import { authenticate, canAuthenticate, setChatLock, useChatLocks } from '../lib/chat-lock';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

/**
 * Lock chat (`/chat-lock?id=<conversation>`), sheet. Requires Face ID / Touch ID / passcode to open the chat,
 * optionally hides it from the inbox list and masks notification text. Stored on this device only.
 */
export default function ChatLockSheet() {
  const params = useLocalSearchParams<{ id?: string }>();
  const cid = typeof params.id === 'string' ? params.id : '';
  const { user } = useAuth();
  const me = user?.id;
  const locks = useChatLocks(me);
  const current = cid ? locks[cid] : undefined;
  const [edit, setEdit] = useState<{ hide?: boolean; hideText?: boolean }>({});
  const hide = edit.hide ?? current?.hide ?? true;
  const hideText = edit.hideText ?? current?.hideText ?? true;
  const setHide = (v: boolean) => setEdit((e) => ({ ...e, hide: v }));
  const setHideText = (v: boolean) => setEdit((e) => ({ ...e, hideText: v }));
  const [able, setAble] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void canAuthenticate().then(setAble);
  }, []);

  const lock = async () => {
    if (!me || !cid || busy) return;
    setBusy(true);
    setError(null);
    // Confirm it is really the owner before locking (and so Face ID works on this device).
    const ok = await authenticate('Lock this chat');
    if (!ok) {
      setError('Could not confirm it is you. Nothing changed.');
      setBusy(false);
      return;
    }
    await setChatLock(me, cid, { hide, hideText });
    router.back();
  };
  const unlock = async () => {
    if (!me || !cid || busy) return;
    setBusy(true);
    if (!(await authenticate('Remove chat lock'))) {
      setError('Could not confirm it is you. The lock stays on.');
      setBusy(false);
      return;
    }
    await setChatLock(me, cid, null);
    router.back();
  };

  const row = (title: string, sub: string, value: boolean, onChange: (v: boolean) => void) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T size={16} weight={500}>
          {title}
        </T>
        <T size={14} color={colors.textSecondary}>
          {sub}
        </T>
      </View>
      <Toggle value={value} onChange={onChange} label={title} />
    </View>
  );

  return (
    <Sheet>
      <T variant="section" accessibilityRole="header">
        Lock chat
      </T>
      <T size={14} color={colors.textSecondary} style={{ marginTop: -6 }}>
        Hide this chat behind Face ID.
      </T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 24, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}>
        <IconBadge icon="lock" size={40} />
        <View style={{ flex: 1, gap: 2 }}>
          <T size={15} weight={600}>
            Face ID required
          </T>
          <T size={13} color={colors.textSecondary}>
            The chat moves to Locked chats. Banners show only the name, never the message.
          </T>
        </View>
      </View>
      {row('Hide from list', 'Open from Locked chats at the top', hide, setHide)}
      {row('Hide notification text', 'Show "New message" only', hideText, setHideText)}
      <T size={12} color={colors.textSecondary}>
        Forever friends can still reach you in Locked chats and never get blocked. Locks live on this device only.
      </T>
      {able === false ? (
        <T size={13} color={colors.error} accessibilityRole="alert">
          Set up Face ID, Touch ID or a passcode on this device to lock chats.
        </T>
      ) : null}
      {error ? (
        <T size={13} color={colors.error} accessibilityRole="alert">
          {error}
        </T>
      ) : null}
      <Button label={busy ? 'Working…' : current ? 'Update lock' : 'Lock this chat'} variant={busy || able === false ? 'disabled' : 'primary'} onPress={() => void lock()} />
      {current ? <Button label="Remove lock" variant="secondary" onPress={() => void unlock()} /> : null}
    </Sheet>
  );
}
