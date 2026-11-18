import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, KeyboardAvoidingView, Share, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Cover, EmptyState, ErrorState, Glass, Gradient, Icon, IconButton, Loading, Row, Screen, ScreenHeader, T, Tap, Toast, Toggle, TrackItem, go, useAsync, useDebounced, useReduceMotion, ToggleBurst } from '../components';
import type { IconName } from '../components';
import { catalog, type CatalogTrack } from '../lib/catalog';
import {
  deleteSession,
  endSession,
  formatCount,
  formatWhen,
  friendlyLiveError,
  liveLink,
  loadFollowing,
  loadTracks,
  reminderCount,
  replayExpiresAt,
  setFollow,
  setReminder,
  sinceShort,
  startScheduled,
  useLiveSession,
  type LiveApi,
  type LiveSession,
  type Reaction,
} from '../lib/live';
import { HostAvatar, LiveBadge } from '../lib/live-ui';
import { confirmAction } from '../lib/social';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { usePlayer } from '../state/player';
import { colors, fonts, withAlpha } from '../theme/tokens';

const REACTIONS: { icon: IconName; label: string; color: string; filled?: boolean }[] = [
  { icon: 'heart', label: 'React with heart', color: colors.like, filled: true },
  { icon: 'flame', label: 'React with flame', color: colors.amber },
  { icon: 'star', label: 'React with star', color: colors.accentLight, filled: true },
  { icon: 'bolt', label: 'React with bolt', color: colors.amber },
];
const reactionFor = (icon: string) => REACTIONS.find((r) => r.icon === icon);

const backdrop = {
  pattern: 'none' as const,
  mesh: 'none' as const,
  glows: [
    { x: 0.5, y: 0, color: colors.accent, opacity: 0.3 },
    { x: 0, y: 0.6, color: colors.accentDark, opacity: 0.2 },
  ],
};

const DARK = withAlpha(colors.black, 0.42);

export default function LiveRoom() {
  const { id: rawId } = useLocalSearchParams<{ id?: string }>();
  const id = typeof rawId === 'string' && rawId ? rawId : undefined;
  const { user } = useAuth();
  const api = useLiveSession(id, user?.id);
  const { session } = api;

  if (!id || api.loading || api.error || !session) {
    return (
      <Screen top={4} gap={16} backdrop={backdrop}>
        <ScreenHeader title="Live" />
        {api.loading && id ? (
          <Loading />
        ) : (
          <ErrorState message={api.error ?? 'This live session no longer exists.'} onRetry={id ? () => void api.reload() : undefined} />
        )}
      </Screen>
    );
  }
  if (session.status === 'scheduled') return <Scheduled session={session} api={api} me={user?.id} />;
  if (session.status === 'ended') return <Ended session={session} me={user?.id} />;
  return <OnAir api={api} me={user?.id} />;
}

/* ================================================================== live */

type Panel = null | 'requests' | 'settings';

