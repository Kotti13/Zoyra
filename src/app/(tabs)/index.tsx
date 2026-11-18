import { router, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Art, Avatar, Button, ChipRow, Cover, EmptyState, ErrorState, Glass, Gradient, Icon, IconButton, Loading, Row, Screen, SectionHeader, Sticker, T, Tap, Toast, TrackItem, artFor, useAsync, SignInBanner, useFocusEffectAfterTransition } from '../../components';
import type { IconName } from '../../components';
import { GENRES, catalog, formatCount, type CatalogTrack } from '../../lib/catalog';
import { useContentFilter } from '../../lib/content-filter';
import { inboxUnreadTotal } from '../../lib/dm';
import { PlaysBadge, Poster, PosterBadge, PosterCard } from '../../lib/poster';
import { formatReleaseDate, loadPremieres } from '../../lib/premieres';
import { useUnreadNotifications } from '../../lib/push';
import { supabase } from '../../lib/supabase';
import { MemoryCard } from '../../lib/memories-ui';
import { VideoEntryCard } from '../../lib/video-ui';
import { useAuth } from '../../state/auth';
import { usePlayerActions } from '../../state/player';
import { colors, withAlpha, type ArtName } from '../../theme/tokens';

const quickActions: { label: string; icon: IconName; art: ArtName; href: Href }[] = [
  { label: 'Discover', icon: 'search', art: 'red', href: '/discover' },
  { label: 'Premieres', icon: 'star', art: 'orange', href: '/premieres' },
  { label: 'Live', icon: 'cast', art: 'rose', href: '/live-hub' },
  { label: 'Run mode', icon: 'bolt', art: 'amber', href: '/workout-home' },
  { label: 'Mood scan', icon: 'camera', art: 'rose', href: '/mood-scan' },
  { label: 'AI playlist', icon: 'sliders', art: 'red', href: '/ai-playlist' },
  { label: 'Music quiz', icon: 'trophy', art: 'amber', href: '/quiz' },
  { label: 'Car mode', icon: 'car', art: 'blue', href: '/car-mode' },
];

const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
/** "FRIDAY RELEASE" from the real release date; "NEW RELEASE" when the date is unknown. */
const releaseBadge = (d?: string) => {
  const t = d ? Date.parse(d) : NaN;
  return Number.isNaN(t) ? 'NEW RELEASE' : `${WEEKDAYS[new Date(t).getDay()]} RELEASE`;
};
const fmtHours = (m: number) => (m >= 60 ? { value: (m / 60).toFixed(1).replace(/\.0$/, ''), unit: 'hrs' } : { value: String(Math.round(m)), unit: 'min' });

const moodChips = ['Chill', 'Focus', 'Workout', 'Sleep', 'Happy', 'Party'];
const mixArts: ArtName[] = ['coral', 'rose', 'blue', 'green', 'amber'];

type FriendNow = { userId: string; name: string; avatar: string | null; track: CatalogTrack };
type HistoryRow = { track_id: string; track: CatalogTrack; played_at: string };
type FriendRow = HistoryRow & { user_id: string };

/**
 * Home's Messages badge: unread messages + pending requests from `inbox_unread_total()`. Reloads on
 * focus, on any new message and on changes to my memberships (incl. deletes, which Realtime only
 * delivers to unfiltered subscriptions).
 */
