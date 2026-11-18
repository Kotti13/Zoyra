import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDocumentAsync, type DocumentPickerResult } from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Button, Cover, EmptyState, Glass, Gradient, Icon, LinkText, ListRow, Loading, Row, Screen, ScreenHeader, SectionHeader, Spacer, T, Tap, Toast } from '../components';
import {
  SPOTIFY_SETUP_MESSAGE,
  connectSpotify,
  disconnectSpotify,
  getStoredToken,
  listPlaylists,
  matchTracks,
  playlistTracks,
  spotifyConfigured,
  type SpotifyPlaylist,
} from '../lib/spotify';
import { matchEntries, parsePlaylistFile, type MatchResult } from '../lib/playlistFile';
import { useLibrary } from '../state/library';
import { colors } from '../theme/tokens';

const sources = ['Spotify', 'Apple Music', 'YouTube Music', 'From file'] as const;
type Source = (typeof sources)[number];

/** What each other import source still needs before it can work. */
const NEEDS: Record<Exclude<Source, 'Spotify' | 'From file'>, string> = {
  'Apple Music': 'Apple Music import needs an Apple MusicKit developer token.',
  'YouTube Music': 'YouTube Music import needs Google OAuth app credentials.',
};
const FILE_EXTS = ['m3u', 'm3u8', 'csv', 'txt'];
const FILE_HINT = 'Pick an .m3u, .m3u8, .csv or .txt playlist (e.g. an Exportify CSV). We match each line against our catalogue.';
const MAX_FILE_BYTES = 5 * 1024 * 1024;

type Summary = { playlistId: string; title: string; matched: number; total: number; at: string };
const HISTORY_KEY = 'zoyra.import.history';

type Progress = { name: string; phase: 'reading' | 'matching' | 'saving'; done: number; total: number };