function OnAir({ api, me }: { api: LiveApi; me: string | undefined }) {
  const session = api.session as LiveSession;
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const player = usePlayer();
  const [panel, setPanel] = useState<Panel>(null);
  const [picker, setPicker] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [following, setFollowing] = useState<boolean | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const host = session.host;
  const hostName = api.isHost ? 'You' : host?.display_name ?? 'Host';

  useEffect(() => {
    if (!me || api.isHost) return;
    let alive = true;
    loadFollowing(me, [session.host_id])
      .then((s) => alive && setFollowing(s.has(session.host_id)))
      .catch(() => alive && setFollowing(null));
    return () => {
      alive = false;
    };
  }, [me, api.isHost, session.host_id]);

  const nowTrack: CatalogTrack | null = api.isHost ? player.track : api.hostState?.track ?? null;
  const inSync = !api.isHost && api.following && !!nowTrack && player.track?.id === nowTrack.id;
  const canChat = api.isHost || session.chat_enabled;
  const canRequest = api.isHost || session.requests_enabled;

  const toggleFollow = async () => {
    if (!me || following === null || followBusy) return;
    setFollowBusy(true);
    try {
      await setFollow(me, session.host_id, !following);
      setFollowing(!following);
    } catch (e) {
      api.setNote({ ok: false, text: friendlyLiveError(e) });
    } finally {
      setFollowBusy(false);
    }
  };

  const share = async () => {
    await Share.share({ message: `${api.isHost ? 'I’m' : `${host?.display_name ?? 'Someone'} is`} live on Zoyra: “${session.title}”. Listen along\n${liveLink(session.id)}` }).catch(() => undefined);
  };

  const send = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    const ok = await api.say(draft);
    if (ok) setDraft('');
    setSending(false);
  };

  const close = async () => {
    if (!api.isHost) {
      go('back');
      return;
    }
    const end = await confirmAction('End live session?', 'Listeners will be disconnected. To keep the session going, stay on this screen while you play music.', 'End live');
    if (end && (await api.end())) go('back');
  };

  const lines = api.chat.slice(-5);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Art backdrop: the song everyone is hearing. */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {nowTrack ? <Cover artwork={nowTrack.artwork} id={nowTrack.id} width={width} height={height} radius={0} /> : <Gradient colors={[colors.accentDark, colors.bg]} angle={180} style={StyleSheet.absoluteFill} />}
        <Gradient colors={[withAlpha(colors.bg, 0.35), withAlpha(colors.bg, 0.55), withAlpha(colors.bg, 0.96)]} angle={180} style={StyleSheet.absoluteFill} />
      </View>

      <FloatingReactions list={api.reactions} />

      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <View style={{ flex: 1, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 12, paddingHorizontal: 12 }}>
          {/* Top bar: host pill, listener count, close. */}
          <Row gap={8}>
            <Glass radius={32} padding={6} style={{ flex: 1, minWidth: 0 }}>
              <Row gap={8}>
                <HostAvatar p={host} size={36} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T size={13} weight={600} numberOfLines={1}>
                    {hostName}
                  </T>
                  <T size={11} color={colors.textSecondary} numberOfLines={1}>
                    {session.title}
                  </T>
                </View>
                {!api.isHost && following !== null ? (
                  <Tap
                    onPress={() => void toggleFollow()}
                    accessibilityLabel={following ? `Unfollow ${hostName}` : `Follow ${hostName}`}
                    accessibilityState={{ selected: following, busy: followBusy }}
                    style={{ height: 44, justifyContent: 'center' }}
                  >
                    <ToggleBurst active={!!following}>
                      <View style={{ height: 32, paddingHorizontal: 14, borderRadius: 16, justifyContent: 'center', backgroundColor: following ? colors.chipGhost : colors.accent }}>
                        <T size={12} weight={700} color={colors.white}>
                          {following ? 'Following' : 'Follow'}
                        </T>
                      </View>
                    </ToggleBurst>
                  </Tap>
                ) : null}
              </Row>
            </Glass>
            <Row gap={6} style={{ height: 40, paddingHorizontal: 12, borderRadius: 20, backgroundColor: DARK }} accessible accessibilityLabel={`${api.listeners} listening now`}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent }} />
              <T size={12} weight={700}>
                {formatCount(api.listeners)}
              </T>
            </Row>
            <IconButton icon="close" label={api.isHost ? 'End live session' : 'Leave live session'} bg={DARK} onPress={() => void close()} />
          </Row>

          <View style={{ flex: 1 }} />

          {/* Chat over the art + action rail. */}
          <Row align="flex-end" gap={10}>
            <View style={{ flex: 1, minWidth: 0, gap: 8 }} accessibilityLiveRegion="polite">
              {!canChat ? (
                <T size={12} color={colors.textSecondary}>
                  Live chat is off for this session.
                </T>
              ) : null}
              {lines.map((l) => {
                const who = l.user_id === me ? 'You' : l.name || api.people[l.user_id]?.name || (l.user_id === session.host_id ? host?.display_name ?? 'Host' : 'Listener');
                const avatar = l.avatar ?? api.people[l.user_id]?.avatar ?? null;
                return (
                  <Row key={l.key} gap={8} style={{ alignSelf: 'flex-start', maxWidth: '92%', paddingVertical: 6, paddingLeft: 6, paddingRight: 14, borderRadius: 22, backgroundColor: DARK, opacity: l.pending ? 0.6 : 1 }}>
                    <HostAvatar p={{ id: l.user_id, display_name: who, avatar_url: avatar }} size={30} />
                    <View style={{ flexShrink: 1 }}>
                      <T size={11} weight={600} color={l.user_id === session.host_id ? colors.accentLight : colors.textSecondary}>
                        {l.user_id === session.host_id && l.user_id !== me ? `${who} · host` : who}
                      </T>
                      <T size={13}>{l.text}</T>
                    </View>
                  </Row>
                );
              })}
            </View>
            <View style={{ gap: 12 }}>
              <IconButton icon="heart" label="React" bg={DARK} filled={picker} color={picker ? colors.like : colors.text} onPress={() => setPicker((v) => !v)} />
              <IconButton icon="share" label="Share live session" bg={DARK} onPress={() => void share()} />
              {canRequest ? (
                <View>
                  <IconButton icon="queue" label={api.isHost ? `Requests and songs, ${api.requests.length} requests` : 'Request a song'} bg={panel === 'requests' ? colors.accentTint : DARK} onPress={() => setPanel((p) => (p === 'requests' ? null : 'requests'))} />
                  {api.isHost && api.requests.length ? (
                    <View pointerEvents="none" style={{ position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }}>
                      <T size={10} weight={700} color={colors.white}>
                        {api.requests.length}
                      </T>
                    </View>
                  ) : null}
                </View>
              ) : null}
              {api.isHost ? <IconButton icon="sliders" label="Session settings" bg={panel === 'settings' ? colors.accentTint : DARK} onPress={() => setPanel((p) => (p === 'settings' ? null : 'settings'))} /> : null}
            </View>
          </Row>

          {picker ? (
            <Row style={{ justifyContent: 'space-between', marginTop: 10 }}>
              {REACTIONS.map((r) => (
                <Tap key={r.icon} accessibilityLabel={r.label} onPress={() => api.react(r.icon)} style={{ width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: DARK }}>
                  <Icon name={r.icon} size={26} color={r.color} filled={r.filled} />
                </Tap>
              ))}
            </Row>
          ) : null}

          {api.note ? (
            <View style={{ marginTop: 10 }}>
              <Toast icon={api.note.ok ? 'check' : 'info'} iconColor={api.note.ok ? colors.success : colors.error} message={api.note.text} action="OK" onAction={() => api.setNote(null)} />
            </View>
          ) : null}

          {panel ? (
            <Glass padding={12} style={{ marginTop: 10, maxHeight: height * 0.45 }}>
              {panel === 'requests' ? <RequestsPanel api={api} me={me} /> : <SettingsPanel api={api} />}
            </Glass>
          ) : null}

          {/* Now playing + composer. */}
          <View style={{ gap: 10, marginTop: 12 }}>
            <Glass radius={36} padding={10}>
              <Row gap={12}>
                {nowTrack ? <Cover artwork={nowTrack.artwork} id={nowTrack.id} size={48} radius={24} /> : <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.chipGhost, alignItems: 'center', justifyContent: 'center' }}><Icon name="music" size={22} color={colors.textSecondary} /></View>}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T size={15} weight={600} numberOfLines={1}>
                    {nowTrack?.title ?? (api.isHost ? 'Play a song to start' : 'Waiting for the host…')}
                  </T>
                  <T size={12} color={inSync || api.isHost ? colors.textSecondary : colors.amber} numberOfLines={1}>
                    {api.isHost
                      ? nowTrack
                        ? `On air · ${nowTrack.artist.name}`
                        : 'Tap the queue button to pick songs'
                      : !api.following
                        ? 'Not in sync · tap to listen along'
                        : nowTrack
                          ? `${inSync ? 'In sync' : 'Syncing…'} · ${nowTrack.artist.name}`
                          : 'Nothing playing yet'}
                  </T>
                </View>
                {api.isHost ? (
                  <>
                    <IconButton icon={player.playing ? 'pause' : 'play'} label={player.playing ? 'Pause for everyone' : 'Play for everyone'} bg={colors.accent} color={colors.white} filled onPress={player.toggle} />
                    <IconButton icon="next" label={api.requests.length ? 'Play top request' : 'Next song'} onPress={() => void api.next()} />
                  </>
                ) : (
                  <Tap
                    onPress={() => api.followAlong(!api.following)}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: api.following }}
                    accessibilityLabel="Listen along with the host"
                    style={{ height: 44, justifyContent: 'center' }}
                  >
                    <View style={{ height: 32, paddingHorizontal: 12, borderRadius: 16, justifyContent: 'center', backgroundColor: api.following ? colors.chipGhost : colors.accent }}>
                      <T size={12} weight={700} color={colors.white}>
                        {api.following ? 'Synced' : 'Rejoin'}
                      </T>
                    </View>
                  </Tap>
                )}
              </Row>
            </Glass>

            {canChat ? (
              <Row gap={8} style={{ height: 48, borderRadius: 24, backgroundColor: DARK, borderWidth: 1, borderColor: colors.glassBorder, paddingLeft: 16, paddingRight: 4 }}>
                <TextInput
                  value={draft}
                  onChangeText={setDraft}
                  placeholder="Say something…"
                  placeholderTextColor={colors.textSecondary}
                  accessibilityLabel="Chat message"
                  maxLength={500}
                  returnKeyType="send"
                  onSubmitEditing={() => void send()}
                  style={{ flex: 1, height: 44, color: colors.text, fontFamily: fonts.regular, fontSize: 15 }}
                />
                <IconButton icon="next" label={sending ? 'Sending' : 'Send message'} size={40} iconSize={18} color={draft.trim() ? colors.white : colors.textSecondary} bg={draft.trim() ? colors.accent : undefined} onPress={() => void send()} />
              </Row>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function SettingsPanel({ api }: { api: LiveApi }) {
  const s = api.session as LiveSession;
  return (
    <View style={{ gap: 4 }}>
      <Row style={{ minHeight: 56 }}>
        <View style={{ flex: 1 }}>
          <T size={15} weight={500}>
            Live chat
          </T>
          <T size={13} color={colors.textSecondary}>
            {s.chat_enabled ? 'Listeners can comment' : 'Only you can post'}
          </T>
        </View>
        <Toggle value={s.chat_enabled} onChange={(v) => void api.updateToggles({ chat_enabled: v })} label="Live chat" />
      </Row>
      <Row style={{ minHeight: 56, borderTopWidth: 1, borderTopColor: colors.divider }}>
        <View style={{ flex: 1 }}>
          <T size={15} weight={500}>
            Song requests
          </T>
          <T size={13} color={colors.textSecondary}>
            {s.requests_enabled ? 'Listeners request tracks' : 'Requests are off'}
          </T>
        </View>
        <Toggle value={s.requests_enabled} onChange={(v) => void api.updateToggles({ requests_enabled: v })} label="Song requests" />
      </Row>
      <T size={12} color={colors.textSecondary} style={{ paddingTop: 6 }}>
        {s.save_replay ? `Replay is on: the tracklist stays available for 7 days after you end.` : 'Replay is off: nothing is kept after you end.'}
        {s.peak_listeners ? ` Peak: ${s.peak_listeners} listening.` : ''}
      </T>
    </View>
  );
}

function RequestsPanel({ api, me }: { api: LiveApi; me: string | undefined }) {
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim());
  const results = useAsync<CatalogTrack[]>(() => (q ? catalog.searchTracks(q, { limit: 8 }) : Promise.resolve([])), [q]);
  const host = api.isHost;

  return (
    <View style={{ gap: 10, flexShrink: 1 }}>
      <Row gap={8} style={{ height: 44, borderRadius: 22, backgroundColor: colors.bgTertiary, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 }}>
        <Icon name="search" size={18} color={colors.textSecondary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={host ? 'Search a song to play now' : 'Search a song to request'}
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel={host ? 'Search a song to play' : 'Search a song to request'}
          returnKeyType="search"
          style={{ flex: 1, height: 40, color: colors.text, fontFamily: fonts.regular, fontSize: 15 }}
        />
      </Row>
      <Animated.ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={{ flexShrink: 1 }} contentContainerStyle={{ gap: 4 }}>
        {q ? (
          results.loading ? (
            <Loading height={60} />
          ) : results.error ? (
            <ErrorState message={results.error} onRetry={results.reload} />
          ) : !results.data?.length ? (
            <T size={13} color={colors.textSecondary} align="center" style={{ paddingVertical: 10 }}>
              {`No songs match “${q}”`}
            </T>
          ) : (
            results.data.map((t) => (
              <Row key={t.id} style={{ minHeight: 56 }}>
                <Cover artwork={t.artwork} id={t.id} size={40} radius={12} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T size={14} weight={500} numberOfLines={1}>
                    {t.title}
                  </T>
                  <T size={12} color={colors.textSecondary} numberOfLines={1}>
                    {t.artist.name}
                  </T>
                </View>
                {host ? (
                  <>
                    <IconButton icon="play" label={`Play ${t.title} now`} color={colors.accentLight} onPress={() => api.playForAll(t)} />
                    <IconButton icon="plus" label={`Add ${t.title} to up next`} color={colors.textSecondary} onPress={() => void api.requestSong(t)} />
                  </>
                ) : (
                  <IconButton icon="plus" label={`Request ${t.title}`} color={colors.accentLight} onPress={() => void api.requestSong(t)} />
                )}
              </Row>
            ))
          )
        ) : null}

        <T variant="caption" color={colors.textSecondary} style={{ paddingTop: 6 }}>
          {host ? `REQUESTS · ${api.requests.length}` : 'REQUESTED SONGS · VOTE TO PUSH THEM UP'}
        </T>
        {!api.requests.length ? (
          <T size={13} color={colors.textSecondary} style={{ paddingVertical: 8 }}>
            {host ? 'No requests yet. Search above to play something.' : 'No requests yet. Search above to ask for a song.'}
          </T>
        ) : (
          api.requests.map((r) => (
            <Row key={r.id} style={{ minHeight: 56 }}>
              <Cover artwork={r.track.artwork} id={r.track.id} size={40} radius={12} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T size={14} weight={500} numberOfLines={1}>
                  {r.track.title}
                </T>
                <T size={12} color={colors.textSecondary} numberOfLines={1}>
                  {`by ${r.added_by === me ? 'you' : r.profiles?.display_name ?? 'a listener'}`}
                </T>
              </View>
              <Tap
                onPress={() => void api.vote(r)}
                accessibilityLabel={`Vote for ${r.track.title}, ${r.votes} votes`}
                accessibilityState={{ selected: api.voted.has(r.id) }}
                style={{ minWidth: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
              >
                <Icon name="chevronUp" size={18} color={api.voted.has(r.id) ? colors.accentLight : colors.textSecondary} />
                <T mono size={11} color={api.voted.has(r.id) ? colors.accentLight : colors.textSecondary}>
                  {r.votes}
                </T>
              </Tap>
              {host ? <IconButton icon="play" label={`Play ${r.track.title} now`} color={colors.accentLight} onPress={() => void api.playRequest(r)} /> : null}
              {host || r.added_by === me ? <IconButton icon="close" label={`Remove ${r.track.title}`} color={colors.textSecondary} onPress={() => void api.removeRequest(r)} /> : null}
            </Row>
          ))
        )}
      </Animated.ScrollView>
    </View>
  );
}

function Floater({ r }: { r: Reaction }) {
  const reduce = useReduceMotion();
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: reduce ? 0 : 2400, useNativeDriver: true }).start();
  }, [v, reduce]);
  const def = reactionFor(r.icon);
  if (!def) return null;
  return (
    <Animated.View
      style={{
        position: 'absolute',
        bottom: 200,
        left: `${Math.round(r.x * 80)}%`,
        opacity: v.interpolate({ inputRange: [0, 0.15, 0.8, 1], outputRange: [0, 1, 1, 0] }),
        transform: reduce ? [] : [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -280] }) }, { scale: v.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0.6, 1.2, 1] }) }],
      }}
    >
      <Icon name={def.icon} size={36} color={def.color} filled={def.filled} />
    </Animated.View>
  );
}