function useUnreadChats(userId: string | undefined) {
  const [count, setCount] = useState(0);
  const load = useCallback(async () => {
    if (!userId) return setCount(0);
    try {
      setCount(await inboxUnreadTotal());
    } catch {
      // offline / RPC not deployed yet: keep the last count
    }
  }, [userId]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 400);
  }, [load]);

  // Refresh on focus once the tab switch has finished (keeps the re-render out of the transition).
  useFocusEffectAfterTransition(() => void load());

  useEffect(() => {
    if (!userId) {
      void Promise.resolve().then(load);
      return;
    }
    // Bursts of inserts / read updates collapse into one reload.
    const ch = supabase
      .channel(`home-unread:${userId}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, soon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_members', filter: `user_id=eq.${userId}` }, soon)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'conversation_members' }, soon)
      .subscribe();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      void supabase.removeChannel(ch);
    };
  }, [userId, load, soon]);
  return { count, reload: load };
}

/** Red count badge on a 44px header button. */
function HeaderBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.bg }}
    >
      <T size={10} weight={700} color={colors.onAccent}>
        {count > 99 ? '99+' : count}
      </T>
    </View>
  );
}

/** Small transient note (auto hides). */
function useNote() {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 3200);
    return () => clearTimeout(id);
  }, [note]);
  return { note, show: setNote };
}

export default function Home() {
  const { user, profile, settings } = useAuth();
  const { count: unreadNotifs, reload: reloadNotifs } = useUnreadNotifications(user?.id);
  // Unread messages + pending requests (one server count).
  const { count: unreadMessages, reload: reloadUnreadChats } = useUnreadChats(user?.id);
  // Stable actions only: Home no longer re-renders on every play / pause / buffering change.
  const { playTracks, playTrack } = usePlayerActions();
  const { filter: hideFilter } = useContentFilter();
  const { note, show } = useNote();
  const uid = user?.id;

  const [streak, setStreak] = useState(0);
  const [streakNonce, setStreakNonce] = useState(0);
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    supabase.rpc('listening_streak').then(({ data }) => {
      if (alive && typeof data === 'number') setStreak(data);
    });
    return () => {
      alive = false;
    };
  }, [uid, streakNonce]);

  /* Recently played (distinct, latest 6) → fallback trending */
  const shortcuts = useAsync(async () => {
    if (uid) {
      const { data, error } = await supabase.from('play_history').select('track_id, track, played_at').eq('user_id', uid).order('played_at', { ascending: false }).limit(60);
      if (error) throw new Error(error.message);
      const seen = new Set<string>();
      const out: CatalogTrack[] = [];
      for (const r of (data ?? []) as HistoryRow[]) {
        if (seen.has(r.track_id)) continue;
        seen.add(r.track_id);
        out.push(r.track);
        if (out.length === 6) break;
      }
      if (out.length >= 2) return { tracks: out, recent: true };
    }
    return { tracks: await catalog.trending({ limit: 6 }), recent: false };
  }, [uid]);

  const trending = useAsync(() => catalog.trending({ limit: 12 }), []);
  const premieres = useAsync(() => loadPremieres(30), []);
  const weekMinutes = useAsync(async () => {
    if (!uid) return null;
    const { data, error } = await supabase.rpc('listening_insights', { days: 7 });
    if (error) throw new Error(error.message);
    const d = (data ?? {}) as { minutes?: number; plays?: number };
    return { minutes: Number(d.minutes) || 0, plays: Number(d.plays) || 0 };
  }, [uid]);

  /* Friends listening: latest play of each followed user within the last 30 minutes */
  const loadFriends = useCallback(async (): Promise<FriendNow[]> => {
    if (!uid) return [];
    const { data: f, error: fe } = await supabase.from('follows').select('following_id').eq('follower_id', uid);
    if (fe) throw new Error(fe.message);
    const ids = (f ?? []).map((r: { following_id: string }) => r.following_id);
    if (!ids.length) return [];
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: h, error: he } = await supabase
      .from('play_history')
      .select('user_id, track_id, track, played_at')
      .in('user_id', ids)
      .gte('played_at', since)
      .order('played_at', { ascending: false })
      .limit(100);
    if (he) throw new Error(he.message);
    const latest = new Map<string, FriendRow>();
    for (const r of (h ?? []) as FriendRow[]) if (!latest.has(r.user_id)) latest.set(r.user_id, r);
    if (!latest.size) return [];
    const { data: p } = await supabase.from('profiles').select('id, display_name, avatar_url').in('id', [...latest.keys()]);
    const names = new Map((p ?? []).map((x: { id: string; display_name: string; avatar_url: string | null }) => [x.id, x]));
    return [...latest.values()].map((r) => ({
      userId: r.user_id,
      name: names.get(r.user_id)?.display_name ?? 'Friend',
      avatar: names.get(r.user_id)?.avatar_url ?? null,
      track: r.track,
    }));
  }, [uid]);
  const friends = useAsync(loadFriends, [loadFriends]);

  /* Friends' new plays arrive live (RLS limits rows to people you follow). */
  const reloadFriends = friends.reload;
  useEffect(() => {
    if (!uid) return;
    const ch = supabase
      .channel(`home-friends-${uid}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'play_history' }, (payload) => {
        const row = payload.new as { user_id?: string };
        if (row.user_id && row.user_id !== uid) reloadFriends();
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [uid, reloadFriends]);

  /* Pull to refresh: every section on Home, plus the header counts. */
  const refresh = () => {
    setStreakNonce((n) => n + 1);
    return Promise.all([shortcuts.refresh(), trending.refresh(), premieres.refresh(), weekMinutes.refresh(), friends.refresh(), reloadNotifs(), reloadUnreadChats()]);
  };

  const genres = settings?.genres?.length ? settings.genres : GENRES.slice(0, 3);
  const madeForYou: { title: string; sub: string; art: ArtName; onPress: () => void }[] = genres.slice(0, 4).map((g, i) => ({
    title: `Daily Mix ${i + 1}`,
    sub: `${g} picks for you`,
    art: mixArts[i % mixArts.length],
    onPress: () => router.push({ pathname: '/playlist', params: { mix: g, title: `Daily Mix ${i + 1}` } }),
  }));
  madeForYou.splice(1, 0, { title: 'Release Radar', sub: 'From artists you follow', art: 'amber', onPress: () => router.push('/new-releases') });

  const playMood = async (mood: string) => {
    try {
      const list = await catalog.byMood(mood);
      if (!list.length) return show(`No ${mood.toLowerCase()} tracks right now. Try another mood.`);
      playTracks(list, 0, `${mood} mix`);
    } catch (e) {
      show(e instanceof Error ? e.message : 'Could not load that mood');
    }
  };

  const firstName = (profile?.display_name ?? 'there').trim().split(/\s+/)[0] || 'there';

  /* Hero: newest trending album, else newest trending single. */
  const heroAlbum = premieres.data?.albums[0];
  const heroTrack = premieres.data ? hideFilter(premieres.data.tracks)[0] : undefined;
  // Content controls: hidden songs/artists and (kid-safe) explicit songs never show on Home.
  const trendingList = trending.data ? hideFilter(trending.data) : undefined;
  const shortcutList = shortcuts.data ? hideFilter(shortcuts.data.tracks) : [];
  const hero = heroAlbum
    ? { kind: 'album' as const, id: heroAlbum.id, title: heroAlbum.title, artist: heroAlbum.artist.name, artwork: heroAlbum.artwork, releaseDate: heroAlbum.releaseDate, plays: heroAlbum.plays, open: () => router.push({ pathname: '/album', params: { id: heroAlbum.id } }) }
    : heroTrack
      ? { kind: 'single' as const, id: heroTrack.id, title: heroTrack.title, artist: heroTrack.artist.name, artwork: heroTrack.artwork, releaseDate: heroTrack.releaseDate, plays: heroTrack.plays, open: () => router.push({ pathname: '/track-detail', params: { id: heroTrack.id } }) }
      : null;

  return (
    <Screen tabbed backdrop={{ pattern: 'dots', mesh: 'coral' }} onRefresh={refresh}>
      {/* Guests: sign-in invitation (renders nothing once signed in) */}
      <SignInBanner />
      {/* Greeting, streak, notifications */}
      <Row gap={8}>
        <View style={{ flex: 1 }}>
          <T size={15} weight={300} color={colors.peach} numberOfLines={1}>
            Hi {firstName},
          </T>
          <T size={30} weight={300} tracking={-0.8} lineHeight={33} accessibilityRole="header" numberOfLines={1}>
            {profile ? 'Welcome back' : 'Welcome to Zoyra'}
          </T>
        </View>
        <Tap
          href="/achievements"
          accessibilityLabel={`${streak} day streak`}
          style={[
            { height: 44, paddingHorizontal: 14, borderRadius: 22, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder, flexDirection: 'row', alignItems: 'center', gap: 6 },
          ]}
        >
          <Icon name="flame" filled={false} size={20} color={colors.orange} />
          <T size={14} weight={700} color={colors.text}>
            {streak}
          </T>
        </Tap>
        {user ? (
          <View>
            <IconButton icon="chat" label={unreadMessages ? `Messages, ${unreadMessages} unread` : 'Messages'} bg={colors.glass} href="/messages" />
            <HeaderBadge count={unreadMessages} />
          </View>
        ) : null}
        <View>
          <IconButton icon="bell" label={unreadNotifs ? `Notifications, ${unreadNotifs} unread` : 'Notifications'} bg={colors.glass} href="/notifications" />
          <HeaderBadge count={unreadNotifs} />
        </View>
      </Row>

      {note ? <Toast icon="info" iconColor={colors.amber} message={note} /> : null}

      {/* Poster hero: the newest big release (real Audius data) */}
      {premieres.loading && !premieres.data ? (
        <Loading height={400} label="Loading premieres" />
      ) : premieres.error ? (
        <ErrorState message={premieres.error} onRetry={premieres.reload} />
      ) : hero ? (
        <Tap onPress={hero.open} accessibilityLabel={`${hero.title} by ${hero.artist}. Open`}>
          <Poster artwork={hero.artwork} id={hero.id} height={400} radius={34} fade={0.55}>
            <View style={{ flex: 1, justifyContent: 'space-between', padding: 6 }}>
              <View style={{ gap: 12 }}>
                <PosterBadge label={releaseBadge(hero.releaseDate)} />
                <View>
                  <T size={15} weight={300} tracking={3} color={colors.peach}>
                    {hero.kind === 'album' ? 'THE NEW ALBUM' : 'THE NEW SINGLE'}
                  </T>
                  <T size={46} weight={800} tracking={-1.5} lineHeight={46} color={colors.accentLight} numberOfLines={2}>
                    {hero.title.toUpperCase()}
                  </T>
                </View>
              </View>
              <Glass radius={26} padding={14} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <T size={17} weight={700} numberOfLines={1}>
                    {hero.title}
                  </T>
                  <T size={12} color={colors.peach} numberOfLines={1}>
                    {hero.artist}
                    {formatReleaseDate(hero.releaseDate) ? ` · Release ${formatReleaseDate(hero.releaseDate)}` : ''}
                  </T>
                </View>
                {hero.plays ? <PlaysBadge plays={hero.plays} /> : null}
                <Button label="Listen" icon="play" height={40} onPress={hero.open} />
              </Glass>
            </View>
          </Poster>
        </Tap>
      ) : null}

      {/* Quick actions */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}>
        {quickActions.map((a) => (
          <Tap key={a.label} href={a.href} accessibilityLabel={a.label} style={{ width: 68, alignItems: 'center', gap: 8 }}>
            <Art art={a.art} size={60} radius={30} style={{ alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={a.icon} size={26} color={colors.white} />
            </Art>
            <T size={12} weight={600} align="center" lineHeight={15} numberOfLines={1}>
              {a.label}
            </T>
          </Tap>
        ))}
      </ScrollView>

      {/* Popular now */}
      <View style={{ gap: 12 }}>
        <SectionHeader title="Popular now" action="See all" href="/charts" />
        {trending.loading && !trending.data ? (
          <Loading height={196} />
        ) : trending.error ? (
          <ErrorState message={trending.error} onRetry={trending.reload} />
        ) : !trendingList?.length ? (
          <EmptyState title="Nothing trending yet" />
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}>
            {(trendingList ?? []).slice(0, 10).map((t) => (
              <PosterCard
                key={t.id}
                id={t.id}
                title={t.title}
                subtitle={t.artist.name}
                artwork={t.artwork}
                plays={t.plays}
                accessibilityLabel={`${t.title} by ${t.artist.name}, ${formatCount(t.plays)} plays. Open details`}
                onPress={() => router.push({ pathname: '/track-detail', params: { id: t.id } })}
              />
            ))}
          </ScrollView>
        )}
      </View>

      {/* Premieres */}
      {premieres.data?.albums.length ? (
        <View style={{ gap: 12 }}>
          <SectionHeader title="Premieres" action="See all" href="/premieres" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}>
            {premieres.data.albums.slice(0, 8).map((c) => (
              <PosterCard
                key={c.id}
                id={c.id}
                title={c.title}
                subtitle={c.artist.name}
                artwork={c.artwork}
                badge={formatReleaseDate(c.releaseDate)?.toUpperCase() ?? 'ALBUM'}
                onPress={() => router.push({ pathname: '/album', params: { id: c.id } })}
              />
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* Live + run mode entry points */}
      <Row gap={12} align="stretch">
        <Tap href="/live-hub" accessibilityLabel="Live hub: listening sessions happening now" style={{ flex: 1 }}>
          <Glass radius={28} padding={14} style={{ gap: 10, minHeight: 112 }}>
            <Row gap={6}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.live }} />
              <T size={11} weight={700} tracking={0.6} color={colors.live}>
                LIVE
              </T>
            </Row>
            <T size={17} weight={600}>
              Live hub
            </T>
            <T size={12} color={colors.textSecondary}>
              Listen along with hosts in real time
            </T>
          </Glass>
        </Tap>
        <Tap href="/workout-home" accessibilityLabel="Run mode: music matched to your run" style={{ flex: 1 }}>
          <Glass radius={28} padding={14} style={{ gap: 10, minHeight: 112 }}>
            <Icon name="bolt" size={20} color={colors.orange} />
            <T size={17} weight={600}>
              Run mode
            </T>
            <T size={12} color={colors.textSecondary}>
              Music that keeps your pace
            </T>
          </Glass>
        </Tap>
      </Row>

      {/* Your activity (real listening stats) */}
      {uid ? (
        <View style={{ gap: 12 }}>
          <SectionHeader title="Your activity" action="Insights" href="/insights" />
          {weekMinutes.loading && !weekMinutes.data ? (
            <Loading height={96} />
          ) : weekMinutes.error ? (
            <ErrorState message={weekMinutes.error} onRetry={weekMinutes.reload} />
          ) : weekMinutes.data ? (
            <Row gap={12} align="stretch">
              {[
                { label: 'Listening', sub: 'This week', ...fmtHours(weekMinutes.data.minutes), href: '/insights' as const },
                { label: 'Streak', sub: streak ? 'Keep it going' : 'Play today', value: String(streak), unit: streak === 1 ? 'day' : 'days', href: '/achievements' as const },
                { label: 'Plays', sub: 'This week', value: String(weekMinutes.data.plays), unit: '', href: '/recent' as const },
              ].map((s) => (
                <Tap key={s.label} href={s.href} accessibilityLabel={`${s.label} ${s.sub}: ${s.value} ${s.unit}`} style={{ flex: 1 }}>
                  <Glass radius={24} padding={12} style={{ gap: 8, minHeight: 104 }}>
                    <View>
                      <T size={13} weight={600}>
                        {s.label}
                      </T>
                      <T size={11} color={colors.textSecondary}>
                        {s.sub}
                      </T>
                    </View>
                    <Row gap={3} align="flex-end" style={{ marginTop: 'auto' }}>
                      <T size={26} weight={300} tracking={-0.8} lineHeight={28}>
                        {s.value}
                      </T>
                      {s.unit ? (
                        <T size={11} color={colors.textSecondary} style={{ marginBottom: 3 }}>
                          {s.unit}
                        </T>
                      ) : null}
                    </Row>
                  </Glass>
                </Tap>
              ))}
            </Row>
          ) : null}
        </View>
      ) : null}

      <MemoryCard />

      {/* Jump back in: recently played (fallback: trending) */}
      <View style={{ gap: 12 }}>
        <SectionHeader title={shortcuts.data?.recent === false ? 'Start listening' : 'Jump back in'} action="History" href="/recent" />
        {shortcuts.loading && !shortcuts.data ? (
          <Loading height={128} />
        ) : shortcuts.error ? (
          <ErrorState message={shortcuts.error} onRetry={shortcuts.reload} />
        ) : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
            {shortcutList.map((t, i, list) => (
              <Tap
                key={t.id}
                accessibilityLabel={`Play ${t.title} by ${t.artist.name}`}
                onPress={() => playTracks(list, i, shortcuts.data?.recent ? 'Recently played' : 'Trending now')}
                style={{ width: '47.5%', flexGrow: 1 }}
              >
                <Glass radius={28} style={{ height: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingRight: 12 }}>
                  <Cover artwork={t.artwork} id={t.id} size={56} radius={0} />
                  <T size={14} weight={600} lineHeight={17} numberOfLines={2} style={{ flex: 1 }}>
                    {t.title}
                  </T>
                </Glass>
              </Tap>
            ))}
          </View>
        )}
      </View>

      {/* Zoyra DJ hero */}
      <Tap href="/ai-dj" style={{ borderRadius: 32, overflow: 'hidden' }}>
        <Gradient colors={[colors.accent, colors.orange]} style={{ padding: 20, gap: 12 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Sticker label="NEW" rotate={-4} />
            <Icon name="bolt" color={colors.onAccent} />
          </Row>
          <View style={{ gap: 4 }}>
            <T size={28} weight={300} tracking={-0.6} lineHeight={31} color={colors.onAccent}>
              Zoyra DJ
            </T>
            <T size={15} lineHeight={21} color={colors.onAccent} style={{ maxWidth: 230 }}>
              A smart mix of what you love, built from your likes and history.
            </T>
          </View>
          <Row>
            <Row gap={8} style={{ height: 44, paddingHorizontal: 20, borderRadius: 22, backgroundColor: colors.bg }}>
              <Icon name="play" size={18} color={colors.text} />
              <T size={15} weight={600}>
                Start DJ
              </T>
            </Row>
          </Row>
          <View pointerEvents="none" style={{ position: 'absolute', right: -24, bottom: -24, width: 130, height: 130, borderRadius: 65, borderWidth: 14, borderColor: withAlpha(colors.white, 0.35) }} />
          <View pointerEvents="none" style={{ position: 'absolute', right: 12, bottom: 12, width: 56, height: 56, borderRadius: 28, borderWidth: 8, borderColor: withAlpha(colors.white, 0.35) }} />
        </Gradient>
      </Tap>

      {/* Made for you */}
      <View style={{ gap: 12 }}>
        <SectionHeader title="Made for you" action="See all" href="/daily-mix" />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 16, paddingVertical: 6 }}>
          {madeForYou.map((m, i) => (
            <Tap key={m.title} onPress={m.onPress} style={{ width: 156, gap: 8 }}>
              <Art art={m.art} size={156} radius={32} sticker rotate={i % 2 ? 2 : -2} />
              <View style={{ gap: 2, marginTop: 6 }}>
                <T size={15} weight={600}>
                  {m.title}
                </T>
                <T size={12} color={colors.textSecondary} lineHeight={17}>
                  {m.sub}
                </T>
              </View>
            </Tap>
          ))}
        </ScrollView>
      </View>

      {/* Friends listening */}
      <View style={{ gap: 12 }}>
        <SectionHeader title="Friends listening now" action="Activity" href="/friends" />
        {friends.loading && !friends.data ? (
          <Loading height={80} />
        ) : friends.error ? (
          <ErrorState message={friends.error} onRetry={friends.reload} />
        ) : !friends.data?.length ? (
          <T size={14} color={colors.textSecondary}>
            None of the people you follow are listening right now.
          </T>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}>
            {friends.data.map((f) => (
              <Tap
                key={f.userId}
                accessibilityLabel={`${f.name} is listening to ${f.track.title}. Tap to play it`}
                onPress={() => playTrack(f.track, `${f.name} is listening`)}
                style={{ width: 64, alignItems: 'center', gap: 6 }}
              >
                <View>
                  <Avatar initial={f.name[0]?.toUpperCase()} art={artFor(f.userId)} online />
                  {f.avatar ? <Cover uri={f.avatar} id={f.userId} size={56} radius={28} style={{ position: 'absolute', left: 0, top: 0 }} /> : null}
                  {f.avatar ? (
                    <View style={{ position: 'absolute', right: 0, bottom: 0, width: 16, height: 16, borderRadius: 8, backgroundColor: colors.success, borderWidth: 3, borderColor: colors.bg }} />
                  ) : null}
                </View>
                <T size={12} color={colors.textSecondary} numberOfLines={1}>
                  {f.name}
                </T>
              </Tap>
            ))}
          </ScrollView>
        )}
      </View>

      {/* Mood chips */}
      <View style={{ gap: 4 }}>
        <SectionHeader title="Pick a mood" action="Boards" href="/mood-boards" />
        <ChipRow wrap options={moodChips} onChange={(i) => void playMood(moodChips[i])} />
      </View>

      {/* Trending */}
      <View>
        <SectionHeader title="Trending now" action="Top charts" href="/charts" />
        {trending.loading && !trending.data ? (
          <Loading />
        ) : trending.error ? (
          <ErrorState message={trending.error} onRetry={trending.reload} />
        ) : !trendingList?.length ? (
          <EmptyState title="Nothing trending yet" />
        ) : (
          (trendingList ?? []).slice(0, 5).map((t, i, list) => <TrackItem key={t.id} track={t} list={list} index={i} showIndex context="Trending now" />)
        )}
      </View>

      {/* Explore tiles */}
      <Row>
        <Tap href="/podcasts" style={{ flex: 1, height: 110, borderRadius: 36, overflow: 'hidden' }}>
          <Art art="blue" height={110} radius={36} style={{ width: '100%', padding: 16, justifyContent: 'space-between' }}>
            <Icon name="mic" size={26} color={colors.white} />
            <T size={18} weight={700} color={colors.white}>
              Podcasts
            </T>
          </Art>
        </Tap>
        <Tap href="/concerts" style={{ flex: 1, height: 110, borderRadius: 36, overflow: 'hidden' }}>
          <Art art="amber" height={110} radius={36} style={{ width: '100%', padding: 16, justifyContent: 'space-between' }}>
            <Icon name="pin" size={26} color={colors.white} />
            <T size={18} weight={700} color={colors.white}>
              Concerts near you
            </T>
          </Art>
        </Tap>
      </Row>
      <VideoEntryCard title="Music videos" subtitle="Watch, shorts and live sets" />
      <VideoEntryCard title="Entertainment" subtitle="Games, audiobooks, radio, tickets" href="/entertain-hub" />
    </Screen>
  );
}
