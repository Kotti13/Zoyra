import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Modal, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  ChipRow,
  Cover,
  EmptyState,
  ErrorState,
  AppleSeparator,
  AppleTitle,
  AppleTrackList,
  APPLE,
  Gradient,
  Icon,
  IconButton,
  LinkText,
  Loading,
  Row,
  Screen,
  SectionHeader,
  SkeletonRows,
  Sticker,
  T,
  Tap,
  Toast,
  useAsync,
  useDebounced,
  IconBadge,
} from '../../components';
import type { IconName } from '../../components';
import { MOOD_MAP, catalog, formatCount, type Artist, type CatalogTrack, type Collection } from '../../lib/catalog';
import { useContentFilter } from '../../lib/content-filter';
import { appPathFromShareUrl } from '../../lib/share-links';
import { supabase } from '../../lib/supabase';
import { VideoEntryCard } from '../../lib/video-ui';
import { useVoiceSearch } from '../../lib/voice';
import { useAuth } from '../../state/auth';
import { usePlayerActions, usePlayerSelector } from '../../state/player';
import { CategoryTile } from '../../components/CategoryTile';
import { art, colors, fonts, shadow, tile } from '../../theme/tokens';
import { searchFilters, useSearchFilters, type SearchFilterState } from '../filter-sort';

const filters = ['All', 'Songs', 'Artists', 'Albums', 'Playlists', 'Lyrics', 'Podcasts'] as const;
type Filter = (typeof filters)[number];

const genres: { label: string; bg: string; icon: IconName; filled?: boolean }[] = [
  { label: 'Electronic', bg: tile.coral, icon: 'sliders' },
  { label: 'Pop', bg: tile.rose, icon: 'star' },
  { label: 'Alternative', bg: tile.bronze, icon: 'bolt' },
  { label: 'Hip-Hop/Rap', bg: tile.gold, icon: 'mic' },
  { label: 'R&B/Soul', bg: tile.blue, icon: 'heart', filled: false },
  { label: 'Lo-Fi', bg: tile.green, icon: 'music' },
];

type HistoryRow = { id: number; query: string; created_at: string };

/** Last 5 distinct searches for a user. */
async function fetchRecent(uid: string): Promise<string[]> {
  const { data } = await supabase.from('search_history').select('id, query, created_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(40);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of (data ?? []) as HistoryRow[]) {
    const k = r.query.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(r.query.trim());
    if (out.length === 5) break;
  }
  return out;
}
type Results = { tracks: CatalogTrack[]; artists: Artist[]; collections: Collection[] };

function applyTrackFilters(list: CatalogTrack[], f: SearchFilterState) {
  let out = list;
  if (f.genres.length) out = out.filter((t) => !!t.genre && f.genres.includes(t.genre));
  if (f.moods.length) {
    const allowed = new Set(f.moods.flatMap((m) => MOOD_MAP[m] ?? [m]));
    out = out.filter((t) => !!t.mood && allowed.has(t.mood));
  }
  const time = (t: CatalogTrack) => (t.releaseDate ? Date.parse(t.releaseDate) || 0 : 0);
  if (f.sort === 'Newest') out = [...out].sort((a, b) => time(b) - time(a));
  else if (f.sort === 'Most played') out = [...out].sort((a, b) => b.plays - a.plays);
  else if (f.sort === 'Alphabetical') out = [...out].sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

function useNote() {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 3200);
    return () => clearTimeout(id);
  }, [note]);
  return { note, show: setNote };
}

