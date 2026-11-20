import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { go, Icon, ModalCard, T, useAsync } from '../components';
import { chatBus } from '../lib/chat';
import { supabase } from '../lib/supabase';
import { clearChat, loadClearStats } from '../lib/chat-delete';
import { CheckRow, DialogBody, DialogButton, DialogNote, DialogTitle, dialogColors } from '../lib/confirm-ui';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Confirm clear (`/confirm-clear?cid=&name=[&group=1]`), centered dialog. Clears the chat for me only: every
 * current message is hidden for the caller (`clear_chat` rpc); the other person (or every other group
 * member) keeps their copy. Group wording when `group=1` or the conversation's kind is 'group'.
 */
export default function ConfirmClear() {
  const params = useLocalSearchParams<{ cid?: string; name?: string; group?: string }>();
  const cid = typeof params.cid === 'string' ? params.cid : '';
  const name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : '';
  const first = name.split(/\s+/)[0];
  const { user } = useAuth();
  const me = user?.id;
  const [deleteMedia, setDeleteMedia] = useState(true);
  const [keepPinned, setKeepPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stats = useAsync(() => (cid && me ? loadClearStats(cid, me) : Promise.resolve(null)), [cid, me], 'app/confirm-clear:32');
  const kind = useAsync(async () => {
    if (params.group === '1') return 'group';
    if (!cid) return 'direct';
    const { data } = await supabase.from('conversations').select('kind').eq('id', cid).maybeSingle();
    return (data as { kind?: string } | null)?.kind === 'group' ? 'group' : 'direct';
  }, [cid, params.group], 'app/confirm-clear:33');
  const group = kind.data === 'group';
  const s = stats.data;
  const media = s ? s.photos + s.voice : 0;

  const clear = async () => {
    if (!cid || !me || busy) return;
    setBusy(true);
    setError(null);
    try {
      await clearChat(cid, { keepPinned, keepMedia: !deleteMedia });
      chatBus.setReply(cid, undefined);
      go('back');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not clear this chat');
      setBusy(false);
    }
  };

  if (!cid || !me) {
    return (
      <ModalCard>
        <DialogBody label="Clear chat">
          <DialogTitle>Clear chat</DialogTitle>
          <T size={14} color={colors.textSecondary} align="center">
            {me ? 'This conversation is no longer available.' : 'Sign in to manage your chats.'}
          </T>
          <DialogButton label="Close" onPress={() => go('back')} />
        </DialogBody>
      </ModalCard>
    );
  }

  const count = s ? (s.messages === 0 ? 'There are no messages to clear.' : `All ${plural(s.messages, 'message')} will be removed from your phone.`) : 'All messages will be removed from your phone.';
  const other = group
    ? 'Other members will still see their copies.'
    : first && name !== 'Others'
      ? `${first} will still see their copy.`
      : 'The other person will still see their copy.';
  const mediaParts = s ? [s.photos ? plural(s.photos, 'photo') : '', s.voice ? plural(s.voice, 'voice note') : ''].filter(Boolean).join(', ') : '';

  return (
    <ModalCard onDismiss={busy ? () => undefined : undefined}>
      <DialogBody label={group ? 'Clear this group chat for you?' : 'Clear this chat?'}>
        <View
          importantForAccessibility="no-hide-descendants"
          style={{ alignSelf: 'center', width: 64, height: 64, borderRadius: 32, backgroundColor: withAlpha(dialogColors.danger, 0.16), alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="trash" size={28} color={dialogColors.dangerText} />
        </View>
        <View style={{ alignItems: 'center', gap: 8 }}>
          <DialogTitle>{group ? `Clear ${name ? `“${name}”` : 'this group chat'} for you?` : 'Clear this chat?'}</DialogTitle>
          <T size={14} color={colors.textSecondary} align="center" lineHeight={20} accessibilityLiveRegion="polite">
            {`${count} ${other}`}
          </T>
        </View>
        <View style={{ gap: 8 }}>
          {!s || media > 0 ? <CheckRow checked={deleteMedia} onChange={setDeleteMedia} disabled={busy} title="Also delete shared media" subtitle={mediaParts || 'Photos and voice notes'} /> : null}
          {s && s.pinned > 0 ? <CheckRow checked={keepPinned} onChange={setKeepPinned} disabled={busy} title="Keep pinned messages" subtitle={`${s.pinned} pinned`} /> : null}
        </View>
        <DialogNote text={error} />
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <DialogButton label="Cancel" flex disabled={busy} onPress={() => go('back')} />
          <DialogButton label={error ? 'Try again' : 'Clear chat'} kind="danger" flex busy={busy} disabled={s?.messages === 0} onPress={() => void clear()} />
        </View>
      </DialogBody>
    </ModalCard>
  );
}