function FloatingReactions({ list }: { list: Reaction[] }) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {list.map((r) => (
        <Floater key={r.key} r={r} />
      ))}
    </View>
  );
}

/* ================================================================== scheduled */

function Scheduled({ session, api, me }: { session: LiveSession; api: LiveApi; me: string | undefined }) {
  const isHost = session.host_id === me;
  const [reminded, setReminded] = useState<boolean | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!me) return;
    let alive = true;
    if (isHost) {
      reminderCount(session.id)
        .then((n) => alive && setCount(n))
        .catch(() => undefined);
    } else {
      void supabase
        .from('live_reminders')
        .select('session_id')
        .eq('session_id', session.id)
        .eq('user_id', me)
        .maybeSingle()
        .then(({ data, error }) => alive && setReminded(error ? null : !!data));
    }
    return () => {
      alive = false;
    };
  }, [me, isHost, session.id]);

  const act = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      if (ok) setNote({ ok: true, text: ok });
    } catch (e) {
      setNote({ ok: false, text: friendlyLiveError(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen top={4} gap={20} backdrop={backdrop}>
      <ScreenHeader title="Upcoming live" />
      <View style={{ alignItems: 'center', gap: 12, paddingTop: 12 }}>
        <HostAvatar p={session.host} size={96} ring />
        <T size={14} color={colors.textSecondary}>
          {isHost ? 'Your scheduled session' : session.host?.display_name ?? 'Someone'}
        </T>
        <T variant="display" weight={300} size={34} tracking={-0.8} align="center">
          {session.title}
        </T>
        <Row gap={8}>
          <Icon name="clock" size={18} color={colors.accentLight} />
          <T size={16} weight={500}>
            {session.scheduled_at ? formatWhen(session.scheduled_at) : 'Soon'}
          </T>
        </Row>
        <T size={13} color={colors.textSecondary} align="center">
          {[session.chat_enabled ? 'Live chat' : null, session.requests_enabled ? 'Song requests' : null, session.save_replay ? 'Replay for 7 days' : null].filter(Boolean).join(' · ') || 'Listen along'}
        </T>
      </View>

      {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.error} message={note.text} /> : null}

      {isHost ? (
        <View style={{ gap: 10 }}>
          {count !== null ? (
            <T size={14} color={colors.textSecondary} align="center">
              {count === 0 ? 'No one has asked for a reminder yet.' : `${count} ${count === 1 ? 'person' : 'people'} will be notified when you start.`}
            </T>
          ) : null}
          <Button
            label={busy ? 'Starting…' : 'Start now'}
            icon="cast"
            variant={busy || !me ? 'disabled' : 'primary'}
            onPress={() =>
              void act(async () => {
                if (!me) return;
                await startScheduled(me, session);
                await api.reload();
              })
            }
          />
          <Button
            label="Cancel session"
            variant={busy ? 'disabled' : 'destructive'}
            onPress={() =>
              void (async () => {
                const ok = await confirmAction('Cancel scheduled session?', 'People who asked to be notified won’t be told.', 'Cancel session');
                if (!ok) return;
                await act(async () => {
                  await endSession(session.id);
                  router.replace('/live-hub');
                });
              })()
            }
          />
        </View>
      ) : (
        <Button
          label={reminded ? 'You’ll be notified' : 'Notify me'}
          icon="bell"
          variant={busy || reminded === null ? 'disabled' : reminded ? 'secondary' : 'primary'}
          onPress={() =>
            void act(async () => {
              if (!me || reminded === null) return;
              await setReminder(me, session.id, !reminded);
              setReminded(!reminded);
            }, reminded ? 'Reminder removed' : 'We’ll notify you when it starts')
          }
        />
      )}
    </Screen>
  );
}

/* ================================================================== ended / replay */

function Ended({ session, me }: { session: LiveSession; me: string | undefined }) {
  const isHost = session.host_id === me;
  const player = usePlayer();
  const tracks = useAsync(() => (session.save_replay ? loadTracks(session.id) : Promise.resolve([])), [session.id, session.save_replay]);
  const [note, setNote] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const exp = replayExpiresAt(session);
  const expired = !!exp && exp.getTime() < now;
  const list = (tracks.data ?? []).map((r) => r.track);
  const ctx = `Replay · ${session.title}`;
  const deleting = useRef(false);

  const playAll = useCallback(() => {
    const res = player.playTracks(list, 0, ctx);
    if (!res.played) setNote(res.reason ?? 'These songs can’t play right now.');
    else if (res.skipped) setNote(`${res.skipped} song${res.skipped === 1 ? '' : 's'} skipped${res.reason ? `: ${res.reason}` : ''}`);
  }, [player, list, ctx]);

  const remove = async () => {
    if (deleting.current) return;
    const ok = await confirmAction('Delete this session?', 'The replay and its tracklist are removed for everyone.', 'Delete');
    if (!ok) return;
    deleting.current = true;
    try {
      await deleteSession(session.id);
      router.replace('/live-hub');
    } catch (e) {
      setNote(friendlyLiveError(e));
      deleting.current = false;
    }
  };

  return (
    <Screen top={4} gap={20} backdrop={backdrop}>
      <ScreenHeader title={session.save_replay ? 'Replay' : 'Live ended'} right={isHost ? <IconButton icon="trash" label="Delete session" color={colors.textSecondary} onPress={() => void remove()} /> : undefined} />
      <View style={{ gap: 10 }}>
        <Row>
          <HostAvatar p={session.host} size={44} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={15} weight={600} numberOfLines={1}>
              {isHost ? 'You' : session.host?.display_name ?? 'Someone'}
            </T>
            <T size={12} color={colors.textSecondary}>
              {session.ended_at ? `Ended ${sinceShort(session.ended_at, now)} ago` : 'Ended'}
              {session.peak_listeners ? ` · peak ${formatCount(session.peak_listeners)} listening` : ''}
            </T>
          </View>
          <LiveBadge label="ENDED" />
        </Row>
        <T variant="display" weight={300} size={34} tracking={-0.8}>
          {session.title}
        </T>
      </View>

      {note ? <Toast icon="info" iconColor={colors.amber} message={note} action="OK" onAction={() => setNote(null)} /> : null}

      {!session.save_replay ? (
        <EmptyState icon="clock" title="No replay saved" body="The host didn’t save a replay for this session." action="Browse live" href="/live-hub" />
      ) : expired && !isHost ? (
        <EmptyState icon="clock" title="This replay has expired" body="Replays are available for 7 days after a session ends." action="Browse live" href="/live-hub" />
      ) : tracks.loading ? (
        <Loading />
      ) : tracks.error ? (
        <ErrorState message={tracks.error} onRetry={tracks.reload} />
      ) : !list.length ? (
        <EmptyState icon="music" title="No songs were played" body="Nothing was recorded for this replay." />
      ) : (
        <View style={{ gap: 12 }}>
          <Row>
            <T size={14} color={colors.textSecondary} style={{ flex: 1 }}>
              {`${list.length} song${list.length === 1 ? '' : 's'}${exp && !expired ? ` · available until ${formatWhen(exp)}` : expired ? ' · expired (only you can see it)' : ''}`}
            </T>
          </Row>
          <Button label="Play replay" icon="play" onPress={playAll} />
          <View>
            {list.map((t, i) => (
              <TrackItem key={`${t.id}-${i}`} track={t} list={list} index={i} context={ctx} />
            ))}
          </View>
        </View>
      )}
    </Screen>
  );
}
