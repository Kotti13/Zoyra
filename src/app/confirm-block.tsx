import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, View } from 'react-native';

import { go, ModalCard, T } from '../components';
import { decryptChatRows, messagePreview, MSG_SELECT, type ChatMessage, type ChatPerson } from '../lib/chat';
import { ChatAvatar } from '../lib/chat-ui';
import { CheckRow, DialogBody, DialogButton, DialogNote, DialogTitle, FactRow } from '../lib/confirm-ui';
import { blockedDoneHref } from '../lib/confirm-routes';
import { foreverBlockLockedHref, guardBlock, isForeverLockedError } from '../lib/forever';
import { blockUser, friendlySocialError } from '../lib/social';
import { supabase } from '../lib/supabase';
import { REPORT_EMAIL } from '../lib/youtube';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

/** Their last 5 messages in this chat, oldest first, as plain lines for the report email. */
async function lastMessagesFrom(cid: string, uid: string): Promise<string[]> {
  const { data, error } = await supabase.from('messages').select(MSG_SELECT).eq('conversation_id', cid).eq('sender_id', uid).order('created_at', { ascending: false }).limit(5);
  if (error) return [];
  // Decrypted on this phone: the user chooses to include them in the report they send.
  return (await decryptChatRows((data ?? []) as ChatMessage[])).reverse().map((m) => `[${new Date(m.created_at).toISOString()}] ${messagePreview(m)}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The person to block, loaded by id from the server. `name` / `avatar` route params are ignored: a crafted
 * link could otherwise show one person's name while blocking (and reporting) someone else.
 * undefined = loading, null = not found.
 */
function usePerson(uid: string): ChatPerson | null | undefined {
  const [person, setPerson] = useState<{ uid: string; p: ChatPerson | null } | null>(null);
  useEffect(() => {
    if (!UUID_RE.test(uid)) return;
    let alive = true;
    void supabase
      .from('profiles')
      .select('id, display_name, avatar_url, username')
      .eq('id', uid)
      .maybeSingle()
      .then(
        ({ data }) => alive && setPerson({ uid, p: (data as ChatPerson | null) ?? null }),
        () => alive && setPerson({ uid, p: null }),
      );
    return () => {
      alive = false;
    };
  }, [uid]);
  if (!UUID_RE.test(uid)) return null;
  return person && person.uid === uid ? person.p : undefined;
}

/**
 * Confirm block (`/confirm-block?uid=&cid=`; legacy `name` / `avatar` params are ignored), centered dialog over Chat info.
 * Block → `block_user` rpc (no second prompt). "Also report" opens a pre-filled email to Zoyra with
 * their last 5 messages in this chat. Then replaces itself with Blocked done.
 */
export default function ConfirmBlock() {
  const params = useLocalSearchParams<{ uid?: string; cid?: string }>();
  const loaded = usePerson(typeof params.uid === 'string' ? params.uid : '');
  const person = loaded ?? null;
  const cid = typeof params.cid === 'string' ? params.cid : '';
  const { user } = useAuth();
  const [report, setReport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Forever friends can't be blocked: swap this dialog for the Block-locked sheet (alternatives).
  const personId = person?.id ?? null;
  useEffect(() => {
    if (!personId || !user) return;
    void guardBlock(personId, { cid: cid || null, replace: true });
  }, [personId, user, cid]);

  const name = person?.display_name?.trim() || 'this person';
  const first = person?.display_name?.trim().split(/\s+/)[0] || 'They';

  const block = async () => {
    if (!person || !user || busy) return;
    setBusy(true);
    setError(null);
    try {
      await blockUser(person.id);
    } catch (e) {
      if (isForeverLockedError(e)) {
        router.replace(foreverBlockLockedHref(person.id, cid || null));
        return;
      }
      setError(friendlySocialError(e, 'Could not block. Try again.'));
      setBusy(false);
      return;
    }
    let reportFailed = false;
    if (report) {
      const lines = cid ? await lastMessagesFrom(cid, person.id) : [];
      const subject = encodeURIComponent('Report a user on Zoyra');
      const body = encodeURIComponent(
        `I blocked and want to report ${name}.\nUser id: ${person.id}\n${cid ? `Conversation: ${cid}\n` : ''}\nLast messages:\n${lines.length ? lines.join('\n') : '(none)'}\n\nWhat happened:\n`,
      );
      reportFailed = !(await Linking.openURL(`mailto:${REPORT_EMAIL}?subject=${subject}&body=${body}`).then(
        () => true,
        () => false,
      ));
    }
    router.replace(blockedDoneHref(person.id, person.display_name, { avatar: person.avatar_url, reportFailed }));
  };

  if (loaded === undefined && user) {
    return (
      <ModalCard>
        <DialogBody label="Block">
          <DialogTitle>Block</DialogTitle>
          <T size={14} color={colors.textSecondary} align="center">
            Loading…
          </T>
          <DialogButton label="Cancel" onPress={() => go('back')} />
        </DialogBody>
      </ModalCard>
    );
  }

  if (!person || !user) {
    return (
      <ModalCard>
        <DialogBody label="Block">
          <DialogTitle>Block</DialogTitle>
          <T size={14} color={colors.textSecondary} align="center">
            {user ? 'This person is no longer available.' : 'Sign in to block people.'}
          </T>
          <DialogButton label="Close" onPress={() => go('back')} />
        </DialogBody>
      </ModalCard>
    );
  }

  return (
    <ModalCard onDismiss={busy ? () => undefined : undefined}>
      <DialogBody label={`Block ${name}?`}>
        <View style={{ alignItems: 'center', gap: 12 }}>
          <ChatAvatar person={person} size={64} radius={22} />
          <DialogTitle>{`Block ${name}?`}</DialogTitle>
          <T size={14} color={colors.textSecondary} align="center" lineHeight={20}>
            {`${first} won't be told you blocked them. You can unblock any time in Message privacy.`}
          </T>
        </View>
        <View style={{ gap: 10 }} accessibilityRole="list">
          {/* Each fact is enforced server side: start_call / messages refuse blocked pairs; presence_allowed()
              and play_history RLS hide online + listening; Messages hides the chat and the Blend playlist is
              hidden by RLS (20261115210000_calls_extras.sql). */}
          <FactRow icon="chat" text="They can't message or call you" />
          <FactRow icon="eyeOff" text="They won't see when you're online or listening" />
          <FactRow icon="bellOff" text="Your chat and Blend playlist stay hidden" />
        </View>
        <CheckRow checked={report} onChange={setReport} disabled={busy} title="Also report this account" subtitle="Send the last 5 messages to Zoyra for review" />
        <DialogNote text={error} />
        <View style={{ gap: 10 }}>
          <DialogButton label={error ? 'Try again' : 'Block'} kind="danger" busy={busy} onPress={() => void block()} />
          <DialogButton label="Cancel" disabled={busy} onPress={() => go('back')} />
        </View>
      </DialogBody>
    </ModalCard>
  );
}
