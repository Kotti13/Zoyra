import { router, useLocalSearchParams } from 'expo-router';

import { confirmBlockHref, confirmClearHref } from '../lib/confirm-routes';
import { useMemo, useState, type ReactNode } from 'react';
import { Linking, View } from 'react-native';

import { Chip, EmptyState, ErrorState, Glass, Icon, IconButton, Loading, Row, Screen, SkeletonBlock, T, Tap, TextField, Toggle, useAsync, useDebounced } from '../components';
import type { IconName } from '../components/icons';
import { useStartCall } from '../lib/call-ui';
import { CALLS_ENABLED } from '../lib/calls';
import {
  chatError,
  chatPeerParams,
  dayLabel,
  DISAPPEAR_OPTIONS,
  disappearLabel,
  listScheduled,
  loadChat,
  messagePreview,
  decryptChatRows,
  MSG_SELECT,
  peerFromParams,
  setDisappearing,
  setPinned,
  timeOf,
  updateMySettings,
  type ChatMessage,
} from '../lib/chat';
import { loadSharedMedia, myPendingCapsules, starCount } from '../lib/chat-extras';
import { useChatMood } from '../lib/chat-mood';
import { ChatAvatar } from '../lib/chat-ui';
import { ForeverInfoCard } from '../components/forever';
import { useIsForever } from '../lib/forever';
import { searchDecrypted } from '../lib/e2ee';
import { requestState } from '../lib/dm';
import { LAST_SEEN_WHO, lastSeenPrefs, useLastSeen } from '../lib/last-seen';
import { useOnlineUsers } from '../lib/presence';
import { useChatLocks } from '../lib/chat-lock';
import { friendlySocialError, isBlockedWith, useBlocks } from '../lib/social';
import { supabase } from '../lib/supabase';
import { REPORT_EMAIL } from '../lib/youtube';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

const PILL_BG = withAlpha(colors.white, 0.06);
const PILL_BORDER = withAlpha(colors.white, 0.12);
const ONLINE_GREEN = '#2EE59D';

/** Settings-style row from the MsgChatInfo design: 40 px tinted icon, title / value, chevron (68 px). */
function InfoRow({
  title,
  value,
  icon,
  onPress,
  divider,
  right,
  danger,
  label,
}: {
  title: string;
  value?: string;
  icon: IconName;
  onPress?: () => void;
  divider?: boolean;
  right?: ReactNode;
  danger?: boolean;
  label?: string;
}) {
  const tint = danger ? colors.error : colors.accentLight;
  return (
    <Tap
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={label ?? [title, value].filter(Boolean).join(', ')}
      pressScale={0.98}
      style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 68 }, divider ? { borderTopWidth: 1, borderTopColor: withAlpha(colors.white, 0.06) } : null]}
    >
      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: withAlpha(danger ? colors.error : colors.accent, 0.18), alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={19} color={tint} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T size={16} weight={500} color={danger ? colors.error : colors.text} numberOfLines={1}>
          {title}
        </T>
        {value ? (
          <T size={14} color={colors.textSecondary} numberOfLines={1}>
            {value}
          </T>
        ) : null}
      </View>
      {right ?? (onPress ? <Icon name="chevronRight" size={16} color={colors.textSecondary} /> : null)}
    </Tap>
  );
}

function Group({ children }: { children: ReactNode }) {
  return <View style={{ borderRadius: 36, paddingVertical: 4, paddingHorizontal: 16, backgroundColor: PILL_BG, borderWidth: 1, borderColor: PILL_BORDER }}>{children}</View>;
}

/**
 * Chat info (`/chat-info?id=<conversation>[&section=pinned][&uid=&name=&avatar=]`, MsgChatInfo design): the other
 * person (@username · last seen), actions Voice / Video / Search / Mute, the Forever card slot, then Media, links
 * and songs (counts → /chat-media), Starred (→ /starred?cid=), Scheduled (n waiting → /chat-scheduled),
 * Disappearing, Pinned, Last seen and online (→ /last-seen), Chat mood (Auto / Off), Read receipts, Encryption,
 * Block, Report and Clear chat. Group chats open this screen only for their pinned list (`&group=1`).
 */
