import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { EmptyState, ErrorState, Glass, IconButton, ListRow, LiveDot, Loading, Row, Screen, ScreenHeader, T, Tap, useAsync } from '../components';
import { PersonAvatar } from '../features/profile-ui';
import { chatPeerParams } from '../lib/chat';
import { startChat } from '../lib/dm';
import { flash } from '../lib/flash';
import { loadAvatarArts } from '../lib/profile';
import type { CatalogTrack } from '../lib/catalog';
import { friendlySocialError, useBlocks } from '../lib/social';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

type Person = { id: string; display_name: string; avatar_url: string | null };
const NO_ARTS = new Map<string, string>();
type HistoryRow = { user_id: string; track: CatalogTrack; played_at: string };
type Activity = HistoryRow & { person: Person };
type Match = { person: Person; value: number; shared: string[] };

const LIVE_MS = 10 * 60_000;

function ago(iso: string, now: number) {
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'Yesterday' : `${d} days ago`;
}

/** Cosine similarity of two count maps (0..1). */
function cosine(a: Map<string, number>, b: Map<string, number>) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  a.forEach((v, k) => {
    na += v * v;
    dot += v * (b.get(k) ?? 0);
  });
  b.forEach((v) => (nb += v * v));
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function counts(rows: HistoryRow[], key: (t: CatalogTrack) => string | undefined) {
  const m = new Map<string, number>();
  rows.forEach((r) => {
    const k = key(r.track);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  });
  return m;
}

/** Taste match: blend of artist and genre similarity over recent plays. */
function tasteMatch(mine: HistoryRow[], theirs: HistoryRow[]) {
  const ga = counts(mine, (t) => t.genre);
  const gb = counts(theirs, (t) => t.genre);
  const value = 0.5 * cosine(counts(mine, (t) => t.artist?.id), counts(theirs, (t) => t.artist?.id)) + 0.5 * cosine(ga, gb);
  const shared = [...ga.keys()].filter((g) => gb.has(g)).sort((x, y) => (ga.get(y) ?? 0) + (gb.get(y) ?? 0) - (ga.get(x) ?? 0) - (gb.get(x) ?? 0));
  return { value, shared };
}

/** Conic-style progress ring (72 px, 7 px stroke) with a centered label. */
function MatchRing({ value }: { value: number }) {
  const size = 72;
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={`${Math.round(value * 100)} percent match`}>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.track} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colors.amber}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${c * value} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={{ width: 58, height: 58, borderRadius: 29, backgroundColor: colors.bgSecondary, alignItems: 'center', justifyContent: 'center' }}>
        <T size={18} weight={700}>
          {`${Math.round(value * 100)}%`}
        </T>
      </View>
    </View>
  );
}