export default function Import() {
  const lib = useLibrary();
  const [source, setSource] = useState<Source>('Spotify');
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [connected, setConnected] = useState<string | null | undefined>(undefined); // undefined = loading, string = display name
  const [connecting, setConnecting] = useState(false);
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [history, setHistory] = useState<Summary[]>([]);
  const cancelRef = useRef(false);
  const [fileResults, setFileResults] = useState<{ name: string; results: (MatchResult | null)[] } | null>(null);

  useEffect(() => {
    getStoredToken().then((t) => setConnected(t ? (t.displayName ?? 'Spotify') : null));
    AsyncStorage.getItem(HISTORY_KEY)
      .then((raw) => raw && setHistory(JSON.parse(raw) as Summary[]))
      .catch(() => {});
    return () => {
      cancelRef.current = true;
    };
  }, []);

  const onListError = useCallback((e: unknown) => {
    const msg = e instanceof Error ? e.message : 'Could not load your Spotify playlists';
    setListError(msg);
    if (/expired/i.test(msg)) setConnected(null);
  }, []);

  const loadPlaylists = useCallback(async () => {
    setListError(null);
    setPlaylists(null);
    try {
      setPlaylists(await listPlaylists());
    } catch (e) {
      onListError(e);
    }
  }, [onListError]);

  useEffect(() => {
    if (!connected) return;
    let alive = true;
    listPlaylists().then(
      (p) => alive && setPlaylists(p),
      (e: unknown) => alive && onListError(e),
    );
    return () => {
      alive = false;
    };
  }, [connected, onListError]);

  const connect = async () => {
    if (!spotifyConfigured()) return setNote({ text: SPOTIFY_SETUP_MESSAGE, error: true });
    setNote(null);
    setConnecting(true);
    try {
      const t = await connectSpotify();
      if (t) setConnected(t.displayName ?? 'Spotify');
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Could not connect Spotify', error: true });
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    await disconnectSpotify();
    setConnected(null);
    setPlaylists(null);
  };

  const importPlaylist = async (p: SpotifyPlaylist) => {
    if (progress) return;
    cancelRef.current = false;
    setNote(null);
    setProgress({ name: p.name, phase: 'reading', done: 0, total: p.total });
    try {
      const tracks = await playlistTracks(p.id);
      if (!tracks.length) throw new Error(`"${p.name}" has no songs to import`);
      setProgress({ name: p.name, phase: 'matching', done: 0, total: tracks.length });
      const matches = await matchTracks(tracks, (done, total) => setProgress((x) => (x ? { ...x, done, total } : x)), () => cancelRef.current);
      if (cancelRef.current) return setNote({ text: 'Import cancelled. Nothing was added.' });
      if (!matches.length) {
        setNote({ text: `None of the ${tracks.length} songs in "${p.name}" are in our catalogue yet. Nothing was added.` });
        return;
      }
      setProgress((x) => (x ? { ...x, phase: 'saving' } : x));
      const summaryText = `${matches.length} of ${tracks.length} matched`;
      const pl = await lib.createPlaylist({ title: p.name, description: `Imported from Spotify · ${summaryText}`, visibility: 'private' });
      await lib.addToPlaylist(pl.id, matches);
      await lib.reload();
      saveHistory({ playlistId: pl.id, title: p.name, matched: matches.length, total: tracks.length, at: new Date().toISOString() });
      setNote({ text: `"${p.name}" imported: ${summaryText}.` });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Import failed', error: true });
    } finally {
      setProgress(null);
    }
  };

  const saveHistory = (entry: Summary) =>
    setHistory((h) => {
      const next = [entry, ...h].slice(0, 20);
      AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });

  const importFile = async () => {
    if (progress) return;
    setNote(null);
    let picked: DocumentPickerResult;
    try {
      picked = await getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
    } catch (e) {
      return setNote({ text: e instanceof Error ? e.message : 'Could not open the file picker', error: true });
    }
    if (picked.canceled || !picked.assets[0]) return;
    const asset = picked.assets[0];
    const ext = asset.name.toLowerCase().split('.').pop() ?? '';
    if (!FILE_EXTS.includes(ext)) return setNote({ text: `"${asset.name}" isn't a playlist file. ${FILE_HINT}`, error: true });
    if (asset.size && asset.size > MAX_FILE_BYTES) return setNote({ text: 'That file is too large (max 5 MB).', error: true });
    const name = asset.name.replace(/\.[^.]+$/, '') || 'Imported playlist';
    cancelRef.current = false;
    setFileResults(null);
    setProgress({ name, phase: 'reading', done: 0, total: 0 });
    try {
      const text = await new File(asset.uri).text();
      const entries = parsePlaylistFile(asset.name, text);
      if (!entries.length) throw new Error(`No songs found in "${asset.name}". Lines should look like "Artist - Title".`);
      setProgress({ name, phase: 'matching', done: 0, total: entries.length });
      const live: (MatchResult | null)[] = new Array(entries.length).fill(null);
      setFileResults({ name, results: [...live] });
      let lastPush = 0;
      const results = await matchEntries(
        entries,
        (i, r, done) => {
          live[i] = r;
          setProgress((x) => (x ? { ...x, done } : x));
          // Re-render the matched/unmatched list at most ~4x a second.
          if (Date.now() - lastPush > 250 || done === entries.length) {
            lastPush = Date.now();
            setFileResults({ name, results: [...live] });
          }
        },
        () => cancelRef.current,
      );
      setFileResults({ name, results: [...live] });
      if (cancelRef.current) return setNote({ text: 'Import cancelled. Nothing was added.' });
      const seen = new Set<string>();
      const matches = results.flatMap((r) => (r.track && !seen.has(r.track.id) ? (seen.add(r.track.id), [r.track]) : []));
      if (!matches.length) return setNote({ text: `None of the ${entries.length} songs in "${asset.name}" are in our catalogue yet. Nothing was added.` });
      setProgress((x) => (x ? { ...x, phase: 'saving' } : x));
      const summaryText = `${matches.length} of ${entries.length} matched`;
      const pl = await lib.createPlaylist({ title: name, description: `Imported from ${asset.name} · ${summaryText}`, visibility: 'private' });
      await lib.addToPlaylist(pl.id, matches);
      await lib.reload();
      saveHistory({ playlistId: pl.id, title: name, matched: matches.length, total: entries.length, at: new Date().toISOString() });
      setNote({ text: `"${name}" imported: ${summaryText}.` });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Import failed', error: true });
    } finally {
      setProgress(null);
    }
  };

  const pct = progress && progress.total ? progress.done / progress.total : 0;
  const isSpotify = source === 'Spotify';
  const isFile = source === 'From file';
  const fileMatched = fileResults?.results.filter((r) => r?.track) ?? [];
  const fileUnmatched = fileResults?.results.filter((r) => r && !r.track) ?? [];

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'dots', mesh: 'coral' }} contentStyle={{ flexGrow: 1 }}>
      <ScreenHeader title="Import" />

      <View style={{ gap: 8 }}>
        <T size={26} weight={700} tracking={-0.5} lineHeight={30} accessibilityRole="header">
          Bring your music over
        </T>
        <T size={16} color={colors.textSecondary} lineHeight={23}>
          Pick where your playlists live now.
        </T>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {sources.map((s) => {
          const on = s === source;
          const content = (
            <>
              <Icon name="music" size={26} color={colors.accentLight} />
              <T size={14} weight={600}>
                {s}
              </T>
            </>
          );
          return (
            <Tap
              key={s}
              onPress={() => (setSource(s), setNote(null))}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={s}
              style={{ width: '47%', flexGrow: 1 }}
            >
              {on ? (
                <View style={{ height: 96, borderRadius: 36, borderWidth: 2, borderColor: colors.accentLight, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  {content}
                </View>
              ) : (
                <Glass radius={36} style={{ height: 96, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  {content}
                </Glass>
              )}
            </Tap>
          );
        })}
      </View>

      <Glass padding={16}>
        <View style={{ gap: 10 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={15} weight={600} numberOfLines={1} style={{ flex: 1 }}>
              {progress ? `Importing ${progress.name}` : `Importing from ${source}`}
            </T>
            <T mono size={13}>
              {progress ? `${progress.done} of ${progress.total}` : '0 of 0'}
            </T>
          </Row>
          <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }} style={{ height: 10, borderRadius: 5, backgroundColor: colors.track, overflow: 'hidden' }}>
            <Gradient colors={[colors.accent, colors.amber]} angle={90} style={{ width: `${Math.round(pct * 100)}%`, height: 10 }} />
          </View>
          <T size={13} color={colors.textSecondary} lineHeight={18}>
            {isFile
              ? progress
                ? progress.phase === 'reading'
                  ? 'Reading your file…'
                  : progress.phase === 'matching'
                    ? `Matching songs against our catalogue… ${fileMatched.length} matched, ${fileUnmatched.length} not found`
                    : 'Saving your new playlist…'
                : FILE_HINT
              : !isSpotify
              ? NEEDS[source]
              : progress
                ? progress.phase === 'reading'
                  ? 'Reading your Spotify playlist…'
                  : progress.phase === 'matching'
                    ? 'Matching songs against our catalogue…'
                    : 'Saving your new playlist…'
                : !spotifyConfigured()
                  ? SPOTIFY_SETUP_MESSAGE
                  : connected
                    ? `Connected as ${connected}. Pick a playlist below.`
                    : 'Connect Spotify to see your playlists. We match each song against our catalogue.'}
          </T>
          {progress ? (
            <Row style={{ justifyContent: 'flex-end' }}>
              <LinkText label="Cancel" onPress={() => (cancelRef.current = true)} />
            </Row>
          ) : null}
        </View>
      </Glass>

      {note ? <Toast icon={note.error ? 'info' : 'check'} iconColor={note.error ? colors.error : colors.success} message={note.text} /> : null}

      {isSpotify && connected ? (
        <>
          <SectionHeader title="Your Spotify playlists" action="Disconnect" onAction={() => void disconnect()} />
          {listError ? (
            <Toast icon="info" iconColor={colors.error} message={listError} action="Retry" onAction={() => void loadPlaylists()} />
          ) : !playlists ? (
            <Loading label="Loading playlists" />
          ) : playlists.length === 0 ? (
            <EmptyState icon="music" title="No playlists found" body="This Spotify account has no playlists we can read." />
          ) : (
            <Glass padding={4}>
              {playlists.map((p, i) => (
                <ListRow
                  key={p.id}
                  title={p.name}
                  subtitle={`${p.total} songs`}
                  divider={i > 0}
                  leading={<Cover uri={p.image ?? null} id={p.id} size={48} radius={12} />}
                  onPress={progress ? undefined : () => void importPlaylist(p)}
                  right={progress?.name === p.name ? <ActivityIndicator color={colors.accent} /> : <Icon name="download" size={20} color={colors.textSecondary} />}
                />
              ))}
            </Glass>
          )}
        </>
      ) : null}

      {isFile && fileResults ? (
        <>
          <SectionHeader title={`${fileResults.name} · ${fileMatched.length} matched · ${fileUnmatched.length} not found`} />
          <Glass padding={4}>
            {[...fileMatched, ...fileUnmatched].slice(0, 150).map((r, i) =>
              r ? (
                <ListRow
                  key={`${r.entry.raw}-${i}`}
                  title={r.track ? r.track.title : r.entry.title}
                  subtitle={r.track ? `${r.track.artist.name} · from "${r.entry.artist ? `${r.entry.artist} - ` : ''}${r.entry.title}"` : `Not in our catalogue${r.entry.artist ? ` · ${r.entry.artist}` : ''}`}
                  divider={i > 0}
                  leading={r.track ? <Cover artwork={r.track.artwork} id={r.track.id} size={40} radius={10} /> : undefined}
                  icon={r.track ? undefined : 'info'}
                  right={<Icon name={r.track ? 'check' : 'close'} size={18} color={r.track ? colors.success : colors.textSecondary} />}
                />
              ) : null,
            )}
          </Glass>
          {fileMatched.length + fileUnmatched.length > 150 ? (
            <T size={12} color={colors.textSecondary}>
              {`Showing 150 of ${fileMatched.length + fileUnmatched.length} songs.`}
            </T>
          ) : null}
        </>
      ) : null}

      <SectionHeader title="Imported" />
      {history.length ? (
        <Glass padding={4}>
          {history.map((h, i) => (
            <ListRow
              key={`${h.playlistId}-${h.at}`}
              title={h.title}
              subtitle={`${h.matched} of ${h.total} matched · ${new Date(h.at).toLocaleDateString()}`}
              icon="music"
              divider={i > 0}
              href={{ pathname: '/playlist', params: { id: h.playlistId } }}
            />
          ))}
        </Glass>
      ) : (
        <EmptyState icon="download" title="Nothing imported yet" body="Imported playlists will be matched against our catalogue and land in your library." />
      )}

      <Spacer />

      {isSpotify ? (
        connected ? null : (
          <Button label={connecting ? 'Connecting…' : spotifyConfigured() ? 'Connect Spotify' : 'Spotify needs app setup'} variant={connecting ? 'disabled' : 'primary'} onPress={() => void connect()} />
        )
      ) : isFile ? (
        <Button label={progress ? 'Importing…' : 'Choose a file'} variant={progress ? 'disabled' : 'primary'} onPress={() => void importFile()} />
      ) : (
        <Button label={`Connect ${source}`} variant="disabled" onPress={() => setNote({ text: NEEDS[source] })} />
      )}
    </Screen>
  );
}

