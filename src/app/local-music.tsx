import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Linking, RefreshControl, View } from 'react-native';

import { Button, EmptyState, ErrorState, Glass, Icon, IconButton, ListRow, Loading, MiniPlayer, Row, Screen, ScreenHeader, Segmented, T, TextField, Toast, TrackItem } from '../components';
import {
  expoGoLimited,
  filterTracks,
  getAvailability,
  getPermission,
  groupTracks,
  importFiles,
  MIN_SECONDS,
  removeImported,
  requestPermission,
  resetScanCache,
  scanPage,
  useImported,
  type Group,
  type GroupBy,
  type LocalTrack,
  type PermissionState,
} from '../lib/local-music';
import { useDebounced } from '../components/media';
import { usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

const CONTEXT = 'Local files';
const VIEWS: GroupBy[] = ['songs', 'artists', 'albums', 'folders'];
const VIEW_LABELS = ['Songs', 'Artists', 'Albums', 'Folders'];

type Scan = {
  items: LocalTrack[];
  total: number;
  hiddenShort: number;
  loading: boolean;
  done: boolean;
  error: string | null;
};

const EMPTY_SCAN: Scan = { items: [], total: 0, hiddenShort: 0, loading: false, done: false, error: null };

const message = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

/** Pages through the device's audio files (200 at a time) until everything is loaded. */
function useDeviceScan(enabled: boolean) {
  const [scan, setScan] = useState<Scan>(EMPTY_SCAN);
  const run = useRef(0);

  const start = useCallback(async () => {
    const id = ++run.current;
    resetScanCache();
    setScan({ ...EMPTY_SCAN, loading: true });
    let after: string | undefined;
    try {
      for (;;) {
        const page = await scanPage(after);
        if (id !== run.current) return;
        setScan((s) => ({
          ...s,
          items: [...s.items, ...page.items],
          total: page.totalCount,
          hiddenShort: s.hiddenShort + page.hiddenShort,
          done: !page.hasNextPage,
          loading: page.hasNextPage,
        }));
        if (!page.hasNextPage || !page.endCursor) break;
        after = page.endCursor;
      }
    } catch (e) {
      if (id === run.current) setScan((s) => ({ ...s, loading: false, error: message(e) }));
    }
  }, []);

  useEffect(() => {
    const runs = run;
    if (enabled) void start();
    return () => {
      runs.current++;
    };
  }, [enabled, start]);

  return { scan, rescan: start };
}

function PermissionGate({ perm, onRequest, busy }: { perm: PermissionState; onRequest: () => void; busy: boolean }) {
  const denied = perm.status === 'denied';
  return (
    <Glass padding={16}>
      <View style={{ gap: 12 }}>
        <Row gap={10}>
          <Icon name="lock" size={20} color={colors.accentLight} />
          <T variant="bodyStrong">{denied ? 'Access to audio files is off' : 'Play the music on your phone'}</T>
        </Row>
        <T size={14} color={colors.textSecondary} lineHeight={20}>
          {denied
            ? perm.canAskAgain
              ? 'Zoyra needs permission to read audio files to show your local music.'
              : 'You turned off access to music and audio. Turn it on for Zoyra in Settings.'
            : 'Zoyra reads the audio files on this device so you can play them here. Nothing is uploaded.'}
        </T>
        {expoGoLimited ? (
          <T size={13} color={colors.warning} lineHeight={18}>
            Expo Go can’t be granted access to audio files. Use the Zoyra development build to scan your music.
          </T>
        ) : null}
        {denied && !perm.canAskAgain ? (
          <Button label="Open Settings" icon="sliders" variant="glass" onPress={() => void Linking.openSettings()} />
        ) : (
          <Button label={busy ? 'Waiting…' : 'Allow access'} icon="music" onPress={busy ? undefined : onRequest} />
        )}
      </View>
    </Glass>
  );
}

export default function LocalMusic() {
  const availability = useMemo(() => getAvailability(), []);
  const player = usePlayerPick('shuffle');
  const imported = useImported();

  const [perm, setPerm] = useState<PermissionState | null>(null);
  const [permError, setPermError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [view, setView] = useState<GroupBy>('songs');
  const [openGroup, setOpenGroup] = useState<Group | null>(null);
  const [query, setQuery] = useState('');
  const q = useDebounced(query, 200);
  const [importing, setImporting] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((text: string, ok = true) => {
    setNote({ text, ok });
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 3500);
  }, []);
  useEffect(() => () => void (noteTimer.current && clearTimeout(noteTimer.current)), []);

  useEffect(() => {
    if (!availability.scan) return;
    getPermission()
      .then(setPerm)
      .catch((e: unknown) => setPermError(message(e)));
  }, [availability.scan]);

  const canScan = availability.scan && (perm?.status === 'granted' || perm?.status === 'limited');
  const { scan, rescan } = useDeviceScan(canScan);

  const ask = async () => {
    setAsking(true);
    setPermError(null);
    try {
      setPerm(await requestPermission());
    } catch (e) {
      setPermError(message(e));
    } finally {
      setAsking(false);
    }
  };

  const addFiles = async () => {
    setImporting(true);
    try {
      const r = await importFiles();
      if (r.cancelled) return;
      if (r.added) show(`Added ${r.added} ${r.added === 1 ? 'file' : 'files'}${r.failed ? ` · ${r.failed} failed` : ''}`);
      else if (r.failed) show(r.reason ?? `Couldn’t add ${r.failed === 1 ? 'that file' : 'those files'}`, false);
    } catch (e) {
      show(message(e), false);
    } finally {
      setImporting(false);
    }
  };

  const all = useMemo(() => [...(imported ?? []), ...scan.items], [imported, scan.items]);
  const filtered = useMemo(() => {
    if (!openGroup) return filterTracks(all, q);
    const ids = new Set(openGroup.tracks.map((t) => t.id));
    return filterTracks(all.filter((l) => ids.has(l.track.id)), q);
  }, [all, q, openGroup]);
  const groups = useMemo(() => (view === 'songs' || openGroup ? [] : groupTracks(filtered, view)), [filtered, view, openGroup]);
  const songList = useMemo(() => filtered.map((l) => l.track), [filtered]);

  const playAll = (shuffle: boolean) => {
    if (!songList.length) return;
    if (player.shuffle !== shuffle) player.setShuffle(shuffle);
    const r = player.playTracks(songList, shuffle ? Math.floor(Math.random() * songList.length) : 0, openGroup ? `${CONTEXT} · ${openGroup.title}` : CONTEXT);
    if (r.reason) show(r.reason, false);
  };

  const refreshing = scan.loading && scan.items.length === 0 && perm !== null;
  const showSongs = view === 'songs' || openGroup !== null;

  const header = (
    <View style={{ gap: 16, paddingBottom: 8 }}>
      {!availability.scan ? (
        <Glass padding={16}>
          <Row gap={10} align="flex-start">
            <Icon name="info" size={20} color={colors.accentLight} />
            <T size={14} color={colors.textSecondary} lineHeight={20} style={{ flex: 1 }}>
              {availability.reason}
            </T>
          </Row>
        </Glass>
      ) : permError ? (
        <ErrorState message={permError} onRetry={() => void ask()} />
      ) : perm === null ? (
        <Loading label="Checking access" height={80} />
      ) : perm.status === 'granted' || perm.status === 'limited' ? null : (
        <PermissionGate perm={perm} onRequest={() => void ask()} busy={asking} />
      )}

      {perm?.status === 'limited' ? (
        <Toast icon="info" iconColor={colors.warning} message="Zoyra can only see some of your audio files. Allow full access in Settings." action="Settings" onAction={() => void Linking.openSettings()} />
      ) : null}

      {availability.scan || availability.canImport ? (
        <Button label={importing ? 'Adding…' : 'Add audio files'} icon="plus" variant="glass" onPress={importing ? undefined : () => void addFiles()} />
      ) : null}

      {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.error} message={note.text} /> : null}

      {all.length > 0 ? (
        <>
          <TextField label="Search local files" hideLabel placeholder="Search songs, artists, albums, folders" icon="search" value={query} onChangeText={setQuery} autoCorrect={false} returnKeyType="search" />
          {openGroup ? (
            <Row gap={8}>
              <IconButton icon="back" label="Back to groups" onPress={() => setOpenGroup(null)} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T variant="bodyStrong" numberOfLines={1}>
                  {openGroup.title}
                </T>
                <T variant="small" color={colors.textSecondary} numberOfLines={1}>
                  {openGroup.subtitle}
                </T>
              </View>
            </Row>
          ) : (
            <Segmented
              options={VIEW_LABELS}
              initial={VIEWS.indexOf(view)}
              onChange={(i) => {
                setView(VIEWS[i]);
                setOpenGroup(null);
              }}
            />
          )}
          {showSongs && songList.length > 0 ? (
            <Row gap={12}>
              <Button label="Play" icon="play" style={{ flex: 1 }} onPress={() => playAll(false)} />
              <Button label="Shuffle" icon="shuffle" variant="glass" style={{ flex: 1 }} onPress={() => playAll(true)} />
            </Row>
          ) : null}
        </>
      ) : null}

      {canScan && (scan.loading || scan.done) && scan.items.length > 0 ? (
        <Row gap={8}>
          {scan.loading ? <ActivityIndicator size="small" color={colors.accent} /> : null}
          <T mono size={12} color={colors.textSecondary}>
            {scan.loading ? `Scanning… ${scan.items.length + scan.hiddenShort} of ${scan.total}` : `${scan.items.length} songs on this device`}
            {scan.hiddenShort ? ` · ${scan.hiddenShort} clips under ${MIN_SECONDS}s hidden` : ''}
          </T>
        </Row>
      ) : null}
      {scan.error ? <ErrorState message={scan.error} onRetry={() => void rescan()} /> : null}
    </View>
  );

  const empty = () => {
    if (canScan && scan.loading) return <Loading label="Scanning your music" />;
    if (imported === null) return <Loading />;
    if (all.length > 0) return <EmptyState icon="search" title="No matches" body="Try a different song, artist, album or folder name." />;
    if (canScan && scan.done)
      return <EmptyState icon="music" title="No audio files found" body="Songs saved in Music or Download folders show up here. You can also add files from the picker." />;
    if (availability.scan || availability.canImport) return <EmptyState icon="music" title="No local songs yet" body="Add audio files from your phone to play them in Zoyra." />;
    return null;
  };

  const footerNote =
    all.length > 0 ? (
      <T size={12} color={colors.textTertiary} lineHeight={17} style={{ paddingTop: 12 }}>
        Titles, artists and albums come from file and folder names. Local songs play from this device and aren’t added to your listening history or likes.
      </T>
    ) : null;

  const refresh = canScan ? (
    <RefreshControl refreshing={refreshing} onRefresh={() => void rescan()} tintColor={colors.accent} colors={[colors.accent]} />
  ) : undefined;

  return (
    <Screen scroll={false} backdrop={{ pattern: 'lines', mesh: 'gold' }} top={4} gap={8} bottom={0} footer={<MiniPlayer />}>
      <ScreenHeader title="Local files" />
      {showSongs ? (
        <FlatList
          data={filtered}
          keyExtractor={(l) => l.track.id}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          ListFooterComponent={footerNote ?? undefined}
          refreshControl={refresh}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          initialNumToRender={20}
          windowSize={11}
          contentContainerStyle={{ paddingBottom: 24 }}
          renderItem={({ item, index }) => (
            <TrackItem
              track={item.track}
              list={songList}
              index={index}
              context={openGroup ? `${CONTEXT} · ${openGroup.title}` : CONTEXT}
              showDuration={item.track.duration > 0}
              subtitle={`${item.track.artist.name}${item.meta.album !== item.track.artist.name ? ` · ${item.meta.album}` : ''}`}
              right={
                item.meta.source === 'imported' ? (
                  <IconButton
                    icon="trash"
                    label={`Remove ${item.track.title}`}
                    color={colors.textSecondary}
                    onPress={() =>
                      void removeImported(item.track.id)
                        .then(() => show('Removed from Zoyra'))
                        .catch((e: unknown) => show(message(e), false))
                    }
                  />
                ) : (
                  <View style={{ width: 44, alignItems: 'center' }} accessibilityLabel="On this device">
                    <Icon name="phone" size={16} color={colors.textTertiary} />
                  </View>
                )
              }
            />
          )}
        />
      ) : (
        <FlatList
          data={groups}
          keyExtractor={(g) => g.key}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          ListFooterComponent={footerNote ?? undefined}
          refreshControl={refresh}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 24 }}
          renderItem={({ item, index }) => (
            <ListRow
              divider={index > 0}
              minHeight={64}
              icon={view === 'artists' ? 'user' : view === 'albums' ? 'music' : 'file'}
              title={item.title}
              subtitle={item.subtitle}
              onPress={() => {
                setOpenGroup(item);
                setQuery('');
              }}
            />
          )}
        />
      )}
    </Screen>
  );
}
