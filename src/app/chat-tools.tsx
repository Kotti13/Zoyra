import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Button, Chip, Cover, go, Icon, IconButton, ListRow, Loading, Row, Sheet, T, Tap, TextField, useAsync, useDebounced, IconBadge } from '../components';
import type { IconName } from '../components/icons';
import { catalog, type CatalogTrack } from '../lib/catalog';
import { routeIfSetupRequired } from '../lib/chat-e2ee';
import { cancelScheduled, chatError, createJam, DISAPPEAR_OPTIONS, listScheduled, scheduleMessage, sendMessage, setDisappearing, type ChatPerson } from '../lib/chat';
import { useStartCall } from '../lib/call-ui';
import { CALLS_ENABLED } from '../lib/calls';
import { ChatAvatar } from '../lib/chat-ui';
import { createBlend, openSharedQueue, requestState, sendSongSwap, tasteMatch, type TrackLike } from '../lib/dm';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';

type Mode = 'grid' | 'swap' | 'poll' | 'schedule';

type ToolsCtx = { other: ChatPerson | null; disappear: number | null; pins: number; /** Message request not accepted yet: timer and scheduling are refused server-side. */ pending: boolean };

/** The sheet offers Off / 24 hours / 7 days (90 days stays in Chat info). */
const TIMER_OPTIONS = DISAPPEAR_OPTIONS.filter((o) => o.seconds === null || o.seconds <= 604_800);

const whenLabel = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

const startOfHour = (d: Date) => {
  const x = new Date(d);
  x.setMinutes(0, 0, 0);
  return x;
};
function presets(now = new Date()): { label: string; at: Date }[] {
  const inHour = startOfHour(new Date(now.getTime() + 2 * 3_600_000));
  const tonight = new Date(now);
  tonight.setHours(21, 0, 0, 0);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const weekend = new Date(now);
  weekend.setDate(weekend.getDate() + ((6 - weekend.getDay() + 7) % 7 || 7));
  weekend.setHours(10, 0, 0, 0);
  const out = [{ label: `In ~2 hours (${inHour.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})`, at: inHour }];
  if (tonight.getTime() - now.getTime() > 15 * 60_000) out.push({ label: 'Tonight 9 PM', at: tonight });
  out.push({ label: 'Tomorrow 9 AM', at: tomorrow }, { label: 'Saturday 10 AM', at: weekend });
  return out;
}

/**
 * Chat tools sheet (`/chat-tools?id=<conversation>[&mode=swap|poll|schedule]`), opened from the Chat
 * Pro composer. Music tools (Blend, Song swap, Shared queue, Listen together, Lyric reply, Dedicate,
 * Taste match, Poll) and message controls (disappearing timer, scheduled messages, pins, privacy).
 * Everything is a real write: Blend / Swap / Shared queue use the RPCs wrapped in src/lib/dm.ts.
 */