function ArtistRow({ a, onOpen }: { a: Artist; onOpen: () => void }) {
  return (
    <Tap accessibilityLabel={`Artist ${a.name}`} onPress={onOpen} style={{ minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Cover artwork={a.image} id={a.id} size={56} radius={28} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="bodyStrong" numberOfLines={1}>
          {a.name}
        </T>
        <T variant="small" color={colors.textSecondary} numberOfLines={1}>
          Artist · {formatCount(a.followers)} followers
        </T>
      </View>
      <Icon name="chevronRight" size={20} color={colors.textSecondary} />
    </Tap>
  );
}

function CollectionRow({ c, onOpen }: { c: Collection; onOpen: () => void }) {
  return (
    <Tap accessibilityLabel={`${c.isAlbum ? 'Album' : 'Playlist'} ${c.title}`} onPress={onOpen} style={{ minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Cover artwork={c.artwork} id={c.id} size={56} radius={10} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="bodyStrong" numberOfLines={1}>
          {c.title}
        </T>
        <T variant="small" color={colors.textSecondary} numberOfLines={1}>
          {c.isAlbum ? 'Album' : 'Playlist'} · {c.artist.name}
        </T>
      </View>
      <Icon name="chevronRight" size={20} color={colors.textSecondary} />
    </Tap>
  );
}

/* ------------------------------------------------------------------ QR scanner */

/** Turn a scanned code into an action. Zoyra share link / zoyra:// → in-app route; audius.co → catalogue search. */
function parseCode(data: string): { kind: 'route'; path: string } | { kind: 'search'; query: string } | null {
  const v = data.trim();
  const shared = appPathFromShareUrl(v);
  if (shared) return { kind: 'route', path: shared };
  const zoyra = /^zoyra:\/\/\/?(.*)$/i.exec(v);
  if (zoyra) return { kind: 'route', path: `/${zoyra[1]}` };
  const audius = /^https?:\/\/(?:www\.)?audius\.co\/([^?#]+)/i.exec(v);
  if (audius) {
    const parts = audius[1].split('/').filter(Boolean);
    const slug = parts[parts.length - 1] ?? '';
    let decoded = slug;
    try {
      decoded = decodeURIComponent(slug);
    } catch {
      /* keep raw slug */
    }
    const query = decoded.replace(/-\d+$/, '').replace(/[-_]+/g, ' ').trim();
    return query ? { kind: 'search', query } : null;
  }
  return null;
}

function QrScanner({ onClose, onCode }: { onClose: () => void; onCode: (data: string) => boolean }) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [hint, setHint] = useState<string | null>(null);
  const locked = useRef(false);

  // Mounted only while scanning, so hint/lock start fresh each time.
  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission?.granted]);

  const onScan = (r: BarcodeScanningResult) => {
    if (locked.current) return;
    locked.current = true;
    if (onCode(r.data)) return;
    setHint('That code is not a Zoyra or Audius link.');
    setTimeout(() => (locked.current = false), 1500);
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {permission?.granted ? (
          <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScan} />
        ) : null}
        <View style={{ flex: 1, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24, paddingHorizontal: 16, justifyContent: 'space-between' }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={18} weight={700}>
              Scan a code
            </T>
            <IconButton icon="close" label="Close scanner" bg={colors.chipGhost} onPress={onClose} />
          </Row>
          {!permission ? (
            <Loading label="Opening camera" />
          ) : !permission.granted ? (
            <View style={{ gap: 12, alignItems: 'center' }}>
              <T size={16} align="center">
                Camera access is needed to scan QR codes.
              </T>
              <LinkText
                label={permission.canAskAgain ? 'Allow camera' : 'Open Settings'}
                onPress={() => (permission.canAskAgain ? void requestPermission() : void Linking.openSettings().catch(() => {}))}
              />
            </View>
          ) : (
            <View style={{ alignSelf: 'center', width: 240, height: 240, borderRadius: 36, borderWidth: 4, borderColor: colors.accent }} />
          )}
          <View style={{ gap: 8 }}>
            {hint ? <Toast icon="info" iconColor={colors.amber} message={hint} /> : null}
            <T size={13} color={colors.textSecondary} align="center">
              Point at a Zoyra share code or an Audius link.
            </T>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default function Search() {
  const { user } = useAuth();
  const uid = user?.id;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('All');
  // `committed` is the query whose results are on screen. Typing only updates `query` and shows suggestions;
  // submitting, tapping a suggestion / recent / trending search, voice or a QR code commits it.
  const [committed, setCommitted] = useState('');
  const suggestFor = useDebounced(query.trim(), 200);
  const run = (q: string) => {
    setQuery(q);
    setCommitted(q.trim());
  };
  const f = useSearchFilters();
  const { note, show } = useNote();
  const [scanning, setScanning] = useState(false);
  // Older links open Search with ?recognize=1: forward them to the Identify screen.
  const { recognize } = useLocalSearchParams<{ recognize?: string }>();
  useEffect(() => {
    if (recognize !== '1') return;
    router.setParams({ recognize: undefined });
    router.push({ pathname: '/identify', params: { auto: '1' } });
  }, [recognize]);

  const handleCode = (data: string) => {
    const code = parseCode(data);
    if (!code) return false;
    setScanning(false);
    if (code.kind === 'route') router.push(code.path as Href);
    else run(code.query);
    return true;
  };

  /* ---------------- recent searches (search_history) */
  const [recentRows, setRecent] = useState<string[]>([]);
  const recent = useMemo(() => (uid ? recentRows : []), [uid, recentRows]);
  const loadRecent = useCallback(() => {
    if (!uid) return Promise.resolve();
    return fetchRecent(uid)
      .then(setRecent)
      .catch(() => {});
  }, [uid]);
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    fetchRecent(uid)
      .then((r) => alive && setRecent(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [uid]);

  const saveQuery = useCallback(
    (q: string) => {
      const v = q.trim();
      if (!uid || !v) return;
      setRecent((r) => [v, ...r.filter((x) => x.toLowerCase() !== v.toLowerCase())].slice(0, 5));
      void supabase.from('search_history').insert({ user_id: uid, query: v }).then(undefined, () => undefined);
    },
    [uid],
  );

  const removeRecent = async (q: string) => {
    if (!uid) return;
    setRecent((l) => l.filter((x) => x !== q));
    const { error } = await supabase.from('search_history').delete().eq('user_id', uid).ilike('query', q);
    if (error) {
      show('Could not remove that search');
      void loadRecent();
    }
  };

  /* Save the query when a search result starts playing. */
  const playing = usePlayerSelector((x) => x.track);
  const playContext = usePlayerSelector((x) => x.context);
  const { pause, getState: playerState } = usePlayerActions();
  useEffect(() => {
    if (!uid || !playing || !playContext?.startsWith('Search: ')) return;
    const v = playContext.slice(8).trim();
    if (!v) return;
    let alive = true;
    void (async () => {
      await supabase.from('search_history').insert({ user_id: uid, query: v });
      const r = await fetchRecent(uid);
      if (alive) setRecent(r);
    })().catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playContext]);

  /* ---------------- voice search */
  const voiceSearch = useVoiceSearch({
    onPartial: setQuery,
    onFinal: (text) => {
      run(text);
      saveQuery(text);
    },
    onBeforeStart: () => {
      if (playerState().playing) pause(); // keep our own music out of the mic
    },
  });
  const { voice, listening } = voiceSearch;

  /* ---------------- trending searches */
  const trending = useAsync(() => catalog.trending({ limit: 4 }), [], 'app/(tabs)/search:314');

  /* ---------------- results */
  const singleGenre = f.genres.length === 1 ? f.genres[0] : undefined;
  // Songs come from the fast backend, artists/albums from Audius (about a second slower). They load separately so the
  // songs show the moment they arrive instead of waiting for the slowest of the three; the others fill in after.
  const podcasts = filter === 'Podcasts';
  const wantTracks = filter === 'All' || filter === 'Songs' || podcasts;
  const wantArtists = filter === 'All' || filter === 'Artists';
  const wantCollections = filter === 'All' || filter === 'Albums' || filter === 'Playlists';
  const trackRes = useAsync<CatalogTrack[]>(
    async () => (!committed || !wantTracks ? [] : catalog.searchTracks(committed, podcasts ? { genre: 'Podcasts', limit: 40 } : { genre: singleGenre, limit: filter === 'All' ? 20 : 50 })),
    [committed, filter, singleGenre],
    'app/(tabs)/search:tracks',
  );
  // Secondary sections never block or fail the screen: a slow or failed lookup just leaves them out.
  const artistRes = useAsync<Artist[]>(async () => (!committed || !wantArtists ? [] : catalog.searchArtists(committed, filter === 'All' ? 5 : 20).catch(() => [] as Artist[])), [committed, filter], 'app/(tabs)/search:artists');
  const collRes = useAsync<Collection[]>(async () => (!committed || !wantCollections ? [] : catalog.searchCollections(committed, filter === 'All' ? 10 : 25).catch(() => [] as Collection[])), [committed, filter], 'app/(tabs)/search:collections');
  const anyLoading = trackRes.loading || artistRes.loading || collRes.loading;
  const hasAny = !!(trackRes.data?.length || artistRes.data?.length || collRes.data?.length);
  const resultsData = useMemo(
    () => (committed ? ({ tracks: trackRes.data ?? [], artists: artistRes.data ?? [], collections: collRes.data ?? [] } satisfies Results) : null),
    [committed, trackRes.data, artistRes.data, collRes.data],
  );
  const results = {
    data: resultsData,
    // Songs are the main result and sit at the top: hold the screen (skeleton rows) until they have arrived, so artists
    // and albums can never show first and then get pushed down when the songs land. They fill in below afterwards.
    loading: (wantTracks && trackRes.loading) || (anyLoading && !hasAny),
    settled: !anyLoading,
    error: trackRes.error,
    reload: () => Promise.all([trackRes.reload(), artistRes.reload(), collRes.reload()]).then(() => undefined),
    refresh: () => Promise.all([trackRes.refresh(), artistRes.refresh(), collRes.refresh()]).then(() => undefined),
  };

  // Content controls: hidden songs/artists and (kid-safe) explicit songs stay out of results.
  const { filter: hideFilter, hiddenArtists } = useContentFilter();
  const trendingList = trending.data ? hideFilter(trending.data) : undefined;
  const shown = useMemo(() => {
    const r = results.data;
    if (!r) return null;
    const tracks = applyTrackFilters(hideFilter(r.tracks), f);
    const collections = r.collections.filter((c) => (filter === 'Albums' ? c.isAlbum : filter === 'Playlists' ? !c.isAlbum : true));
    return {
      tracks: filter === 'All' ? tracks.slice(0, 12) : tracks,
      artists: r.artists.filter((a) => !hiddenArtists.has(a.id)),
      collections: filter === 'All' ? collections.slice(0, 5) : collections,
    };
  }, [results.data, f, filter, hideFilter, hiddenArtists]);

  /* Pull to refresh: results (when searching), else trending + recent searches. */
  const refresh = () => (committed ? results.refresh() : Promise.all([trending.refresh(), loadRecent()]));

  const openArtist = (a: Artist) => {
    saveQuery(query);
    router.push({ pathname: '/artist', params: { id: a.id } });
  };
  const openCollection = (c: Collection) => {
    saveQuery(query);
    if (c.isAlbum) router.push({ pathname: '/album', params: { id: c.id } });
    else router.push({ pathname: '/playlist', params: { catalog: c.id } });
  };

  // LRCLIB (our lyrics source) only indexes titles/artists, not lyric text; searching inside lyrics needs a licensed lyrics search API.
  const unsupported = filter === 'Lyrics' ? 'Searching by a line of lyrics needs a lyrics search service (such as Musixmatch) that Zoyra is not connected to. Search by song title or artist instead.' : null;
  const filtersOn = searchFilters.isActive(f);
  const { width: winW } = useWindowDimensions();
  const tileW = Math.floor((winW - APPLE.side * 2 - APPLE.gap) / 2);
  // Suggestions: your recent searches that match first (instant), then YouTube's, no duplicates.
  const typing = !!query.trim() && query.trim() !== committed;
  const remote = useAsync(() => (suggestFor ? catalog.suggest(suggestFor) : Promise.resolve([] as string[])), [suggestFor], 'app/(tabs)/search:suggest');
  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const seen = new Set<string>();
    const out: { text: string; recent: boolean }[] = [];
    for (const r of recent) {
      if (!r.toLowerCase().includes(q) || seen.has(r.toLowerCase())) continue;
      seen.add(r.toLowerCase());
      out.push({ text: r, recent: true });
    }
    for (const x of remote.data ?? []) {
      if (seen.has(x.toLowerCase())) continue;
      seen.add(x.toLowerCase());
      out.push({ text: x, recent: false });
    }
    return out.slice(0, 10);
  }, [query, recent, remote.data]);
  const empty = shown && results.settled && !shown.tracks.length && !shown.artists.length && !shown.collections.length;

  return (
    <Screen tabbed gap={APPLE.section - 8} backdrop={{ pattern: 'lines', mesh: 'amber' }} onRefresh={refresh}>
      <AppleTitle title="Search" />

      {/* Search field: rounded pill */}
      <Row gap={8} style={{ height: 46, paddingLeft: 14, paddingRight: 4, borderRadius: 23, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder }}>
        <Icon name="search" size={20} color={colors.textSecondary} />
        <TextInput
          accessibilityLabel="Search"
          value={query}
          onChangeText={(t) => {
            setQuery(t);
            if (!t.trim()) setCommitted('');
          }}
          onSubmitEditing={() => {
            run(query);
            saveQuery(query);
          }}
          placeholder="Artists, songs, lyrics and more"
          placeholderTextColor={colors.textTertiary}
          returnKeyType="search"
          autoCorrect={false}
          style={{ flex: 1, minWidth: 0, height: 44, color: colors.text, fontFamily: fonts.regular, fontSize: 16 }}
        />
        {query ? (
          <IconButton icon="close" label="Clear search" iconSize={18} color={colors.textSecondary} onPress={() => run('')} />
        ) : (
          <IconButton icon="qr" label="Scan QR code" onPress={() => setScanning(true)} />
        )}
        <IconButton
          icon={listening ? 'pause' : 'mic'}
          label={listening ? 'Stop listening and search' : 'Voice search'}
          bg={listening ? colors.like : colors.accent}
          color={colors.onAccent}
          onPress={() => (listening ? voiceSearch.stop() : void voiceSearch.start())}
        />
      </Row>

      {voice.state === 'starting' || voice.state === 'listening' ? (
        <Toast
          icon="mic"
          iconColor={colors.accent}
          message={voice.state === 'starting' ? 'Starting the microphone…' : voice.transcript ? `Listening… "${voice.transcript}"` : 'Listening… say a song, artist or album'}
          action="Cancel"
          onAction={voiceSearch.cancel}
        />
      ) : voice.state === 'error' ? (
        <Toast icon="info" iconColor={colors.amber} message={voice.message} action="Dismiss" onAction={voiceSearch.dismiss} />
      ) : null}

      {note ? <Toast icon="info" iconColor={colors.amber} message={note} /> : null}

      {scanning ? <QrScanner onClose={() => setScanning(false)} onCode={handleCode} /> : null}

      <ChipRow options={[...filters]} onChange={(i) => setFilter(filters[i])} />

      {committed || typing ? null : <VideoEntryCard title="Browse videos" subtitle="Music videos, live sets and shorts" />}

      {typing ? (
        /* ---------------- suggestions while typing */
        <View accessibilityLabel="Search suggestions">
          {/* The typed text itself is always the first row, so Enter-less users can search it. */}
          <Tap accessibilityLabel={`Search for ${query.trim()}`} onPress={() => { run(query); saveQuery(query); }} style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Icon name="search" size={20} color={colors.accent} />
            <T size={16} weight={600} style={{ flex: 1 }} numberOfLines={1}>
              {`Search "${query.trim()}"`}
            </T>
          </Tap>
          {suggestions.map((sg) => (
            <View key={sg.text} style={{ borderTopWidth: 1, borderTopColor: colors.divider }}>
              <Row style={{ minHeight: 52 }}>
                <Tap accessibilityLabel={`Search ${sg.text}`} onPress={() => { run(sg.text); saveQuery(sg.text); }} style={{ flex: 1, minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <Icon name={sg.recent ? 'clock' : 'search'} size={20} color={colors.textSecondary} />
                  <T size={16} style={{ flex: 1 }} numberOfLines={1}>
                    {sg.text}
                  </T>
                </Tap>
                {/* Put the suggestion in the field to refine it without searching yet. */}
                <IconButton icon="chevronRight" label={`Use ${sg.text} in the search field`} iconSize={18} color={colors.textSecondary} onPress={() => setQuery(sg.text)} />
              </Row>
            </View>
          ))}
          {remote.loading && !suggestions.length ? <Loading height={60} /> : null}
        </View>
      ) : committed ? (
        /* ---------------- results */
        <View style={{ gap: 8 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={13} color={colors.textSecondary} style={{ flex: 1 }} numberOfLines={1}>
              {filtersOn ? [f.sort !== 'Relevance' ? f.sort : null, ...f.genres, ...f.moods].filter(Boolean).join(' · ') : 'No filters'}
            </T>
            {filtersOn ? <LinkText label="Clear" size={13} onPress={searchFilters.reset} /> : null}
            <LinkText label="Filters" icon="filter" size={13} href="/filter-sort" />
          </Row>
          {unsupported ? (
            <EmptyState icon="search" title="Lyrics search is not connected" body={unsupported} />
          ) : results.loading ? (
            <SkeletonRows rows={filter === 'All' ? 8 : 10} art={56} />
          ) : results.error ? (
            <ErrorState message={results.error} onRetry={results.reload} />
          ) : empty || !shown ? (
            <EmptyState icon="search" title={`No results for "${committed}"`} body={filtersOn ? 'Try clearing your filters.' : 'Check the spelling or try another search.'} />
          ) : (
            <>
              {shown.tracks.length ? (
                <View>
                  {filter === 'All' ? <SectionHeader title="Songs" /> : null}
                  <AppleTrackList tracks={shown.tracks} context={`Search: ${committed}`} subtitle={(t) => `Song · ${t.artist.name}`} />
                </View>
              ) : null}
              {shown.artists.length ? (
                <View>
                  {filter === 'All' ? <SectionHeader title="Artists" /> : null}
                  {shown.artists.map((a, i) => (
                    <View key={a.id}>
                      {i > 0 ? <AppleSeparator /> : null}
                      <ArtistRow a={a} onOpen={() => openArtist(a)} />
                    </View>
                  ))}
                </View>
              ) : null}
              {shown.collections.length ? (
                <View>
                  {filter === 'All' ? <SectionHeader title="Albums and playlists" /> : null}
                  {shown.collections.map((c, i) => (
                    <View key={c.id}>
                      {i > 0 ? <AppleSeparator /> : null}
                      <CollectionRow c={c} onOpen={() => openCollection(c)} />
                    </View>
                  ))}
                </View>
              ) : null}
            </>
          )}
        </View>
      ) : (
        <>
          {/* Song recognition */}
          <Tap
            accessibilityLabel="What is playing? Tap to identify a song around you"
            onPress={() => router.push('/identify')}
            style={[{ borderRadius: 20 }, shadow.sticker]}
          >
            <Gradient colors={art.orange} style={{ borderRadius: 20, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <IconBadge icon="mic" size={52} />
              <View style={{ flex: 1, gap: 2 }}>
                <T size={18} weight={700} color={colors.white}>
                  What is playing?
                </T>
                <T size={14} color={colors.white} style={{ opacity: 0.9 }}>
                  Tap to identify a song around you
                </T>
              </View>
              <Icon name="chevronRight" size={22} color={colors.white} />
            </Gradient>
          </Tap>

          {/* Recent */}
          {recent.length ? (
            <>
              <SectionHeader title="Recent" />
              <View style={{ marginTop: -8 }}>
                {recent.map((r) => (
                  <Row key={r} style={{ minHeight: 48 }}>
                    <Tap accessibilityLabel={`Search ${r}`} onPress={() => run(r)} style={{ flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <Icon name="clock" size={20} color={colors.textSecondary} />
                      <T size={16} style={{ flex: 1 }} numberOfLines={1}>
                        {r}
                      </T>
                    </Tap>
                    <IconButton icon="close" label={`Remove ${r}`} iconSize={18} color={colors.textSecondary} onPress={() => void removeRecent(r)} />
                  </Row>
                ))}
              </View>
            </>
          ) : null}

          {/* Trending */}
          <SectionHeader title="Trending searches" />
          <View style={{ marginTop: -8 }}>
            {trending.loading && !trending.data ? (
              <Loading height={80} />
            ) : trending.error ? (
              <ErrorState message={trending.error} onRetry={trending.reload} />
            ) : !trendingList?.length ? (
              <T size={14} color={colors.textSecondary}>
                Nothing trending right now.
              </T>
            ) : (
              trendingList.map((t, i) => (
                <Tap key={t.id} onPress={() => run(t.title)} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <T mono size={14} color={colors.textSecondary}>
                    {i + 1}
                  </T>
                  <T size={16} style={{ flex: 1 }} numberOfLines={1}>
                    {t.title.toLowerCase()}
                  </T>
                  {i === 0 ? <Sticker label="HOT" bg={colors.like} rotate={3} /> : null}
                </Tap>
              ))
            )}
          </View>

          {/* Browse categories */}
          <View style={{ gap: 12 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T size={22} weight={700} tracking={-0.4} accessibilityRole="header">
                Browse categories
              </T>
              <LinkText label={filtersOn ? 'Filters on' : 'Filters'} icon="filter" size={13} href="/filter-sort" />
            </Row>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: APPLE.gap }}>
              {genres.map((g) => (
                <CategoryTile
                  key={g.label}
                  label={g.label}
                  bg={g.bg}
                  width={tileW}
                  height={Math.round(tileW / 1.78)}
                  onPress={() => router.push({ pathname: '/genre', params: { name: g.label } })}
                />
              ))}
            </View>
          </View>
        </>
      )}
    </Screen>
  );
}