export default function ChatInfo() {
  const params = useLocalSearchParams<{ id?: string; section?: string; uid?: string; name?: string; avatar?: string; group?: string }>();
  const cid = typeof params.id === 'string' ? params.id : '';
  const seedPeer = useMemo(() => peerFromParams(params.uid, params.name, params.avatar), [params.uid, params.name, params.avatar]);
  const { user, settings } = useAuth();
  const me = user?.id;
  const locked = !!useChatLocks(user?.id)[cid];
  const { blocked, unblock } = useBlocks(me);
  const online = useOnlineUsers();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [showPins, setShowPins] = useState(params.section === 'pinned');
  const [showTimer, setShowTimer] = useState(false);
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 300);
  const [mood, setMood] = useChatMood(cid);

  const snap = useAsync(() => (cid && me ? loadChat(cid, me) : Promise.resolve(null)), [cid, me]);
  const kindQ = useAsync(async () => {
    if (params.group === '1') return 'group';
    if (!cid) return 'direct';
    const { data } = await supabase.from('conversations').select('kind').eq('id', cid).maybeSingle();
    return (data as { kind?: string } | null)?.kind === 'group' ? 'group' : 'direct';
  }, [cid, params.group]);
  const isGroup = kindQ.data === 'group';
  const req = useAsync(() => (cid && me ? requestState(cid).catch(() => 'none' as const) : Promise.resolve('none' as const)), [cid, me]);
  const pending = (req.data ?? 'none') !== 'none';
  // Counts for the rows (none of them block the screen).
  const counts = useAsync(async () => {
    if (!cid || !me || isGroup) return null;
    const [media, stars, sched, caps] = await Promise.all([
      loadSharedMedia(cid).catch(() => null),
      starCount(cid),
      listScheduled(cid).catch(() => []),
      myPendingCapsules(cid, me).catch(() => []),
    ]);
    return {
      media: media ? media.media.length : null,
      links: media ? media.links.length : null,
      songs: media ? media.songs.length : null,
      stars,
      waiting: sched.filter((x) => !x.sent_at && !x.failed).length + caps.length,
    };
  }, [cid, me, isGroup]);
  const [mineEdit, setMine] = useState<{ muted: boolean; read_receipts: boolean } | null>(null);
  const [timerEdit, setTimer] = useState<number | null | undefined>(undefined);
  const loadedMine = snap.data?.mine;
  const mine = mineEdit ?? (loadedMine ? { muted: loadedMine.muted, read_receipts: loadedMine.read_receipts } : null);
  const timer = timerEdit !== undefined ? timerEdit : (snap.data?.conversation?.disappear_seconds ?? null);

  const results = useAsync<ChatMessage[]>(async () => {
    if (!cid || query.length < 2) return [];
    const safe = query.replace(/[%_\\]/g, (c) => `\\${c}`);
    // Server search sees plaintext rows only; encrypted text is searched in this phone's decrypted cache.
    const [server, local] = await Promise.all([
      supabase.from('messages').select(MSG_SELECT).eq('conversation_id', cid).ilike('body', `%${safe}%`).order('created_at', { ascending: false }).limit(40),
      searchDecrypted(query, { conversationId: cid, limit: 40 }).catch(() => []),
    ]);
    if (server.error) throw new Error(server.error.message);
    const rows = (server.data ?? []) as ChatMessage[];
    const have = new Set(rows.map((r) => r.id));
    const extra = local.map((h) => h.id).filter((mid) => !have.has(mid));
    if (extra.length) {
      const more = await supabase.from('messages').select(MSG_SELECT).in('id', extra.slice(0, 40));
      if (!more.error) rows.push(...((more.data ?? []) as ChatMessage[]));
    }
    const out = await decryptChatRows(rows);
    const needle = query.toLowerCase();
    return out.filter((m) => !m.meta?.e2ee || (m.body ?? '').toLowerCase().includes(needle) || messagePreview(m).toLowerCase().includes(needle)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 40);
  }, [cid, query]);

  const s = snap.data;
  const other = s?.other ?? seedPeer;
  const otherId = other?.id;
  const name = other?.display_name || (other?.username ? `@${other.username}` : '') || 'Chat';
  const first = name.split(' ')[0];
  const nameLoading = snap.loading && !other?.display_name;
  const isOnline = !!otherId && online.has(otherId);
  const lastSeen = useLastSeen(isGroup ? null : otherId);
  const forever = useIsForever(isGroup ? null : otherId) === true;
  const seenText = isOnline ? 'online' : lastSeen.label;
  const myLastSeen = LAST_SEEN_WHO.find((w) => w.key === lastSeenPrefs(settings?.dm).last_seen_who)?.title ?? 'Mutuals';

  const hidden = s?.hidden ?? new Set<string>();
  const visible = (s?.messages ?? []).filter((m) => !hidden.has(m.id));
  const byId = new Map(visible.map((m) => [m.id, m]));
  const pins = (s?.pins ?? []).map((p) => byId.get(p.message_id)).filter((m): m is ChatMessage => !!m);
  const iBlocked = !!other && blocked.has(other.id);
  const blockedWith = useAsync(() => (otherId ? isBlockedWith(otherId).catch(() => false) : Promise.resolve(false)), [otherId, iBlocked]);
  const anyBlock = iBlocked || blockedWith.data === true;
  const pullRefresh = () => Promise.all([snap.refresh(), req.refresh(), counts.refresh(), blockedWith.refresh(), query.length >= 2 ? results.refresh() : undefined]);
  const callBlocked = iBlocked ? `Unblock ${name} to call them.` : anyBlock ? 'This account isn’t available.' : pending ? 'You can call once they accept your chat request.' : null;
  const caller = useStartCall(cid, callBlocked);

  const run = async (key: string, fn: () => Promise<void>, ok?: string) => {
    if (busy) return;
    setBusy(key);
    setNote(null);
    try {
      await fn();
      if (ok) setNote({ ok: true, text: ok });
    } catch (e) {
      setNote({ ok: false, text: chatError(e) });
    } finally {
      setBusy(null);
    }
  };

  const setSetting = (patch: { muted?: boolean; read_receipts?: boolean }) => {
    if (!me || !mine) return;
    const prev = mine;
    setMine({ ...mine, ...patch });
    void updateMySettings(cid, me, patch).catch((e: unknown) => {
      setMine(prev);
      setNote({ ok: false, text: chatError(e, 'Setting not saved') });
    });
  };

  const changeTimer = (seconds: number | null) => {
    if (pending) return;
    const prev = timer;
    setTimer(seconds);
    void run('timer', async () => {
      try {
        await setDisappearing(cid, seconds);
      } catch (e) {
        setTimer(prev);
        throw e;
      }
    }, seconds ? `New messages disappear after ${disappearLabel(seconds)}` : 'Disappearing messages off');
  };

  const toggleBlock = () =>
    run('block', async () => {
      if (!other) return;
      if (!iBlocked) {
        router.push(confirmBlockHref(other, cid));
        return;
      }
      try {
        const done = await unblock(other.id, name);
        if (done) setNote({ ok: true, text: `Unblocked ${name}` });
      } catch (e) {
        throw new Error(friendlySocialError(e, 'Could not update block'));
      }
    });

  const report = () => {
    const subject = encodeURIComponent('Report a user on Zoyra');
    const body = encodeURIComponent(`I want to report ${name}${other?.username ? ` (@${other.username})` : ''}.\nUser id: ${other?.id ?? ''}\nConversation: ${cid}\n\nWhat happened:\n`);
    Linking.openURL(`mailto:${REPORT_EMAIL}?subject=${subject}&body=${body}`).catch(() => setNote({ ok: false, text: `No mail app found. Email ${REPORT_EMAIL} with user id ${other?.id ?? ''}.` }));
  };

  const goBack = () => (router.canGoBack() ? router.back() : router.replace({ pathname: isGroup ? '/group-chat' : '/chat-pro', params: { id: cid } }));

  if (!cid || !me) {
    return (
      <Screen top={4}>
        <Row style={{ minHeight: 44 }}>
          <IconButton icon="back" label="Back" size={44} bg={colors.chipGhost} onPress={() => (router.canGoBack() ? router.back() : router.replace('/messages'))} />
        </Row>
        <EmptyState icon="mail" title={me ? 'No conversation selected' : 'Sign in to see chat info'} body="Open a chat first." action="Open messages" onAction={() => router.replace('/messages')} />
      </Screen>
    );
  }

  const header = (
    <Row style={{ minHeight: 44 }}>
      <IconButton icon="back" label="Back" size={44} bg={colors.chipGhost} onPress={goBack} />
    </Row>
  );

  const person = (
    <View style={{ alignItems: 'center', gap: 8 }}>
      <View style={{ width: 96, height: 96 }}>
        <ChatAvatar person={other} size={96} radius={48} />
        {isOnline ? (
          <View accessibilityElementsHidden importantForAccessibility="no" style={{ position: 'absolute', right: 2, bottom: 2, width: 20, height: 20, borderRadius: 10, backgroundColor: ONLINE_GREEN, borderWidth: 3, borderColor: colors.bg }} />
        ) : null}
      </View>
      {nameLoading ? (
        <View style={{ alignItems: 'center', gap: 8, paddingTop: 4 }} accessibilityLabel="Loading">
          <SkeletonBlock width={160} height={22} r={11} />
          <SkeletonBlock width={120} height={12} r={6} />
        </View>
      ) : (
        <>
          <T size={24} weight={600} align="center" accessibilityRole="header" numberOfLines={2}>
            {name}
          </T>
          <T size={13} color={colors.textSecondary} align="center" numberOfLines={1}>
            {[other?.username ? `@${other.username}` : null, seenText].filter(Boolean).join(' · ')}
          </T>
        </>
      )}
    </View>
  );

  if (isGroup) {
    const sender = (uid: string) => (uid === me ? 'You' : 'Member');
    return (
      <Screen onRefresh={pullRefresh} top={4} gap={16} backdrop={{ pattern: 'none', mesh: 'rose', orbs: true }}>
        <Row gap={8} style={{ minHeight: 44 }}>
          <IconButton icon="back" label="Back" size={44} bg={colors.chipGhost} onPress={goBack} />
          <T size={18} weight={700} accessibilityRole="header" style={{ flex: 1 }}>
            Pinned messages
          </T>
          <IconButton icon="info" label="Group info" size={44} bg={colors.chipGhost} onPress={() => router.replace({ pathname: '/group-info', params: { id: cid } })} />
        </Row>
        {note ? (
          <T size={13} color={note.ok ? colors.success : colors.error} align="center" accessibilityLiveRegion="polite">
            {note.text}
          </T>
        ) : null}
        {snap.loading ? (
          <Loading />
        ) : snap.error ? (
          <ErrorState message={snap.error} onRetry={snap.reload} />
        ) : !pins.length ? (
          <EmptyState icon="mail" title="No pinned messages" body="Long-press a message in the group to pin it for everyone." />
        ) : (
          <Glass padding={4} radius={28}>
            {pins.map((m, i) => (
              <Row key={m.id} style={{ paddingVertical: 8, paddingLeft: 12, borderTopWidth: i ? 1 : 0, borderTopColor: colors.divider }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T size={12} color={colors.textSecondary}>
                    {sender(m.sender_id)} · {dayLabel(m.created_at)} {timeOf(m.created_at)}
                  </T>
                  <T size={14} numberOfLines={3}>
                    {messagePreview(m)}
                  </T>
                </View>
                <Tap
                  onPress={() =>
                    void run(`unpin${m.id}`, async () => {
                      await setPinned(cid, m.id, me, false);
                      snap.reload();
                    }, 'Unpinned')
                  }
                  accessibilityLabel={`Unpin message: ${messagePreview(m)}`}
                  style={{ minWidth: 64, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
                >
                  <T size={13} weight={600} color={colors.accentLight}>
                    {busy === `unpin${m.id}` ? '…' : 'Unpin'}
                  </T>
                </Tap>
              </Row>
            ))}
          </Glass>
        )}
      </Screen>
    );
  }

  if (snap.loading || snap.error || !s) {
    return (
      <Screen top={4} gap={16} backdrop={{ pattern: 'none', mesh: 'rose', orbs: true }}>
        {header}
        {person}
        {snap.loading ? <Loading /> : snap.error ? <ErrorState message={snap.error} onRetry={snap.reload} /> : <EmptyState icon="mail" title="Chat not found" body="This conversation is no longer available." />}
      </Screen>
    );
  }

  const actions: { key: string; label: string; icon: IconName; on?: boolean; disabled?: boolean; onPress: () => void }[] = [
    ...(CALLS_ENABLED
      ? [
          { key: 'voice', label: caller.busy === 'audio' ? 'Calling…' : 'Voice', icon: 'call' as IconName, disabled: anyBlock, onPress: () => void caller.start('audio').then((err) => err && setNote({ ok: false, text: err })) },
          { key: 'video', label: caller.busy === 'video' ? 'Calling…' : 'Video', icon: 'video' as IconName, disabled: anyBlock, onPress: () => void caller.start('video').then((err) => err && setNote({ ok: false, text: err })) },
        ]
      : []),
    { key: 'search', label: 'Search', icon: 'search', on: searching, onPress: () => setSearching((v) => !v) },
    { key: 'mute', label: mine?.muted ? 'Unmute' : 'Mute', icon: mine?.muted ? 'bellOff' : 'bell', on: !!mine?.muted, onPress: () => setSetting({ muted: !mine?.muted }) },
  ];
  const c = counts.data;
  const mediaValue = c && c.media !== null ? `${c.media} · ${c.links} · ${c.songs}` : counts.loading ? '…' : 'Photos, links and songs';

  return (
    <Screen onRefresh={pullRefresh} top={4} gap={16} backdrop={{ pattern: 'none', mesh: 'rose', orbs: true }}>
      {header}
      {person}

      <Row gap={10}>
        {actions.map((a) => (
          <Tap
            key={a.key}
            onPress={a.onPress}
            disabled={a.disabled}
            accessibilityRole="button"
            accessibilityLabel={a.label}
            accessibilityState={{ selected: !!a.on, disabled: !!a.disabled }}
            style={{ flex: 1, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', gap: 4, backgroundColor: a.on ? colors.accentTint : PILL_BG, borderWidth: 1, borderColor: a.on ? colors.accent : PILL_BORDER, opacity: a.disabled ? 0.4 : 1 }}
          >
            <Icon name={a.icon} size={20} color={a.on ? colors.accentLight : colors.text} />
            <T size={12} weight={600} numberOfLines={1}>
              {a.label}
            </T>
          </Tap>
        ))}
      </Row>

      {note ? (
        <T size={13} color={note.ok ? colors.success : colors.error} align="center" accessibilityLiveRegion="polite">
          {note.text}
        </T>
      ) : null}

      {searching ? (
        <View style={{ gap: 10 }}>
          <TextField label="Search this chat" hideLabel placeholder="Search messages" icon="search" value={q} onChangeText={setQ} autoFocus returnKeyType="search" />
          {query.length < 2 ? null : results.loading ? (
            <Loading height={80} />
          ) : results.error ? (
            <T size={13} color={colors.error}>
              {results.error}
            </T>
          ) : !results.data?.length ? (
            <T size={14} color={colors.textSecondary}>
              No messages match “{query}”.
            </T>
          ) : (
            <Glass padding={4}>
              {results.data.map((m, i) => (
                <Tap
                  key={m.id}
                  onPress={() => router.dismissTo({ pathname: '/chat-pro', params: { id: cid, jump: m.id, ...chatPeerParams(other) } })}
                  accessibilityLabel={`${m.sender_id === me ? 'You' : name}: ${m.body || messagePreview(m)}. Show in chat`}
                  style={{ paddingVertical: 10, paddingHorizontal: 12, borderTopWidth: i ? 1 : 0, borderTopColor: colors.divider }}
                >
                  <T size={12} color={colors.textSecondary}>
                    {m.sender_id === me ? 'You' : name} · {dayLabel(m.created_at)} {timeOf(m.created_at)}
                  </T>
                  <T size={14}>{m.body || messagePreview(m)}</T>
                </Tap>
              ))}
            </Glass>
          )}
        </View>
      ) : null}

      {!isGroup && other?.id ? <ForeverInfoCard uid={other.id} name={name} /> : null}

      <Group>
        <InfoRow title="Media, links and songs" value={mediaValue} icon="image" onPress={() => router.push({ pathname: '/chat-media', params: { id: cid, ...chatPeerParams(other) } })} />
        <InfoRow divider title="Starred messages" value={c ? String(c.stars) : '…'} icon="star" onPress={() => router.push({ pathname: '/starred', params: { cid } })} />
        <InfoRow
          divider
          title="Scheduled messages"
          value={pending ? 'Available after they accept' : c ? (c.waiting ? `${c.waiting} waiting` : 'None') : '…'}
          icon="clock"
          onPress={pending ? undefined : () => router.push({ pathname: '/chat-scheduled', params: { id: cid } })}
        />
        <InfoRow
          divider
          title="Disappearing messages"
          value={pending ? 'Available after they accept' : busy === 'timer' ? 'Saving…' : disappearLabel(timer)}
          icon="timer"
          onPress={pending ? undefined : () => setShowTimer((v) => !v)}
          right={pending ? false : <Icon name={showTimer ? 'chevronDown' : 'chevronRight'} size={16} color={colors.textSecondary} />}
        />
        {showTimer && !pending ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, paddingBottom: 8 }}>
            {DISAPPEAR_OPTIONS.map((o) => (
              <Chip key={o.label} label={o.label} active={(timer ?? null) === o.seconds} onPress={() => changeTimer(o.seconds)} />
            ))}
          </View>
        ) : null}
        {pins.length ? (
          <>
            <InfoRow divider title="Pinned messages" value={`${pins.length} pinned`} icon="pin" onPress={() => setShowPins((v) => !v)} right={<Icon name={showPins ? 'chevronDown' : 'chevronRight'} size={16} color={colors.textSecondary} />} />
            {showPins ? (
              <View style={{ paddingBottom: 8, gap: 6 }}>
                {pins.map((m) => (
                  <Row key={m.id} style={{ paddingVertical: 4, paddingLeft: 12, borderRadius: 16, backgroundColor: PILL_BG }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T size={12} color={colors.textSecondary}>
                        {m.sender_id === me ? 'You' : name} · {dayLabel(m.created_at)}
                      </T>
                      <T size={14} numberOfLines={2}>
                        {messagePreview(m)}
                      </T>
                    </View>
                    <Tap
                      onPress={() =>
                        void run(`unpin${m.id}`, async () => {
                          await setPinned(cid, m.id, me, false);
                          snap.reload();
                        }, 'Unpinned')
                      }
                      accessibilityLabel={`Unpin message: ${messagePreview(m)}`}
                      style={{ minWidth: 64, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
                    >
                      <T size={13} weight={600} color={colors.accentLight}>
                        {busy === `unpin${m.id}` ? '…' : 'Unpin'}
                      </T>
                    </Tap>
                  </Row>
                ))}
              </View>
            ) : null}
          </>
        ) : null}
      </Group>

      <Group>
        <InfoRow title="Last seen and online" value={myLastSeen} icon="eye" onPress={() => router.push('/last-seen')} />
        <InfoRow
          divider
          title="Chat mood"
          value={mood === 'auto' ? 'Follows the song playing' : 'Off'}
          icon="music"
          label={`Chat mood, ${mood === 'auto' ? 'Auto' : 'Off'}. Tap to change`}
          onPress={() => setMood(mood === 'auto' ? 'off' : 'auto')}
          right={
            <Row gap={4}>
              <T size={13} color={colors.textSecondary}>
                {mood === 'auto' ? 'Auto' : 'Off'}
              </T>
              <Icon name="chevronRight" size={16} color={colors.textSecondary} />
            </Row>
          }
        />
        <InfoRow divider title="Read receipts" value="Show when I have seen" icon="check" right={<Toggle label="Read receipts" value={!!mine?.read_receipts} onChange={(v) => setSetting({ read_receipts: v })} />} />
        <InfoRow divider title="Lock chat" value={locked ? 'Face ID required' : 'Hide behind Face ID'} icon="lock" onPress={() => router.push({ pathname: '/chat-lock', params: { id: cid } })} />
        <InfoRow divider title="Encryption" value="End-to-end encrypted · Verify security code" icon="lock" onPress={otherId ? () => router.push({ pathname: '/e2ee-verify', params: { uid: otherId, name } }) : undefined} />
      </Group>

      <Group>
        <InfoRow title={busy === 'block' ? 'Working…' : iBlocked ? `Unblock ${first}` : `Block ${first}`} value={forever && !iBlocked ? 'Locked · Forever' : undefined} icon="block" danger onPress={other ? () => void toggleBlock() : undefined} />
        <InfoRow divider title="Report" icon="ban" danger onPress={report} />
        <InfoRow divider title="Clear chat" icon="trash" danger onPress={() => router.push(confirmClearHref(cid, other?.display_name))} />
      </Group>
    </Screen>
  );
}