export default function ChatTools() {
  const params = useLocalSearchParams<{ id?: string; mode?: string }>();
  const cid = typeof params.id === 'string' ? params.id : '';
  const initial: Mode = params.mode === 'swap' || params.mode === 'poll' || params.mode === 'schedule' ? params.mode : 'grid';
  const { user, profile } = useAuth();
  const me = user?.id;
  const [mode, setMode] = useState<Mode>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [timerEdit, setTimerEdit] = useState<number | null | undefined>(undefined);

  const ctx = useAsync<ToolsCtx | null>(async () => {
    if (!cid || !me) return null;
    const [other, conv, pins, req] = await Promise.all([
      supabase.from('conversation_members').select('profiles(id, display_name, avatar_url, username)').eq('conversation_id', cid).neq('user_id', me).limit(1).maybeSingle(),
      supabase.from('conversations').select('disappear_seconds').eq('id', cid).maybeSingle(),
      supabase.from('message_pins').select('message_id', { count: 'exact', head: true }).eq('conversation_id', cid),
      requestState(cid).catch(() => 'none' as const),
    ]);
    if (other.error) throw new Error(other.error.message);
    if (conv.error) throw new Error(conv.error.message);
    return {
      other: ((other.data as { profiles: ChatPerson | null } | null)?.profiles ?? null) as ChatPerson | null,
      disappear: (conv.data as { disappear_seconds: number | null } | null)?.disappear_seconds ?? null,
      pins: pins.count ?? 0,
      pending: req !== 'none',
    };
  }, [cid, me], 'app/chat-tools:66');
  const other = ctx.data?.other ?? null;
  const name = other?.display_name ?? 'them';
  const first = name.split(' ')[0];
  const match = useAsync(() => (other ? tasteMatch(other.id) : Promise.resolve(null)), [other?.id], 'app/chat-tools:86');
  const timer = timerEdit !== undefined ? timerEdit : (ctx.data?.disappear ?? null);
  const caller = useStartCall(cid, ctx.data?.pending ? 'You can call once they accept your chat request.' : null, { replace: true });
  const call = (kind: 'audio' | 'video') => void caller.start(kind).then((err) => err && setNote({ ok: false, text: err }));

  const run = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      if (routeIfSetupRequired(e, `/chat-pro?id=${encodeURIComponent(cid)}`)) return;
      setNote({ ok: false, text: chatError(e, 'That didn’t work. Try again.') });
    } finally {
      setBusy(null);
    }
  };

  if (!cid || !me) {
    return (
      <Sheet>
        <T variant="section">Chat tools</T>
        <T size={14} color={colors.textSecondary}>
          {me ? 'Open a chat first.' : 'Sign in to use chat tools.'}
        </T>
        <Button label="Close" height={44} onPress={() => go('back')} />
      </Sheet>
    );
  }

  const noteView = note ? (
    <T size={13} color={note.ok ? colors.success : colors.error} accessibilityLiveRegion="polite">
      {note.text}
    </T>
  ) : null;

  const back = (title: string) => (
    <Row style={{ justifyContent: 'space-between' }}>
      <T variant="section" accessibilityRole="header">
        {title}
      </T>
      {initial === 'grid' ? (
        <Tap onPress={() => setMode('grid')} accessibilityLabel="Back to chat tools" style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 }}>
          <T size={14} color={colors.accentLight}>
            Back
          </T>
        </Tap>
      ) : null}
    </Row>
  );

  if (mode === 'swap') {
    return (
      <Sheet gap={10}>
        {back('Song swap')}
        <T size={13} color={colors.textSecondary} lineHeight={18}>
          Pick one song for {first}. You each get one swap a day, and they rate your pick.
        </T>
        <SongPicker
          busy={busy}
          onPick={(t) =>
            void run(`s${t.id}`, async () => {
              // The RPC stores the track jsonb as given: send the full catalog track so it plays in chat.
              await sendSongSwap(cid, t as unknown as TrackLike);
              go('back');
            })
          }
        />
        {noteView}
      </Sheet>
    );
  }

  if (mode === 'poll') {
    return (
      <Sheet gap={10}>
        {back('Create a poll')}
        <PollComposer
          first={first}
          busy={busy === 'poll'}
          onSend={(question, options) =>
            void run('poll', async () => {
              await sendMessage(cid, me, { kind: 'poll', meta: { question, options } });
              go('back');
            })
          }
        />
        {noteView}
      </Sheet>
    );
  }

  if (mode === 'schedule') {
    return (
      <Sheet gap={10}>
        {back('Schedule a message')}
        <ScheduleComposer cid={cid} me={me} />
      </Sheet>
    );
  }

  const changeTimer = (seconds: number | null) => {
    if (busy || seconds === timer) return;
    const before = timer;
    setTimerEdit(seconds);
    void run('timer', async () => {
      try {
        await setDisappearing(cid, seconds);
      } catch (e) {
        setTimerEdit(before);
        throw e;
      }
    });
  };

  const startListening = () =>
    void run('jam', async () => {
      const jam = await createJam(me, `${profile?.display_name ?? 'My'}'s jam`);
      await sendMessage(cid, me, { kind: 'jam', meta: jam });
      router.replace({ pathname: '/group-listening', params: { id: jam.room_id } });
    });

  const tiles: { key: string; title: string; body: string; icon: IconName; isNew?: boolean; onPress: () => void }[] = [
    {
      key: 'blend',
      title: 'Blend playlist',
      body: 'One mix from both your tastes, updated daily',
      icon: 'library',
      isNew: true,
      onPress: () =>
        void run('blend', async () => {
          const pid = await createBlend(cid);
          router.replace({ pathname: '/playlist', params: { id: pid } });
        }),
    },
    { key: 'swap', title: 'Song swap', body: 'Trade one song a day and rate each pick', icon: 'repeat', isNew: true, onPress: () => setMode('swap') },
    {
      key: 'queue',
      title: 'Shared queue',
      body: 'Both of you add songs to one queue',
      icon: 'queue',
      isNew: true,
      onPress: () =>
        void run('queue', async () => {
          const room = await openSharedQueue(cid);
          router.replace({ pathname: '/group-listening', params: { id: room } });
        }),
    },
    {
      key: 'jam',
      title: 'Listen together',
      body: 'Same song, in sync, with live chat',
      icon: 'users',
      onPress: startListening,
    },
    { key: 'lyric', title: 'Lyric reply', body: 'Reply with a synced lyric line', icon: 'file', onPress: () => router.replace({ pathname: '/chat-attach', params: { id: cid, mode: 'lyric' } }) },
    {
      key: 'dedicate',
      title: 'Dedicate a song',
      body: 'Send a song with a note',
      icon: 'heart',
      onPress: () => router.replace(other ? { pathname: '/dedication', params: { user: other.id } } : '/dedication'),
    },
    {
      key: 'taste',
      title: 'Taste match',
      body: 'Compare your top artists and genres',
      icon: 'chart',
      onPress: () => router.replace(other ? { pathname: '/taste-compare', params: { user: other.id } } : '/taste-compare'),
    },
    { key: 'poll', title: 'Poll', body: `Ask ${first} to pick between songs`, icon: 'chart', onPress: () => setMode('poll') },
  ];

  // Call · Video · Listen · Search · Info. Search returns to the chat with its search bar open.
  const quick: { key: string; label: string; icon: IconName; hint: string; green?: boolean; onPress: () => void }[] = [
    ...(CALLS_ENABLED
      ? [
          { key: 'audio', label: 'Call', icon: 'call' as IconName, hint: `Voice call ${first}`, onPress: () => call('audio') },
          { key: 'video', label: 'Video', icon: 'video' as IconName, hint: `Video call ${first}`, onPress: () => call('video') },
        ]
      : []),
    { key: 'listen', label: 'Listen', icon: 'users', hint: 'Start a jam and listen together', green: true, onPress: startListening },
    {
      key: 'search',
      label: 'Search',
      icon: 'search',
      hint: 'Search messages in this chat',
      onPress: () => router.dismissTo({ pathname: '/chat-pro', params: { id: cid, search: String(Date.now()) } }),
    },
    { key: 'info', label: 'Info', icon: 'info', hint: 'Open chat info', onPress: () => router.replace({ pathname: '/chat-info', params: { id: cid } }) },
  ];

  const matchText = match.data !== null && match.data !== undefined ? ` · ${Math.round(match.data)}% taste match` : '';
  const pinCount = ctx.data?.pins ?? 0;

  return (
    <Sheet gap={14}>
      <Row gap={12}>
        <ChatAvatar person={other} size={40} radius={14} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T size={18} weight={600} accessibilityRole="header">
            Chat tools
          </T>
          <T size={12} color={colors.textSecondary} numberOfLines={1}>
            {ctx.loading ? 'Loading…' : other ? `With ${other.display_name}${matchText}` : 'This chat'}
          </T>
        </View>
        <IconButton icon="close" label="Close" size={44} bg={colors.chipGhost} onPress={() => go('back')} />
      </Row>

      {ctx.error ? (
        <T size={13} color={colors.error}>
          {ctx.error}
        </T>
      ) : null}

      <Row gap={6} style={{ justifyContent: 'space-around' }}>
        {quick.map((a) => {
          const working = busy === (a.key === 'listen' ? 'jam' : a.key) || caller.busy === a.key;
          return (
            <Tap
              key={a.key}
              onPress={a.onPress}
              accessibilityRole="button"
              accessibilityLabel={a.label}
              accessibilityHint={a.hint}
              accessibilityState={{ busy: working }}
              style={{ flex: 1, minHeight: 74, alignItems: 'center', gap: 6 }}
            >
              <View style={{ width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: a.green ? withAlpha(colors.success, 0.18) : colors.chipGhost }}>
                <Icon name={a.icon} size={22} color={a.green ? colors.success : colors.text} />
              </View>
              <T size={11} weight={600}>
                {working ? (caller.busy === a.key ? 'Calling…' : 'Working…') : a.label}
              </T>
            </Tap>
          );
        })}
      </Row>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10 }}>
        {tiles.map((t) => {
          const working = busy === t.key;
          return (
            <Tap
              key={t.key}
              onPress={t.onPress}
              accessibilityRole="button"
              accessibilityLabel={`${t.title}${t.isNew ? ', new' : ''}. ${t.body}`}
              accessibilityState={{ busy: working, disabled: !!busy && !working }}
              pressScale={0.97}
              style={{ width: '48.5%', minHeight: 104, padding: 14, gap: 6, borderRadius: 20, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: working ? colors.accent : withAlpha(colors.white, 0.12) }}
            >
              <IconBadge icon={t.icon} size={36} />
              <T size={14} weight={600}>
                {working ? 'Working…' : t.title}
              </T>
              <T size={11} lineHeight={15} color={colors.textSecondary}>
                {t.body}
              </T>
              {t.isNew ? (
                <View style={{ position: 'absolute', top: 10, right: 10, height: 20, paddingHorizontal: 8, borderRadius: 10, backgroundColor: colors.accent, justifyContent: 'center' }}>
                  <T size={10} weight={700} color={colors.onAccent} tracking={0.4}>
                    NEW
                  </T>
                </View>
              ) : null}
            </Tap>
          );
        })}
      </View>

      {noteView}

      <T variant="overline" color={colors.textSecondary} accessibilityRole="header" style={{ marginHorizontal: 4, marginTop: 4 }}>
        MESSAGE CONTROLS
      </T>
      <View style={{ padding: 14, gap: 12, borderRadius: 26, backgroundColor: withAlpha(colors.white, 0.08), borderWidth: 1, borderColor: withAlpha(colors.white, 0.16) }}>
        <Row gap={10}>
          <Icon name="clock" size={20} color={colors.accentLight} />
          <View style={{ flex: 1, gap: 2 }}>
            <T size={15} weight={600}>
              Disappearing messages
            </T>
            <T size={12} color={colors.textSecondary}>
              {ctx.data?.pending ? 'Available after they accept' : 'New messages vanish after the time you pick'}
            </T>
          </View>
        </Row>
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="Disappearing messages timer"
          accessibilityState={{ disabled: !!ctx.data?.pending }}
          pointerEvents={ctx.data?.pending ? 'none' : 'auto'}
          style={{ flexDirection: 'row', gap: 8, opacity: ctx.data?.pending ? 0.4 : 1 }}
        >
          {TIMER_OPTIONS.map((o) => {
            const on = (timer ?? null) === o.seconds;
            return (
              <Tap
                key={o.label}
                onPress={() => changeTimer(o.seconds)}
                accessibilityRole="radio"
                accessibilityLabel={o.label}
                accessibilityState={{ checked: on }}
                style={{ flex: 1, height: 44, justifyContent: 'center' }}
              >
                <View style={{ height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? colors.accent : withAlpha(colors.white, 0.08), borderWidth: 1, borderColor: on ? 'transparent' : withAlpha(colors.white, 0.16) }}>
                  <T size={13} weight={600} color={on ? colors.onAccent : colors.peach}>
                    {o.label}
                  </T>
                </View>
              </Tap>
            );
          })}
        </View>
        {timer !== null && timer > 604_800 ? (
          <T size={12} color={colors.textSecondary}>
            Currently 90 days. Pick a shorter timer or turn it off.
          </T>
        ) : null}
      </View>

      <View style={{ paddingVertical: 4, borderRadius: 26, backgroundColor: withAlpha(colors.white, 0.08), borderWidth: 1, borderColor: withAlpha(colors.white, 0.16) }}>
        <ListRow
          title="Schedule a message"
          subtitle={ctx.data?.pending ? 'Available after they accept' : 'Send it at a set time'}
          icon="clock"
          minHeight={56}
          onPress={ctx.data?.pending ? undefined : () => setMode('schedule')}
        />
        <ListRow
          divider
          title="Pinned messages"
          subtitle={pinCount ? `${pinCount} pinned in this chat` : 'None yet: long-press a message to pin it'}
          icon="pin"
          minHeight={56}
          onPress={() => router.replace({ pathname: '/chat-info', params: { id: cid, section: 'pinned' } })}
        />
        <ListRow divider title="Message privacy" subtitle="Who can reach you and what they see" icon="lock" minHeight={56} onPress={() => router.replace('/dm-privacy')} />
      </View>
      {ctx.loading ? <Loading height={40} /> : null}
    </Sheet>
  );
}

