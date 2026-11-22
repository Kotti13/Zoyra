import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';

import { confirmUnsendHref } from '../lib/confirm-routes';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Button, go, Icon, ListRow, Loading, Row, Sheet, T, Tap, useAsync, IconBadge } from '../components';
import { EmojiPickerSheet } from '../components/EmojiPicker';
import type { IconName } from '../components/icons';
import {
  canEdit,
  chatBus,
  chatError,
  forwardMessage,
  forwardToJam,
  isPrivateKind,
  listConversations,
  listMyJams,
  loadMessage,
  messagePreview,
  QUICK_REACTIONS,
  setPinned,
  toggleReaction,
} from '../lib/chat';
import { decryptErrorOf } from '../lib/chat-e2ee';
import { setStarred } from '../lib/chat-extras';
import { isValidReactionEmoji } from '../lib/emoji';
import { ChatAvatar } from '../lib/chat-ui';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { colors, withAlpha } from '../theme/tokens';

type Ctx = { pinned: boolean; starred: boolean; mine: Set<string>; group: boolean };

/**
 * Message actions sheet (`/chat-actions?id=<conversation>&msg=<message>[&group=1]`), opened by long-pressing a
 * message in Chat Pro. Reactions, Reply, Forward (to your other chats or jam chats), Pin, Save (songs go
 * to Liked songs), Copy, Edit (own text, 15 minutes; `edit_message`) and Delete for me (ConfirmUnsend,
 * which also offers Unsend for your own messages). All writes are real; the chat refreshes when this closes.
 */
