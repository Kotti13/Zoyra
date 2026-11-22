import { router, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';

import { Art, Avatar, Cover, EmptyState, ErrorState, Glass, Gradient, Icon, IconButton, Loading, Row, Screen, Sticker, T, Tap, Toast, artFor, useAsync, SignInBanner, useFocusEffectAfterTransition, AppleTitle, Shelf, ShelfCard, ShelfHeader as H2, AppleTrackList, APPLE, IconBadge } from '../../components';
import { loadHub } from '../../lib/live';
import { useConnection } from '../../lib/network';
import { isZoyraId, zoyra, zoyraEnabled } from '../../lib/zoyra-api';
import { fetchChart, type YouTubeVideo } from '../../lib/youtube';
import { VideoThumb } from '../../lib/video-ui';
import type { IconName } from '../../components';
import { GENRES, catalog, formatCount, type Artwork, type CatalogTrack } from '../../lib/catalog';
import { useContentFilter } from '../../lib/content-filter';
import { inboxUnreadTotal } from '../../lib/dm';
import { Poster } from '../../lib/poster';
import { formatReleaseDate, loadPremieres, posterText } from '../../lib/premieres';
import { useUnreadNotifications } from '../../lib/push';
import { supabase } from '../../lib/supabase';
import { MemoryCard } from '../../lib/memories-ui';
import { useAuth } from '../../state/auth';
import { usePlayerActions } from '../../state/player';
import { CategoryTile } from '../../components/CategoryTile';
import { colors, tile, withAlpha, type ArtName } from '../../theme/tokens';

function StatCard({ label, sub, value, unit, href }: { label: string; sub: string; value: string; unit: string; href: Href }) {
  return (
    <Tap href={href} accessibilityLabel={`${label} ${sub}: ${value} ${unit}`} style={{ width: 158 }}>
      <Glass radius={20} padding={16} style={{ height: 176, justifyContent: 'space-between' }}>
        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ gap: 2 }}>
            <T size={15} weight={500}>
              {label}
            </T>
            <T size={12} color={colors.textSecondary}>
              {sub}
            </T>
          </View>
          <Icon name="chevronRight" size={16} color={colors.textSecondary} />
        </Row>
        <Row gap={6} align="baseline">
          <T size={44} weight={300} tracking={-1.5} lineHeight={46}>
            {value}
          </T>
          {unit ? (
            <T size={12} color={colors.textSecondary}>
              {unit}
            </T>
          ) : null}
        </Row>
      </Glass>
    </Tap>
  );
}

/** Board entry card: glass pill-card with a 52px round icon, title, subtitle and chevron. */
function EntryCard({ title, subtitle, href, icon, tone, glow }: { title: string; subtitle: string; href: Href; icon: IconName; tone: ArtName; glow?: boolean }) {
  return (
    <Tap href={href} accessibilityLabel={`${title}. ${subtitle}`}>
      <Glass radius={20} padding={16} style={[{ flexDirection: 'row', alignItems: 'center', gap: 14 }, glow ? { shadowColor: colors.accent, shadowOpacity: 0.25, shadowRadius: 28, shadowOffset: { width: 0, height: 0 } } : null]}>
        <IconBadge icon={icon} size={52} tone={tone} filled={icon === 'play'} />
        <View style={{ flex: 1, gap: 2 }}>
          <T size={18} weight={700}>
            {title}
          </T>
          <T size={14} style={{ opacity: 0.85 }} numberOfLines={1}>
            {subtitle}
          </T>
        </View>
        <Icon name="chevronRight" size={18} />
      </Glass>
    </Tap>
  );
}

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