/* ------------------------------------------------------------------ pickers */

function SongPicker({ busy, onPick }: { busy: string | null; onPick: (t: CatalogTrack) => void }) {
  const { user } = useAuth();
  const { track: nowPlaying } = usePlayerPick('track');
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 300);
  const recent = useAsync<CatalogTrack[]>(async () => {
    if (!user) return [];
    const { data, error } = await supabase.from('play_history').select('track').eq('user_id', user.id).order('played_at', { ascending: false }).limit(60);
    if (error) throw new Error(error.message);
    const seen = new Set<string>();
    const out: CatalogTrack[] = [];
    for (const r of (data ?? []) as { track: CatalogTrack }[]) {
      if (!r.track?.id || seen.has(r.track.id)) continue;
      seen.add(r.track.id);
      out.push(r.track);
    }
    return out.slice(0, 20);
  }, [user?.id], 'app/chat-tools:442');
  const results = useAsync<CatalogTrack[]>(() => (query ? catalog.searchTracks(query, { limit: 20 }) : Promise.resolve([])), [query], 'app/chat-tools:455');

  const list = query ? results : recent;
  const tracks = (query ? [] : nowPlaying ? [nowPlaying] : []).concat((list.data ?? []).filter((t) => t.id !== nowPlaying?.id || !!query));

  return (
    <>
      <TextField label="Search songs" hideLabel placeholder="Search songs" icon="search" value={q} onChangeText={setQ} returnKeyType="search" />
      {!query ? (
        <T variant="overline" color={colors.textSecondary}>
          {nowPlaying ? 'NOW PLAYING + RECENT' : 'RECENTLY PLAYED'}
        </T>
      ) : null}
      {list.loading ? (
        <Loading height={120} />
      ) : list.error ? (
        <T size={13} color={colors.error}>
          {list.error}
        </T>
      ) : !tracks.length ? (
        <T size={14} color={colors.textSecondary}>
          {query ? 'No songs found.' : 'Play something or search above.'}
        </T>
      ) : (
        <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
          {tracks.map((t, i) => (
            <ListRow
              key={`${t.id}-${i}`}
              divider={i > 0}
              title={t.title}
              subtitle={t.artist.name}
              leading={<Cover artwork={t.artwork} id={t.id} size={44} radius={12} />}
              right={busy === `s${t.id}` ? <T size={13} color={colors.textSecondary}>Sending…</T> : <Icon name="arrowRight" size={18} color={colors.textSecondary} />}
              onPress={busy ? undefined : () => onPick(t)}
            />
          ))}
        </ScrollView>
      )}
    </>
  );
}