export default function ChatActions() {
  const params = useLocalSearchParams<{ id?: string; msg?: string; group?: string }>();
  const groupHint = params.group === '1';
  const cid = typeof params.id === 'string' ? params.id : '';
  const mid = typeof params.msg === 'string' ? params.msg : '';
  const { user } = useAuth();
  const me = user?.id;
  const lib = useLibrary();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [forwarding, setForwarding] = useState(false);

  const msg = useAsync(() => (mid ? loadMessage(mid) : Promise.resolve(null)), [mid], 'app/chat-actions:56');
  const ctx = useAsync<Ctx>(async () => {
    if (!mid || !me) return { pinned: false, starred: false, mine: new Set<string>(), group: groupHint };
    const [p, r, c, st] = await Promise.all([
      supabase.from('message_pins').select('message_id').eq('message_id', mid).maybeSingle(),
      supabase.from('message_reactions').select('emoji').eq('message_id', mid).eq('user_id', me),
      groupHint || !cid ? Promise.resolve({ data: null }) : supabase.from('conversations').select('kind').eq('id', cid).maybeSingle(),
      supabase.from('message_stars').select('message_id').eq('message_id', mid).eq('user_id', me).maybeSingle(),
    ]);
    if (p.error) throw new Error(p.error.message);
    if (r.error) throw new Error(r.error.message);
    const group = groupHint || (c.data as { kind?: string } | null)?.kind === 'group';
    return { pinned: !!p.data, starred: !st.error && !!st.data, mine: new Set(((r.data ?? []) as { emoji: string }[]).map((x) => x.emoji)), group };
  }, [mid, me, cid, groupHint], 'app/chat-actions:57');
  const convs = useAsync(() => (forwarding && me ? listConversations(me, cid) : Promise.resolve([])), [forwarding, me, cid], 'app/chat-actions:70');
  const jams = useAsync(() => (forwarding && me ? listMyJams(me).catch(() => []) : Promise.resolve([])), [forwarding, me], 'app/chat-actions:71');

  const m = msg.data;

  const run = async (key: string, fn: () => Promise<void>, done?: string, close = true) => {
    if (busy) return;
    setBusy(key);
    setNote(null);
    try {
      await fn();
      if (close) go('back');
      else if (done) setNote({ ok: true, text: done });
    } catch (e) {
      setNote({ ok: false, text: chatError(e) });
    } finally {
      setBusy(null);
    }
  };

  if (!cid || !mid || !me) {
    return (
      <Sheet>
        <T variant="section">Message options</T>
        <T size={14} color={colors.textSecondary}>
          {me ? 'This message is no longer available.' : 'Sign in to use message options.'}
        </T>
        <Button label="Close" height={44} onPress={() => go('back')} />
      </Sheet>
    );
  }

  if (msg.loading || ctx.loading) {
    return (
      <Sheet>
        <Loading height={160} />
      </Sheet>
    );
  }

  if (!m) {
    return (
      <Sheet>
        <T variant="section">Message options</T>
        <T size={14} color={colors.textSecondary}>
          {msg.error ?? 'This message is no longer available.'}
        </T>
        <Button label="Close" height={44} onPress={() => go('back')} />
      </Sheet>
    );
  }

  const text = messagePreview(m);
  const pinned = !!ctx.data?.pinned;
  const myReactions = ctx.data?.mine ?? new Set<string>();
  const songToSave = m.track;
  const canSave = !!songToSave;
  const saved = !!m.track && lib.isLiked(m.track.id);
  // Decrypt failed on this phone: nothing to copy, forward or edit.
  const unavailable = !!decryptErrorOf(m);
  // View once photos and time capsules: no forward, copy or save.
  const privateKind = isPrivateKind(m);
  const starred = !!ctx.data?.starred;
  const group = !!ctx.data?.group;
  const canForward = !unavailable && !privateKind && m.kind !== 'voice' && m.kind !== 'photo';
  const editable = !unavailable && canEdit(m, me);

  const react = (emoji: string) => run(`r${emoji}`, () => toggleReaction(cid, mid, me, emoji, !myReactions.has(emoji)));

  if (forwarding) {
    return (
      <Sheet gap={10}>
        <Row style={{ justifyContent: 'space-between' }}>
          <T variant="section" accessibilityRole="header">
            Forward to
          </T>
          <Tap onPress={() => setForwarding(false)} accessibilityLabel="Back to message options" style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' }}>
            <T size={14} color={colors.accentLight}>
              Back
            </T>
          </Tap>
        </Row>
        <T size={13} color={colors.textSecondary} numberOfLines={2}>
          {text}
        </T>
        {convs.loading || jams.loading ? (
          <Loading height={120} />
        ) : convs.error ? (
          <T size={13} color={colors.error}>
            {convs.error}
          </T>
        ) : !convs.data?.length && !jams.data?.length ? (
          <T size={14} color={colors.textSecondary}>
            No other chats or jams yet. Start one from Messages.
          </T>
        ) : (
          <ScrollView style={{ maxHeight: 420 }}>
            {convs.data?.length ? (
              <T variant="overline" color={colors.textSecondary}>
                FRIENDS
              </T>
            ) : null}
            {(convs.data ?? []).map((c, i) => (
              <ListRow
                key={c.id}
                divider={i > 0}
                title={c.other?.display_name ?? 'Chat'}
                subtitle={c.other?.username ? `@${c.other.username}` : undefined}
                leading={<ChatAvatar person={c.other} size={40} />}
                right={busy === c.id ? <T size={13} color={colors.textSecondary}>Sending…</T> : <Icon name="arrowRight" size={18} color={colors.textSecondary} />}
                onPress={() => void run(c.id, () => forwardMessage(m, c.id, me), `Forwarded to ${c.other?.display_name ?? 'chat'}`, false)}
              />
            ))}
            {jams.data?.length ? (
              <T variant="overline" color={colors.textSecondary} style={{ marginTop: 8 }}>
                JAMS
              </T>
            ) : null}
            {(jams.data ?? []).map((j, i) => (
              <ListRow
                key={j.id}
                divider={i > 0}
                title={j.name}
                subtitle="Jam chat · sent as text"
                icon="headphones"
                right={busy === j.id ? <T size={13} color={colors.textSecondary}>Sending…</T> : <Icon name="arrowRight" size={18} color={colors.textSecondary} />}
                onPress={() => void run(j.id, () => forwardToJam(m, j.id, me), `Forwarded to ${j.name}`, false)}
              />
            ))}
          </ScrollView>
        )}
        {note ? (
          <T size={13} color={note.ok ? colors.success : colors.error} accessibilityLiveRegion="polite">
            {note.text}
          </T>
        ) : null}
      </Sheet>
    );
  }

  return (
    <Sheet gap={12}>
      <T size={18} weight={600} accessibilityRole="header">
        Message options
      </T>

      {/* Reactions: one glass pill, five quick emoji + "+" for the full emoji picker. */}
      <Row gap={0} style={{ justifyContent: 'space-between', paddingVertical: 2, paddingHorizontal: 6, borderRadius: 30, backgroundColor: CARD_BG, borderWidth: 1, borderColor: CARD_BORDER }}>
        {QUICK_REACTIONS.map((e) => {
          const on = myReactions.has(e);
          return (
            <Tap
              key={e}
              onPress={() => void react(e)}
              accessibilityLabel={on ? `Remove ${e} reaction` : `React ${e}`}
              accessibilityState={{ selected: on }}
              style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? colors.accentTint : 'transparent' }}
            >
              <T size={26} lineHeight={32}>
                {e}
              </T>
            </Tap>
          );
        })}
        <Tap
          onPress={() => setPickerOpen(true)}
          accessibilityLabel="More reactions"
          accessibilityHint="Opens the emoji picker"
          style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' }}
        >
          <T size={26} lineHeight={32}>
            +
          </T>
        </Tap>
      </Row>
      <EmojiPickerSheet visible={pickerOpen} onClose={() => setPickerOpen(false)} selected={myReactions} onPick={(e) => isValidReactionEmoji(e) && void react(e)} />

      <View style={{ paddingVertical: 12, paddingHorizontal: 14, borderRadius: 22, backgroundColor: colors.accentTint, borderWidth: 1, borderColor: CARD_BORDER }}>
        <T size={14} numberOfLines={3}>
          {text}
        </T>
      </View>

      <View style={{ borderRadius: 36, paddingVertical: 4, paddingHorizontal: 16, backgroundColor: CARD_BG, borderWidth: 1, borderColor: CARD_BORDER }}>
        <OptionRow
          title="Reply"
          subtitle="Quote this message"
          icon="chat"
          onPress={() => {
            chatBus.setEditing(cid, undefined);
            chatBus.setReply(cid, m);
            go('back');
          }}
        />
        {unavailable || m.kind === 'whisper' ? null : (
          <OptionRow
            divider
            title={busy === 'star' ? 'Working…' : starred ? 'Unstar' : 'Star'}
            subtitle={starred ? 'Remove from Starred messages' : 'Save it to Starred messages'}
            icon="star"
            onPress={() => void run('star', () => setStarred(mid, me, !starred), starred ? 'Removed from Starred' : 'Starred', false).then(() => ctx.reload())}
          />
        )}
        {unavailable || privateKind ? null : (
          <OptionRow divider title="Forward" subtitle={canForward ? 'Send to friends or jams' : 'Voice notes and photos stay in this chat'} icon="share" onPress={canForward ? () => setForwarding(true) : undefined} />
        )}
        {unavailable || m.kind === 'whisper' ? null : (
          <OptionRow
            divider
            title="Remind me"
            subtitle="Get a nudge about this message later"
            icon="bell"
            onPress={() => router.push({ pathname: '/remind-me', params: { id: cid, msg: mid, ...(group ? { group: '1' } : {}) } })}
          />
        )}
        <OptionRow
          divider
          title={busy === 'pin' ? 'Working…' : pinned ? 'Unpin message' : 'Pin message'}
          subtitle={pinned ? (group ? 'Remove it from the top for everyone' : 'Remove it from the top') : group ? 'Keep it at the top for everyone in the group' : 'Keep it at the top'}
          icon="pin"
          onPress={() => void run('pin', () => setPinned(cid, mid, me, !pinned))}
        />
        <OptionRow
          divider
          title={saved ? 'Saved to library' : 'Save to library'}
          subtitle={canSave ? (saved ? 'In Liked songs · tap to remove' : 'Keep songs and links') : 'Only songs can be saved'}
          icon="heart"
          onPress={songToSave && !privateKind ? () => void run('save', () => lib.toggleLike(songToSave), saved ? 'Removed from Liked songs' : 'Saved to Liked songs', false) : undefined}
        />
        {unavailable || privateKind ? null : (
          <OptionRow
            divider
            title="Copy"
            subtitle="Copy text"
            icon="copy"
            onPress={() =>
              void run(
                'copy',
                async () => {
                  const ok = await Clipboard.setStringAsync(m.body || text);
                  if (!ok) throw new Error('Could not copy');
                },
                'Copied',
                false,
              )
            }
          />
        )}
        {editable ? (
          <OptionRow
            divider
            title="Edit"
            subtitle="Fix a typo · 15 minutes after sending"
            icon="edit"
            onPress={() => {
              chatBus.setReply(cid, undefined);
              chatBus.setEditing(cid, m);
              go('back');
            }}
          />
        ) : null}
        <OptionRow
          divider
          title={m.sender_id === me ? 'Delete' : 'Delete for me'}
          subtitle={m.sender_id === me ? (group ? 'For you, or for everyone in the group' : 'For you, or for everyone') : 'Remove from this device'}
          icon="trash"
          chevronColor={colors.accentLight}
          onPress={() => router.replace(confirmUnsendHref(mid, cid, { group }))}
        />
      </View>

      {note ? (
        <T size={13} color={note.ok ? colors.success : colors.error} accessibilityLiveRegion="polite">
          {note.text}
        </T>
      ) : null}
    </Sheet>
  );
}

const CARD_BG = withAlpha(colors.white, 0.06);
const CARD_BORDER = withAlpha(colors.white, 0.12);

/** Settings-style row from the design: 40 px tinted icon, title / subtitle, chevron (68 px tall). */
function OptionRow({ title, subtitle, icon, onPress, divider, chevronColor = colors.textSecondary }: { title: string; subtitle: string; icon: IconName; onPress?: () => void; divider?: boolean; chevronColor?: string }) {
  return (
    <Tap
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      accessibilityState={onPress ? undefined : { disabled: true }}
      pressScale={0.98}
      style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 68, opacity: onPress ? 1 : 0.5 }, divider ? { borderTopWidth: 1, borderTopColor: colors.divider } : null]}
    >
      <IconBadge icon={icon} size={40} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T size={16} weight={500}>
          {title}
        </T>
        <T size={14} color={colors.textSecondary}>
          {subtitle}
        </T>
      </View>
      {onPress ? <Icon name="chevronRight" size={16} color={chevronColor} /> : null}
    </Tap>
  );
}