export default function Friends() {
  const { user } = useAuth();
  const me = user?.id;
  const { playTrack } = usePlayerPick();
  const [activity, setActivity] = useState<Activity[]>([]);
  const [match, setMatch] = useState<Match | null>(null);
  const [followCount, setFollowCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { blocked, block } = useBlocks(me);
  const [note, setNote] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  // A friend who is listening right now: tapping them opens your chat (Messaging flow entry point).
  const openChat = async (p: Person) => {
    if (opening) return;
    setOpening(p.id);
    setNote(null);
    try {
      const { id, request } = await startChat(p.id);
      if (request) flash('Sent as a request');
      router.push({ pathname: '/chat-pro', params: { id, ...chatPeerParams(p) } });
    } catch (e) {
      setNote(friendlySocialError(e, 'Could not start a conversation'));
    } finally {
      setOpening(null);
    }
  };

  const blockPerson = async (p: Person) => {
    setNote(null);
    try {
      if (await block(p.id, p.display_name)) {
        setFollowCount((n) => Math.max(0, n - 1));
        setNote(`Blocked ${p.display_name}. Unblock them in Privacy → Blocked users.`);
      }
    } catch (e) {
      setNote(friendlySocialError(e, 'Could not block'));
    }
  };

  const load = useCallback(
    async (quiet = false) => {
      if (!me) return;
      if (!quiet) setLoading(true);
      setError(null);
      try {
        const f = await supabase.from('follows').select('following:profiles!follows_following_id_fkey(id, display_name, avatar_url)').eq('follower_id', me);
        if (f.error) throw new Error(f.error.message);
        const people = (f.data as unknown as { following: Person | null }[]).map((r) => r.following).filter((p): p is Person => !!p);
        setFollowCount(people.length);
        if (!people.length) {
          setActivity([]);
          setMatch(null);
          return;
        }
        const byId = new Map(people.map((p) => [p.id, p]));
        const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
        const [theirs, mine] = await Promise.all([
          supabase.from('play_history').select('user_id, track, played_at').in('user_id', [...byId.keys()]).gte('played_at', since).order('played_at', { ascending: false }).limit(1500),
          supabase.from('play_history').select('user_id, track, played_at').eq('user_id', me).gte('played_at', since).order('played_at', { ascending: false }).limit(500),
        ]);
        if (theirs.error) throw new Error(theirs.error.message);
        if (mine.error) throw new Error(mine.error.message);
        const rows = (theirs.data ?? []) as HistoryRow[];

        const latest: Activity[] = [];
        const seen = new Set<string>();
        const perUser = new Map<string, HistoryRow[]>();
        rows.forEach((r) => {
          const p = byId.get(r.user_id);
          if (!p) return;
          if (!seen.has(r.user_id)) {
            seen.add(r.user_id);
            latest.push({ ...r, person: p });
          }
          perUser.set(r.user_id, [...(perUser.get(r.user_id) ?? []), r]);
        });
        setActivity(latest);

        let best: Match | null = null;
        perUser.forEach((list, uid) => {
          const p = byId.get(uid);
          if (!p) return;
          const m = tasteMatch((mine.data ?? []) as HistoryRow[], list);
          if (!best || m.value > best.value) best = { person: p, value: m.value, shared: m.shared };
        });
        setMatch(best);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load friend activity');
      } finally {
        setLoading(false);
      }
    },
    [me],
  );

  useEffect(() => {
    // Start after the effect returns, so load's state updates aren't synchronous within it.
    let alive = true;
    void Promise.resolve().then(() => (alive ? load() : undefined));
    return () => {
      alive = false;
    };
  }, [load]);

  // Live: new plays from people you follow arrive via Realtime (RLS filters what we can see).
  useEffect(() => {
    if (!me) return;
    const ch = supabase
      .channel(`friends-activity:${me}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'play_history' }, (payload) => {
        const row = payload.new as Partial<HistoryRow>;
        if (row.user_id && row.user_id !== me) void load(true);
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [me, load]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const m: Match | null = match && !blocked.has(match.person.id) ? match : null;
  const shownActivity = activity.filter((a) => !blocked.has(a.user_id));
  const activityIds = shownActivity.map((a) => a.user_id).join(',');
  const arts = useAsync(() => loadAvatarArts(activityIds ? activityIds.split(',') : []), [activityIds], 'app/friends:227').data ?? NO_ARTS;
  const matchText = m
    ? m.shared.length >= 2
      ? `You both love ${m.shared[0].toLowerCase()} and ${m.shared[1].toLowerCase()}.`
      : m.shared.length === 1
        ? `You both love ${m.shared[0].toLowerCase()}.`
        : 'Listen more to find what you share.'
    : followCount
      ? 'Once friends listen, you will see how your tastes compare.'
      : 'Follow friends to compare your tastes.';

  return (
    <Screen onRefresh={me ? () => load(true) : undefined} backdrop={{ pattern: 'lines', mesh: 'amber' }} top={4} gap={20}>
      <ScreenHeader title="Friend activity" right={<IconButton icon="plus" label="Add friends" href="/followers" />} />

      <Tap
        accessibilityLabel={m ? `Taste match with ${m.person.display_name}` : 'Find friends'}
        onPress={() => (m ? router.push({ pathname: '/taste-compare', params: { user: m.person.id } }) : router.push('/followers'))}
      >
        <Glass padding={16}>
          <Row gap={16}>
            <MatchRing value={m ? m.value : 0} />
            <View style={{ flex: 1, gap: 4 }}>
              <T size={16} weight={600}>
                {m ? `Taste match with ${m.person.display_name}` : 'Taste match'}
              </T>
              <T size={14} color={colors.textSecondary} lineHeight={20}>
                {matchText}
              </T>
            </View>
          </Row>
        </Glass>
      </Tap>

      {note ? (
        <Tap onPress={() => setNote(null)}>
          <T size={13} color={colors.textSecondary} align="center" accessibilityLiveRegion="polite">
            {note}
          </T>
        </Tap>
      ) : null}

      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : shownActivity.length === 0 ? (
        followCount ? (
          <EmptyState icon="music" title="Quiet right now" body="When people you follow play music, it shows up here live." />
        ) : (
          <EmptyState icon="users" title="No friends yet" body="Follow people to see what they're listening to." action="Find people" href="/followers" />
        )
      ) : (
        <Glass padding={4}>
          {shownActivity.map((a, i) => {
            const live = now - new Date(a.played_at).getTime() < LIVE_MS;
            return (
              <ListRow
                key={a.user_id}
                onPress={
                  live
                    ? () => void openChat(a.person)
                    : () => {
                        playTrack(a.track, `${a.person.display_name}'s activity`);
                        router.push('/player');
                      }
                }
                divider={i > 0}
                minHeight={72}
                title={a.person.display_name}
                subtitle={opening === a.user_id ? 'Opening chat…' : `${a.track.title} · ${a.track.artist.name}`}
                leading={
                  <Tap
                    accessibilityLabel={`Open ${a.person.display_name}'s profile`}
                    onPress={() => router.push({ pathname: '/public-profile', params: { id: a.person.id } })}
                  >
                    <PersonAvatar id={a.person.id} name={a.person.display_name} uri={a.person.avatar_url} preset={arts.get(a.person.id)} size={48} />
                  </Tap>
                }
                right={
                  <Row gap={4}>
                    {live ? (
                      <>
                        <LiveDot />
                        <IconButton
                          icon="play"
                          label={`Play ${a.track.title}`}
                          iconSize={18}
                          color={colors.textSecondary}
                          onPress={() => {
                            playTrack(a.track, `${a.person.display_name}'s activity`);
                            router.push('/player');
                          }}
                        />
                      </>
                    ) : (
                      <T mono size={12} color={colors.textSecondary}>
                        {ago(a.played_at, now)}
                      </T>
                    )}
                    <IconButton icon="more" label={`Block ${a.person.display_name}`} iconSize={20} color={colors.textSecondary} onPress={() => void blockPerson(a.person)} />
                  </Row>
                }
              />
            );
          })}
        </Glass>
      )}
    </Screen>
  );
}