/** Home mood cards: the mood to play, the search that finds its picture (the top song for it) and the colour shown until then. */
const moodCards: { mood: string; q: string; bg: string }[] = [
  { mood: 'Chill', q: 'chill vibes songs', bg: tile.blue },
  { mood: 'Focus', q: 'focus study music', bg: tile.navy },
  { mood: 'Workout', q: 'workout gym songs', bg: tile.coral },
  { mood: 'Sleep', q: 'sleep calm music', bg: tile.green },
  { mood: 'Happy', q: 'happy upbeat songs', bg: tile.gold },
  { mood: 'Party', q: 'party dance hits', bg: tile.rose },
];
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
  const { width: winW } = useWindowDimensions();
  const heroW = winW - APPLE.side * 2;
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
  }, [uid], 'app/(tabs)/index:215');

  const conn = useConnection();
  const liveNow = useAsync(async () => (uid ? (await loadHub(uid)).live : []), [uid], 'home.live');
  const trending = useAsync(() => catalog.trending({ limit: 12 }), [], { id: 'home.trending', persist: true });
  const premieres = useAsync(() => loadPremieres(30), [], { id: 'home.premieres', persist: true });
  // Trending YouTube music videos for the "Made for you" row under the Music videos card. The YouTube chart first;
  // when it is unavailable (not set up / quota), the backend's popular songs, shown with their video thumbnails.
  const musicVideos = useAsync<YouTubeVideo[]>(
    async () => {
      try {
        const page = await fetchChart();
        const list = page.videos.filter((v) => !v.live && v.thumbnail).slice(0, 12);
        if (list.length) return list;
      } catch {
        // fall through to the backend
      }
      if (!zoyraEnabled) return [];
      const songs = await zoyra.popular('popular', 12).catch(() => []);
      return songs.map((t) => {
        const vid = zoyra.videoId(t.id);
        return { id: vid, title: t.title, channel: t.artist.name, channelId: null, thumbnail: `https://i.ytimg.com/vi/${vid}/hq720.jpg`, publishedAt: null, live: false, views: t.plays || null, likes: null, comments: null, durationSec: t.duration || null };
      });
    },
    [],
    'app/(tabs)/index:musicvideos',
  );
  const weekMinutes = useAsync(async () => {
    if (!uid) return null;
    const { data, error } = await supabase.rpc('listening_insights', { days: 7 });
    if (error) throw new Error(error.message);
    const d = (data ?? {}) as { minutes?: number; plays?: number };
    return { minutes: Number(d.minutes) || 0, plays: Number(d.plays) || 0 };
  }, [uid], 'app/(tabs)/index:236');

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
  const friends = useAsync(loadFriends, [loadFriends], 'app/(tabs)/index:272');

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
    return Promise.all([shortcuts.refresh(), trending.refresh(), premieres.refresh(), weekMinutes.refresh(), friends.refresh(), liveNow.refresh(), reloadNotifs(), reloadUnreadChats()]);
  };

  const genres = settings?.genres?.length ? settings.genres : GENRES.slice(0, 3);
  // One real cover per mix (the genre's top song), so the cards show a picture; the gradient shows until it loads.
  const mixGenres = genres.slice(0, 4);
  const mixTracks = useAsync<CatalogTrack[][]>(
    () => Promise.all(mixGenres.map((g) => catalog.searchTracks(`${g} songs`, { limit: 4 }).catch(() => [] as CatalogTrack[]))),
    [mixGenres.join('|')],
    'app/(tabs)/index:mixart',
  );
  const madeForYou: { title: string; sub: string; art: ArtName; artwork?: () => Artwork | undefined; onPress: () => void }[] = mixGenres.map((g, i) => ({
    title: `Daily Mix ${i + 1}`,
    sub: `${g} picks for you`,
    art: mixArts[i % mixArts.length],
    artwork: () => hideFilter(mixTracks.data?.[i] ?? [])[0]?.artwork,
    onPress: () => router.push({ pathname: '/playlist', params: { mix: g, title: `Daily Mix ${i + 1}` } }),
  }));
  madeForYou.splice(1, 0, { title: 'Release Radar', sub: 'From artists you follow', art: 'amber', artwork: () => premieres.data?.albums[0]?.artwork ?? hideFilter(mixTracks.data?.[0] ?? [])[1]?.artwork, onPress: () => router.push('/new-releases') });

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
  const heroSingle = heroTrack ? posterText(heroTrack.title, heroTrack.artist.name) : undefined;
  const hero = heroAlbum
    ? { kind: 'album' as const, id: heroAlbum.id, title: heroAlbum.title, artist: heroAlbum.artist.name, artwork: heroAlbum.artwork, releaseDate: heroAlbum.releaseDate, plays: heroAlbum.plays, open: () => router.push({ pathname: '/album', params: { id: heroAlbum.id } }) }
    : heroTrack
      ? { kind: 'single' as const, id: heroTrack.id, title: heroSingle?.title ?? heroTrack.title, artist: heroSingle?.artist ?? heroTrack.artist.name, artwork: heroTrack.artwork, releaseDate: heroTrack.releaseDate, plays: heroTrack.plays, open: () => (isZoyraId(heroTrack.id) ? playTrack(heroTrack, 'New release') : router.push({ pathname: '/track-detail', params: { id: heroTrack.id } })) }
      : null;


  const shelfBase = { gap: 12 } as const;
  const quickShelf = quickActions;

  return (
    <Screen tabbed gap={APPLE.section} backdrop={{ pattern: 'dots', mesh: 'coral' }} onRefresh={refresh}>
      {/* Guests: sign-in invitation (renders nothing once signed in) */}
      <SignInBanner />

      {/* Large title with connection, messages and notifications (Profile is a bottom tab) */}
      <View style={{ gap: 2 }}>
        <T size={13} weight={500} color={colors.textSecondary} numberOfLines={1}>
          Hi {firstName}
        </T>
        <AppleTitle
          title={profile ? 'Listen Now' : 'Welcome to Zoyra'}
          right={
            <>
              <Tap
                href="/net-status"
                accessibilityLabel={`Connection: ${conn.label}${conn.detail ? `, ${conn.detail}` : ''}`}
                style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder, alignItems: 'center', justifyContent: 'center' }}
              >
                <Icon name={conn.online ? 'wifi' : 'wifiOff'} size={17} color={conn.online ? colors.success : colors.warning} />
              </Tap>
              {user ? (
                <View>
                  <IconButton icon="chat" label={unreadMessages ? `Messages, ${unreadMessages} unread` : 'Messages'} bg={colors.glass} href="/messages" />
                  <HeaderBadge count={unreadMessages} />
                </View>
              ) : null}
              <View>
                <IconButton icon="bell" label={unreadNotifs ? `Notifications, ${unreadNotifs} unread` : 'Notifications'} bg={withAlpha(colors.white, 0.1)} href="/notifications" />
                <HeaderBadge count={unreadNotifs} />
              </View>
            </>
          }
        />
      </View>

      {note ? <Toast icon="info" iconColor={colors.amber} message={note} /> : null}

      {/* Featured card: the newest big release (real Audius data), ~16:10 */}
      {premieres.loading && !premieres.data ? (
        <Loading height={Math.round(heroW / 1.6)} label="Loading premieres" />
      ) : premieres.error ? (
        <ErrorState message={premieres.error} onRetry={premieres.reload} />
      ) : hero ? (
        <Tap onPress={hero.open} accessibilityLabel={`${hero.title} by ${hero.artist}. Open`}>
          <Poster artwork={hero.artwork} id={hero.id} width={heroW} height={Math.round(heroW / 1.6)} radius={24} fade={0.8}>
            <View style={{ flex: 1, justifyContent: 'space-between' }}>
              <T size={11} weight={700} tracking={1.2} color={colors.peach}>
                {releaseBadge(hero.releaseDate)}
              </T>
              <Row gap={12} align="flex-end">
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <T size={24} weight={700} tracking={-0.5} lineHeight={28} numberOfLines={2}>
                    {hero.title}
                  </T>
                  <T size={14} color={colors.peach} numberOfLines={1}>
                    {hero.artist}
                    {formatReleaseDate(hero.releaseDate) ? ` · ${formatReleaseDate(hero.releaseDate)}` : ''}
                  </T>
                </View>
                <IconBadge icon="play" size={44} filled />
              </Row>
            </View>
          </Poster>
        </Tap>
      ) : null}

      {/* Recently played: tiles (fallback: trending). Each tile takes its picture's shape, so the image fills it exactly. */}
      <View style={shelfBase}>
        <H2 title={shortcuts.data?.recent === false ? 'Start listening' : 'Recently played'} action="History" href="/recent" />
        {shortcuts.loading && !shortcuts.data ? (
          <Loading height={128} />
        ) : shortcuts.error ? (
          <ErrorState message={shortcuts.error} onRetry={shortcuts.reload} />
        ) : (
          <Shelf
            data={shortcutList}
            itemWidth={128}
            keyExtractor={(t) => t.id}
            renderItem={({ item: t, index }) => (
              <ShelfCard
                title={t.title}
                subtitle={t.artist.name}
                artwork={t.artwork}
                id={t.id}
                size={128}
                radius={10}
                accessibilityLabel={`Play ${t.title} by ${t.artist.name}`}
                onPress={() => playTracks(shortcutList, index, shortcuts.data?.recent ? 'Recently played' : 'Trending now')}
              />
            )}
          />
        )}
      </View>

      {/* Popular now */}
      <View style={shelfBase}>
        <H2 title="Popular now" action="See all" href="/charts" />
        {trending.loading && !trending.data ? (
          <Loading height={196} />
        ) : trending.error ? (
          <ErrorState message={trending.error} onRetry={trending.reload} />
        ) : !trendingList?.length ? (
          <EmptyState title="Nothing trending yet" />
        ) : (
          <Shelf
            data={trendingList.slice(0, 10)}
            keyExtractor={(t) => t.id}
            renderItem={({ item: t }) => (
              <ShelfCard
                title={t.title}
                subtitle={t.artist.name}
                artwork={t.artwork}
                id={t.id}
                accessibilityLabel={`${t.title} by ${t.artist.name}, ${formatCount(t.plays)} plays. Open details`}
                onPress={() => router.push({ pathname: '/track-detail', params: { id: t.id } })}
              />
            )}
          />
        )}
      </View>

      {/* Daily mixes */}
      <View style={shelfBase}>
        <H2 title="Daily mixes" action="See all" href="/daily-mix" />
        <Shelf
          data={madeForYou}
          keyExtractor={(m) => m.title}
          renderItem={({ item: m }) => {
            const artwork = m.artwork?.();
            return <ShelfCard title={m.title} subtitle={m.sub} id={m.title} artwork={artwork} art={artwork ? undefined : m.art} onPress={m.onPress} />;
          }}
        />
      </View>

      {/* Premieres */}
      {premieres.data?.albums.length ? (
        <View style={shelfBase}>
          <H2 title="Premieres" action="See all" href="/premieres" />
          <Shelf
            data={premieres.data.albums.slice(0, 8)}
            keyExtractor={(c) => c.id}
            renderItem={({ item: c }) => (
              <ShelfCard
                title={c.title}
                subtitle={`${c.artist.name}${formatReleaseDate(c.releaseDate) ? ` · ${formatReleaseDate(c.releaseDate)}` : ''}`}
                artwork={c.artwork}
                id={c.id}
                onPress={() => router.push({ pathname: '/album', params: { id: c.id } })}
              />
            )}
          />
        </View>
      ) : null}

      {/* Live now: hosts on air right now */}
      {liveNow.data?.length ? (
        <View style={shelfBase}>
          <H2 title="Live now" action="Live hub" href="/live-hub" />
          <Shelf
            data={liveNow.data.slice(0, 8)}
            keyExtractor={(l) => l.id}
            renderItem={({ item: l }) => (
              <ShelfCard
                title={l.title}
                subtitle={`${l.host?.display_name ?? 'Live'} · ${formatCount(l.listeners)} listening`}
                uri={l.host?.avatar_url ?? null}
                id={l.id}
                accessibilityLabel={`${l.title}${l.host ? ` by ${l.host.display_name}` : ''}, live. Open`}
                onPress={() => router.push({ pathname: '/live-room', params: { id: l.id } })}
              >
                <View style={{ position: 'absolute', top: 8, left: 8, height: 22, paddingHorizontal: 8, borderRadius: 11, backgroundColor: colors.live, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: colors.white }} />
                  <T size={10} weight={800} tracking={0.6} color={colors.white}>
                    LIVE
                  </T>
                </View>
              </ShelfCard>
            )}
          />
        </View>
      ) : null}

      {/* Your activity (real listening stats) */}
      {uid ? (
        <View style={shelfBase}>
          <H2 title="Your activity" action="Insights" href="/insights" />
          {weekMinutes.loading && !weekMinutes.data ? (
            <Loading height={96} />
          ) : weekMinutes.error ? (
            <ErrorState message={weekMinutes.error} onRetry={weekMinutes.reload} />
          ) : weekMinutes.data ? (
            <Shelf
              data={[
                { k: 'listen', label: 'Listening', sub: 'This week', ...fmtHours(weekMinutes.data.minutes), href: '/insights' as Href },
                { k: 'streak', label: 'Streak', sub: streak ? 'Keep it going' : 'Play today', value: String(streak), unit: streak === 1 ? 'day' : 'days', href: '/achievements' as Href },
                { k: 'plays', label: 'Plays', sub: 'This week', value: String(weekMinutes.data.plays), unit: weekMinutes.data.plays === 1 ? 'play' : 'plays', href: '/recent' as Href },
              ]}
              itemWidth={158}
              keyExtractor={(x) => x.k}
              renderItem={({ item: x }) => <StatCard label={x.label} sub={x.sub} value={x.value} unit={x.unit} href={x.href} />}
            />
          ) : null}
        </View>
      ) : null}

      {/* Explore: quick actions */}
      <View style={shelfBase}>
        <H2 title="Explore" />
        <Shelf
          data={quickShelf}
          itemWidth={68}
          keyExtractor={(a) => a.label}
          renderItem={({ item: a }) => (
            <Tap href={a.href} accessibilityLabel={a.label} style={{ width: 68, alignItems: 'center', gap: 8 }}>
              <Art art={a.art} size={60} radius={18} style={{ alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={a.icon} size={26} color={colors.white} />
              </Art>
              <T size={12} weight={600} align="center" lineHeight={15} numberOfLines={1}>
                {a.label}
              </T>
            </Tap>
          )}
        />
      </View>

      {/* Friends listening */}
      <View style={shelfBase}>
        <H2 title="Friends listening now" action="Activity" href="/friends" />
        {friends.loading && !friends.data ? (
          <Loading height={80} />
        ) : friends.error ? (
          <ErrorState message={friends.error} onRetry={friends.reload} />
        ) : !friends.data?.length ? (
          <T size={14} color={colors.textSecondary}>
            None of the people you follow are listening right now.
          </T>
        ) : (
          <Shelf
            data={friends.data}
            itemWidth={64}
            keyExtractor={(f) => f.userId}
            renderItem={({ item: f }) => (
              <Tap
                accessibilityLabel={`${f.name} is listening to ${f.track.title}. Tap to play it`}
                onPress={() => playTrack(f.track, `${f.name} is listening`)}
                style={{ width: 64, alignItems: 'center', gap: 6 }}
              >
                <View>
                  <Avatar initial={f.name[0]?.toUpperCase()} art={artFor(f.userId)} online />
                  {f.avatar ? <Cover uri={f.avatar} id={f.userId} size={56} radius={28} style={{ position: 'absolute', left: 0, top: 0 }} /> : null}
                  {f.avatar ? <View style={{ position: 'absolute', right: 0, bottom: 0, width: 16, height: 16, borderRadius: 8, backgroundColor: colors.success, borderWidth: 3, borderColor: colors.bg }} /> : null}
                </View>
                <T size={12} color={colors.textSecondary} numberOfLines={1}>
                  {f.name}
                </T>
              </Tap>
            )}
          />
        )}
      </View>

      {/* Mood chips */}
      <View style={{ gap: 8 }}>
        <H2 title="Pick a mood" action="Boards" href="/mood-boards" />
        <Shelf
          data={moodCards}
          itemWidth={132}
          keyExtractor={(m) => m.mood}
          renderItem={({ item: m }) => <CategoryTile label={m.mood} query={m.q} bg={m.bg} width={132} height={88} radius={16} accessibilityLabel={`Play ${m.mood} music`} onPress={() => void playMood(m.mood)} />}
        />
      </View>

      {/* Trending: clean list rows */}
      <View style={{ gap: 4 }}>
        <H2 title="Trending now" action="Top charts" href="/charts" />
        {trending.loading && !trending.data ? (
          <Loading />
        ) : trending.error ? (
          <ErrorState message={trending.error} onRetry={trending.reload} />
        ) : !trendingList?.length ? (
          <EmptyState title="Nothing trending yet" />
        ) : (
          <AppleTrackList tracks={trendingList.slice(0, 5)} context="Trending now" />
        )}
      </View>

      {/* More to explore */}
      <View style={{ gap: 12 }}>
        <H2 title="More to explore" />
        <EntryCard title="Music videos" subtitle="Watch, shorts and live sets" href="/videos" icon="play" tone="coral" glow />
        {/* Made for you: trending YouTube music videos, straight under the Music videos card */}
        {musicVideos.data?.length ? (
          <View style={shelfBase}>
            <H2 title="Made for you" action="See all" href="/videos" />
            <Shelf
              data={musicVideos.data}
              itemWidth={232}
              keyExtractor={(v) => v.id}
              renderItem={({ item: v }) => (
                <Tap
                  onPress={() => router.push({ pathname: '/video-player', params: { id: v.id } })}
                  accessibilityLabel={`Watch ${v.title} by ${v.channel}`}
                  style={{ width: 232, gap: 8 }}
                >
                  <VideoThumb video={v} width={232} radius={14} />
                  <View style={{ gap: 1 }}>
                    <T size={14} weight={600} numberOfLines={2} lineHeight={18}>
                      {v.title}
                    </T>
                    <T size={13} color={colors.textSecondary} numberOfLines={1}>
                      {v.channel}
                    </T>
                  </View>
                </Tap>
              )}
            />
          </View>
        ) : musicVideos.loading ? (
          <Loading height={150} />
        ) : null}
        <EntryCard title="Entertainment" subtitle="Games, audiobooks, radio, tickets" href="/entertain-hub" icon="bolt" tone="orange" />
        <Row gap={12} align="stretch">
          <Tap href="/live-hub" accessibilityLabel="Live hub: listening sessions happening now" style={{ flex: 1 }}>
            <Glass radius={20} padding={14} style={{ gap: 10, minHeight: 112 }}>
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
            <Glass radius={20} padding={14} style={{ gap: 10, minHeight: 112 }}>
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
      </View>

      <MemoryCard />

      {/* Zoyra DJ hero */}
      <Tap href="/ai-dj" style={{ borderRadius: 24, overflow: 'hidden' }}>
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

      {/* Podcasts + concerts */}
      <Row>
        <Tap href="/podcasts" style={{ flex: 1, height: 110, borderRadius: 20, overflow: 'hidden' }}>
          <Art art="blue" height={110} radius={20} style={{ width: '100%', padding: 16, justifyContent: 'space-between' }}>
            <Icon name="mic" size={26} color={colors.white} />
            <T size={18} weight={700} color={colors.white}>
              Podcasts
            </T>
          </Art>
        </Tap>
        <Tap href="/concerts" style={{ flex: 1, height: 110, borderRadius: 20, overflow: 'hidden' }}>
          <Art art="amber" height={110} radius={20} style={{ width: '100%', padding: 16, justifyContent: 'space-between' }}>
            <Icon name="pin" size={26} color={colors.white} />
            <T size={18} weight={700} color={colors.white}>
              Concerts near you
            </T>
          </Art>
        </Tap>
      </Row>
    </Screen>
  );
}
