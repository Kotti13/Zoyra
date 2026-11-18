import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import {
  Art,
  Cover,
  EmptyState,
  ErrorState,
  Glass,
  Icon,
  IconButton,
  ListRow,
  Loading,
  MiniPlayer,
  ProgressBar,
  MoreButton,
  Row,
  Screen,
  ScreenHeader,
  Spacer,
  T,
  TextField,
  Toast,
  TrackItem,
} from '../components';
import { catalog, MOOD_MAP, type Artwork, type CatalogTrack } from '../lib/catalog';
import { playlistShareUrl, profileShareUrl, shareContent } from '../lib/share-links';
import { useContentFilter } from '../lib/content-filter';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { useLibrary, type UserPlaylist } from '../state/library';
import { toggleCollectionDownload, useCollectionDownload } from '../state/downloads';
import { usePlayerPick } from '../state/player';
import { colors, shadow } from '../theme/tokens';

/* ------------------------------------------------------------------ local helpers */

type Kind = 'user' | 'catalog' | 'liked' | 'mix' | 'smart' | 'none';
type Row_ = { rowId?: string; track: CatalogTrack };
type Loaded = {
  title: string;
  description: string;
  tag?: string;
  coverUri?: string | null;
  artwork?: Artwork;
  rows: Row_[];
  playlist?: UserPlaylist;
};