function PollComposer({ first, busy, onSend }: { first: string; busy: boolean; onSend: (q: string, options: string[]) => void }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const clean = options.map((o) => o.trim()).filter(Boolean);
  const ok = question.trim().length > 0 && clean.length >= 2 && new Set(clean).size === clean.length;
  return (
    <>
      <TextField label="Question" placeholder={`Ask ${first}: opening song for Saturday?`} value={question} onChangeText={setQuestion} maxLength={140} />
      {options.map((o, i) => (
        <TextField
          key={i}
          label={`Option ${i + 1}`}
          hideLabel
          placeholder={`Option ${i + 1}`}
          value={o}
          maxLength={60}
          onChangeText={(t) => setOptions((xs) => xs.map((x, j) => (j === i ? t : x)))}
        />
      ))}
      <Row gap={8}>
        {options.length < 4 ? <Chip label="+ Add option" onPress={() => setOptions((xs) => [...xs, ''])} /> : null}
        {options.length > 2 ? <Chip label="Remove last" onPress={() => setOptions((xs) => xs.slice(0, -1))} /> : null}
      </Row>
      <Button label={busy ? 'Sending…' : 'Send poll'} icon="chart" variant={ok && !busy ? 'primary' : 'disabled'} onPress={ok && !busy ? () => onSend(question.trim(), clean) : undefined} />
    </>
  );
}