const SMART: Record<string, { title: string; description: string }> = {
  week: { title: 'Liked this week', description: 'Everything you liked in the last 7 days.' },
  rediscover: { title: 'Rediscover', description: 'Songs you played more than a month ago and have not heard since.' },
  short: { title: 'Under 3 min', description: 'Your liked songs that finish in under three minutes.' },
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function totalTime(rows: Row_[]) {
  const s = rows.reduce((n, r) => n + (r.track.duration || 0), 0);
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Short-lived inline note (honest "coming soon" messages, confirmations). */
function useNote() {
  const [note, setNote] = useState<string | null>(null);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((msg: string) => {
    setNote(msg);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => setNote(null), 3200);
  }, []);
  useEffect(() => () => void (t.current && clearTimeout(t.current)), []);
  return { note, show };
}

/* ------------------------------------------------------------------ screen */

export default function Playlist() {
  const params = useLocalSearchParams<{ id?: string; catalog?: string; liked?: string; mix?: string; title?: string; smart?: string }>();
  const id = first(params.id);
  const catalogId = first(params.catalog);
  const mix = first(params.mix);
  const smart = first(params.smart);
  const mixTitle = first(params.title);
  const kind: Kind = id ? 'user' : catalogId ? 'catalog' : first(params.liked) ? 'liked' : mix ? 'mix' : smart && SMART[smart] ? 'smart' : 'none';

  const { user, profile } = useAuth();
  const lib = useLibrary();
  const player = usePlayerPick('track', 'playing', 'shuffle', 'context');
  const { note, show } = useNote();

  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(kind !== 'liked' && kind !== 'none');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [menu, setMenu] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<Loaded | null> => {
    switch (kind) {
      case 'user': {
        const [p, t] = await Promise.all([
          supabase.from('playlists').select('*').eq('id', id).maybeSingle(),
          supabase.from('playlist_tracks').select('id, track').eq('playlist_id', id).order('position', { ascending: true }),
        ]);
        if (p.error) throw new Error(p.error.message);
        if (t.error) throw new Error(t.error.message);
        if (!p.data) throw new Error('This playlist is private or no longer exists.');
        const pl = p.data as UserPlaylist;
        const rows = ((t.data ?? []) as { id: string; track: CatalogTrack }[]).map((r) => ({ rowId: r.id, track: r.track }));
        return {
          title: pl.title,
          description: pl.description || (pl.is_ai && pl.ai_prompt ? `AI playlist · “${pl.ai_prompt}”` : ''),
          tag: pl.visibility === 'collaborative' ? 'Collaborative' : pl.visibility === 'private' ? 'Private' : pl.is_ai ? 'AI generated' : undefined,
          coverUri: pl.cover_url,
          artwork: rows[0]?.track.artwork,
          rows,
          playlist: pl,
        };
      }
      case 'catalog': {
        const [c, tracks] = await Promise.all([catalog.collection(catalogId!), catalog.collectionTracks(catalogId!)]);
        return {
          title: c.title,
          description: c.description || `By ${c.artist.name}`,
          tag: c.isAlbum ? 'Album' : 'Playlist',
          artwork: c.artwork.medium || c.artwork.large ? c.artwork : tracks[0]?.artwork,
          rows: tracks.map((track) => ({ track })),
        };
      }
      case 'mix': {
        const m = mix!;
        const tracks = MOOD_MAP[m] ? await catalog.byMood(m, 30) : await catalog.trending({ genre: m, limit: 30 });
        return { title: mixTitle || `${m} Mix`, description: `Fresh ${m.toLowerCase()} picks from the catalogue, updated daily.`, tag: 'Mix', artwork: tracks[0]?.artwork, rows: tracks.map((track) => ({ track })) };
      }
      case 'smart': {
        if (!user) return { ...SMART[smart!], tag: 'Smart', rows: [] };
        let tracks: CatalogTrack[] = [];
        if (smart === 'week') {
          const since = new Date(Date.now() - 7 * 864e5).toISOString();
          const r = await supabase.from('liked_tracks').select('track').eq('user_id', user.id).gte('created_at', since).order('created_at', { ascending: false });
          if (r.error) throw new Error(r.error.message);
          tracks = ((r.data ?? []) as { track: CatalogTrack }[]).map((x) => x.track);
        } else if (smart === 'rediscover') {
          const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
          const [old, recent] = await Promise.all([
            supabase.from('play_history').select('track_id, track').eq('user_id', user.id).lt('played_at', cutoff).order('played_at', { ascending: false }).limit(300),
            supabase.from('play_history').select('track_id').eq('user_id', user.id).gte('played_at', cutoff).limit(1000),
          ]);
          if (old.error) throw new Error(old.error.message);
          const recentIds = new Set(((recent.data ?? []) as { track_id: string }[]).map((x) => x.track_id));
          const seen = new Set<string>();
          for (const x of (old.data ?? []) as { track_id: string; track: CatalogTrack }[]) {
            if (recentIds.has(x.track_id) || seen.has(x.track_id)) continue;
            seen.add(x.track_id);
            tracks.push(x.track);
          }
          tracks = tracks.slice(0, 50);
        } else {
          tracks = lib.liked.filter((t) => t.duration > 0 && t.duration < 180);
        }
        return { ...SMART[smart!], tag: 'Smart', artwork: tracks[0]?.artwork, rows: tracks.map((track) => ({ track })) };
      }
      default:
        return null;
    }
    // lib.liked only matters for the "short" smart list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id, catalogId, mix, mixTitle, smart, user, smart === 'short' ? lib.liked : null]);

  useEffect(() => {
    if (kind === 'liked' || kind === 'none') return;
    let alive = true;
    // Reset to the loading state before each (re)load; the result arrives asynchronously below.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    load()
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : 'Could not load this playlist'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [load, kind, nonce]);

  // Live updates for user playlists (collaborators adding / removing songs).
  useEffect(() => {
    if (kind !== 'user' || !id) return;
    const ch = supabase
      .channel(`playlist:${id}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'playlist_tracks', filter: `playlist_id=eq.${id}` }, () => {
        void load().then((d) => d && setData(d)).catch(() => undefined);
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [kind, id, load]);

  // Pull to refresh: re-fetch in place (no skeleton flash); liked songs reload the live library.
  const refresh = () => {
    if (kind === 'liked') return lib.reload();
    return load()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load this playlist'));
  };

  // Liked songs come straight from the live library.
  const view: Loaded | null = useMemo(() => {
    if (kind === 'liked') return { title: 'Liked Songs', description: 'Every song you have hearted, newest first.', rows: lib.liked.map((track) => ({ track })) };
    return data;
  }, [kind, lib.liked, data]);

  // Content controls: hidden songs/artists and (kid-safe) explicit songs are left out of the list and playback.
  const { filter: hideFilter } = useContentFilter();
  const visibleRows = useMemo(() => {
    const all = view?.rows ?? [];
    const keep = new Set(hideFilter(all.map((r) => r.track)));
    return keep.size === all.length ? all : all.filter((r) => keep.has(r.track));
  }, [view, hideFilter]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? visibleRows.filter((r) => r.track.title.toLowerCase().includes(q) || r.track.artist.name.toLowerCase().includes(q)) : visibleRows;
  }, [visibleRows, query]);
  const tracks = useMemo(() => rows.map((r) => r.track), [rows]);
  const allTracks = useMemo(() => visibleRows.map((r) => r.track), [visibleRows]);
  const trackIds = useMemo(() => allTracks.map((t) => t.id), [allTracks]);
  const dlStatus = useCollectionDownload(trackIds);

  const ctx = `playlist:${kind}:${id ?? catalogId ?? mix ?? smart ?? 'liked'}`;
  const isCurrent = player.context === ctx;
  const playingHere = isCurrent && player.playing;
  const pl = view?.playlist;
  const isOwner = !!pl && !!user && pl.owner_id === user.id;
  const inLibrary = kind === 'liked' || isOwner;

  const onPlay = () => {
    if (isCurrent && player.track) return player.toggle();
    if (!allTracks.length) return show('Nothing to play yet');
    player.playTracks(allTracks, 0, ctx);
  };

  const onSave = async () => {
    if (inLibrary) return show(kind === 'liked' ? 'Liked Songs is always in your library' : 'Already in your library');
    if (!user) return show('Sign in to save playlists');
    if (!view || !allTracks.length) return show('Nothing to save yet');
    setSaving(true);
    try {
      const created = await lib.createPlaylist({ title: view.title.slice(0, 100), description: view.description });
      await lib.addToPlaylist(created.id, allTracks);
      show('Saved a copy to your library');
    } catch (e) {
      show(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const onShare = async () => {
    if (!view) return;
    // User and catalogue playlists get a rich https link; generated mixes (liked, mood…) share a track list.
    const link = kind === 'user' && id ? playlistShareUrl(id) : kind === 'catalog' && catalogId ? playlistShareUrl(catalogId) : null;
    try {
      if (link) await shareContent({ url: link, title: view.title, message: `${view.title} — playlist on Zoyra` });
      else await shareContent({ url: profileShareUrl({ id: user?.id ?? '', username: profile?.username }), title: view.title, message: `${view.title} on Zoyra:\n${allTracks.slice(0, 10).map((t) => `• ${t.title} — ${t.artist.name}`).join('\n')}` });
    } catch {
      show('Could not open the share sheet');
    }
  };

  const onDelete = async () => {
    if (!pl) return;
    setMenu(false);
    try {
      await lib.deletePlaylist(pl.id);
      if (router.canGoBack()) router.back();
      else router.replace('/library');
    } catch (e) {
      show(e instanceof Error ? e.message : 'Could not delete');
    }
  };

  const onRemove = async (rowId: string) => {
    setData((d) => (d ? { ...d, rows: d.rows.filter((r) => r.rowId !== rowId) } : d));
    try {
      await lib.removeFromPlaylist(rowId);
    } catch {
      show('Could not remove that song');
      setNonce((n) => n + 1);
    }
  };

  const header = <ScreenHeader title={kind === 'liked' ? 'Liked Songs' : 'Playlist'} right={<IconButton icon="search" label="Search in playlist" color={searching ? colors.accentLight : colors.text} onPress={() => setSearching((v) => !v)} />} />;

  if (kind === 'none') {
    return (
      <Screen backdrop={{ pattern: 'dots', mesh: 'peach' }} top={4} gap={16} bottom={16} footer={<MiniPlayer />}>
        {header}
        <EmptyState title="Playlist not found" body="Open a playlist from your library to see it here." action="Go to library" href="/library" />
      </Screen>
    );
  }

  return (
    <Screen backdrop={{ pattern: 'dots', mesh: 'peach' }} top={4} gap={16} bottom={16} footer={<MiniPlayer />} onRefresh={refresh}>
      {header}

      {loading && !view ? (
        <Loading label="Loading playlist" height={320} />
      ) : error && !view ? (
        <ErrorState message={error} onRetry={() => setNonce((n) => n + 1)} />
      ) : view ? (
        <>
          <View style={{ alignItems: 'center', paddingVertical: 8 }}>
            <View style={{ borderRadius: 26, shadowColor: colors.accent, shadowOpacity: 0.3, shadowRadius: 40, shadowOffset: { width: 0, height: 0 } }}>
              {kind === 'liked' ? (
                <Art art="sunrise" size={200} radius={26} style={[shadow.artGlow, { alignItems: 'center', justifyContent: 'center' }]}>
                  <Icon name="heart" size={72} color={colors.white} filled />
                </Art>
              ) : (
                <Cover uri={view.coverUri} artwork={view.artwork} id={id ?? catalogId ?? mix ?? smart} size={200} radius={26} style={shadow.artGlow} />
              )}
            </View>
          </View>

          <View style={{ gap: 6 }}>
            <T variant="title" accessibilityRole="header">
              {view.title}
            </T>
            {view.description ? (
              <T size={14} color={colors.textSecondary} lineHeight={20}>
                {view.description}
              </T>
            ) : null}
            <Row gap={8}>
              <T mono size={12} color={colors.textSecondary}>
                {view.rows.length} {view.rows.length === 1 ? 'song' : 'songs'} · {totalTime(view.rows)}
              </T>
              {view.tag ? (
                <>
                  <T size={12} color={colors.textTertiary}>
                    ·
                  </T>
                  <T size={12} weight={600} color={colors.amber}>
                    {view.tag}
                  </T>
                </>
              ) : null}
            </Row>
          </View>

          <Row gap={4}>
            <IconButton
              icon={dlStatus.complete ? 'check' : 'download'}
              label={dlStatus.downloading ? 'Cancel download' : dlStatus.complete ? 'Remove download' : 'Download'}
              size={48}
              color={dlStatus.complete ? colors.success : dlStatus.downloading ? colors.accentLight : colors.text}
              onPress={() => toggleCollectionDownload(allTracks, dlStatus, show)}
            />
            <IconButton
              icon="heart"
              label={inLibrary ? 'In your library' : 'Save to library'}
              size={48}
              filled={inLibrary}
              color={inLibrary ? colors.like : saving ? colors.textSecondary : colors.text}
              onPress={() => void onSave()}
            />
            <IconButton icon="share" label="Share" size={48} onPress={() => void onShare()} />
            <IconButton icon="more" label="More" size={48} color={menu ? colors.accentLight : colors.text} onPress={() => setMenu((v) => !v)} />
            <Spacer />
            <IconButton icon="shuffle" label="Shuffle" size={48} color={player.shuffle ? colors.amber : colors.textSecondary} onPress={() => player.setShuffle(!player.shuffle)} />
            <IconButton icon={playingHere ? 'pause' : 'play'} label={playingHere ? 'Pause' : 'Play'} size={56} iconSize={26} bg={colors.accent} color={colors.onAccent} onPress={onPlay} />
          </Row>

          {dlStatus.downloading ? (
            <View style={{ gap: 6 }} accessibilityLabel={`Downloading, ${dlStatus.downloaded} of ${dlStatus.total} songs saved`}>
              <ProgressBar value={dlStatus.progress} />
              <T mono size={12} color={colors.textSecondary}>
                Downloading · {dlStatus.downloaded}/{dlStatus.total}
              </T>
            </View>
          ) : dlStatus.downloaded > 0 && !dlStatus.complete ? (
            <T mono size={12} color={colors.textSecondary}>
              {dlStatus.downloaded}/{dlStatus.total} downloaded
            </T>
          ) : null}
          {note ? <Toast icon="info" iconColor={colors.accentLight} message={note} /> : null}

          {menu ? (
            <Glass padding={4}>
              <ListRow
                title="Shuffle play"
                icon="shuffle"
                right={false}
                onPress={() => {
                  setMenu(false);
                  if (!allTracks.length) return show('Nothing to play yet');
                  player.setShuffle(true);
                  player.playTracks(allTracks, Math.floor(Math.random() * allTracks.length), ctx);
                }}
              />
              <ListRow
                title="Add all to queue"
                icon="queue"
                divider
                right={false}
                onPress={() => {
                  setMenu(false);
                  allTracks.forEach((t) => player.addToQueue(t));
                  show(`Added ${allTracks.length} songs to your queue`);
                }}
              />
              {pl && isOwner && pl.visibility === 'collaborative' ? (
                <ListRow title="Invite collaborators" icon="users" divider onPress={() => (setMenu(false), router.push({ pathname: '/invite', params: { playlist: pl.id } }))} />
              ) : null}
              {pl && isOwner ? (
                <ListRow
                  title="Edit details"
                  subtitle="Name, description, cover, who can see it"
                  icon="edit"
                  divider
                  onPress={() => {
                    setMenu(false);
                    router.push({ pathname: '/create-playlist', params: { edit: pl.id } });
                  }}
                />
              ) : null}
              {pl && isOwner ? <ListRow title="Delete playlist" icon="trash" iconColor={colors.like} titleColor={colors.like} divider right={false} onPress={() => void onDelete()} /> : null}
            </Glass>
          ) : null}

          {searching ? <TextField label="Find in playlist" hideLabel value={query} onChangeText={setQuery} placeholder="Find in playlist" icon="search" /> : null}

          {rows.length === 0 ? (
            query ? (
              <EmptyState icon="search" title="No matches" body={`Nothing in this playlist matches “${query}”.`} />
            ) : kind === 'liked' ? (
              <EmptyState icon="heart" title="No liked songs yet" body="Tap the heart on any song and it will show up here." action="Find music" href="/search" />
            ) : kind === 'smart' ? (
              <EmptyState icon="clock" title="Nothing here yet" body="This list fills itself as you like and play more music." />
            ) : (
              <EmptyState title="No songs yet" body={isOwner ? 'Add songs from any track’s ⋯ menu.' : 'This playlist is empty.'} action={isOwner ? 'Find music' : undefined} href={isOwner ? '/search' : undefined} />
            )
          ) : (
            <View>
              {rows.map((r, i) => (
                <TrackItem
                  key={r.rowId ?? `${r.track.id}-${i}`}
                  track={r.track}
                  list={tracks}
                  index={i}
                  showIndex
                  artRadius={14}
                  context={ctx}
                  right={
                    isOwner && r.rowId ? (
                      <Row gap={0}>
                        <IconButton icon="close" label={`Remove ${r.track.title}`} color={colors.textSecondary} onPress={() => void onRemove(r.rowId!)} />
                        <MoreButton track={r.track} />
                      </Row>
                    ) : undefined
                  }
                />
              ))}
            </View>
          )}
        </>
      ) : null}
    </Screen>
  );
}