function ScheduleComposer({ cid, me }: { cid: string; me: string }) {
  const [body, setBody] = useState('');
  const [choices] = useState(() => presets());
  const [pick, setPick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const pending = useAsync(() => listScheduled(cid), [cid], 'app/chat-tools:531');

  const schedule = async () => {
    const text = body.trim();
    const at = choices[pick]?.at;
    if (!text || !at || busy) return;
    setBusy('add');
    setNote(null);
    try {
      await scheduleMessage(cid, me, text, at);
      setBody('');
      setNote({ ok: true, text: `Scheduled for ${whenLabel(at.toISOString())}` });
      pending.reload();
    } catch (e) {
      setNote({ ok: false, text: chatError(e, 'Could not schedule') });
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (id: string) => {
    if (busy) return;
    setBusy(id);
    try {
      await cancelScheduled(id);
      pending.reload();
    } catch (e) {
      setNote({ ok: false, text: chatError(e, 'Could not cancel') });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <TextField label="Message" placeholder="Message to send later" value={body} onChangeText={setBody} maxLength={2000} multiline />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8 }}>
        {choices.map((c, i) => (
          <Chip key={c.label} label={c.label} active={pick === i} onPress={() => setPick(i)} />
        ))}
      </View>
      <Button label={busy === 'add' ? 'Scheduling…' : 'Schedule'} icon="clock" variant={body.trim() && !busy ? 'primary' : 'disabled'} onPress={() => void schedule()} />
      {note ? (
        <T size={13} color={note.ok ? colors.success : colors.error} accessibilityLiveRegion="polite">
          {note.text}
        </T>
      ) : null}
      {pending.data?.length ? (
        <View style={{ gap: 6 }}>
          <T variant="overline" color={colors.textSecondary}>
            SCHEDULED
          </T>
          {pending.data.map((s) => (
            <Row key={s.id} style={{ paddingVertical: 4, paddingLeft: 12, paddingRight: 4, borderRadius: 16, backgroundColor: withAlpha(colors.white, 0.06) }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <T size={14} numberOfLines={1}>
                  {s.body}
                </T>
                <T size={12} color={s.failed ? colors.error : colors.textSecondary}>
                  {s.failed ? `Not sent (${s.failed === 'blocked' ? 'blocked' : 'no longer in this chat'})` : whenLabel(s.send_at)}
                </T>
              </View>
              <Tap onPress={() => void cancel(s.id)} accessibilityLabel={`Cancel scheduled message: ${s.body}`} style={{ minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center' }}>
                <T size={13} weight={600} color={colors.accentLight}>
                  {busy === s.id ? '…' : 'Cancel'}
                </T>
              </Tap>
            </Row>
          ))}
        </View>
      ) : pending.error ? (
        <T size={13} color={colors.error}>
          {pending.error}
        </T>
      ) : null}
      <T size={12} color={colors.textTertiary} lineHeight={17}>
        Zoyra’s server sends it at the chosen time (within about a minute), even if your phone is off. Because the server sends it, a scheduled message is not end-to-end encrypted.
      </T>
    </>
  );
}
