import { useAudioPlayer, useAudioPlayerStatus, type AudioPlayer } from 'expo-audio';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, Share, View } from 'react-native';

import {
  Art,
  Button,
  Chip,
  Cover,
  EmptyState,
  ErrorState,
  Glass,
  Icon,
  IconButton,
  Loading,
  OutlineTag,
  ProgressBar,
  Row,
  Screen,
  ScreenHeader,
  Segmented,
  T,
  Tap,
  TextField,
  Toggle,
  useAsync,
  useDebounced,
} from '../components';
import { catalog, formatDuration, type CatalogTrack } from '../lib/catalog';
import { downloads } from '../lib/downloads';
import { importFiles, isLocalTrack, localMusic, useImported } from '../lib/local-music';
import {
  checkRights,
  searchRemixable,
  semitonesFor,
  SLOW_RATES,
  startStems,
  stemLabel,
  stemsStatus,
  toolById,
  type Rights,
  type Stem,
  type StemMode,
  type StudioTool,
} from '../lib/studio';
import { usePlayerPick } from '../state/player';
import { colors, radius } from '../theme/tokens';

/* ------------------------------------------------------------------ preview player */

/**
 * Native setters routed through plain functions (keeps the React Compiler immutability lint happy).
 * Pitch correction OFF = varispeed: slowing down also lowers the pitch, the "slowed" sound.
 */
const applyRate = (p: AudioPlayer, rate: number, pitch: boolean) => {
  p.shouldCorrectPitch = pitch;
  p.setPlaybackRate(rate);
};

function uriFor(t: CatalogTrack): string | null {
  if (isLocalTrack(t)) {
    const m: CatalogTrack & { localUri?: string } = t;
    return localMusic.uriFor(t.id) ?? m.localUri ?? null;
  }
  return downloads.localUri(t.id) ?? catalog.streamUrl(t.id);
}

/**
 * A studio-only player, separate from the app player (whose native playlist can't turn pitch
 * correction off). Starting a preview pauses the main player.
 */
function usePreview(rate: number) {
  const player = useAudioPlayer(undefined, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const main = usePlayerPick('playing');
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-apply the rate whenever a source finishes loading (a new item starts at 1x on some platforms).
  useEffect(() => {
    if (status.isLoaded) applyRate(player, rate, false);
  }, [player, rate, status.isLoaded]);

  const toggle = useCallback(
    (key: string, uri: string | null) => {
      setError(null);
      if (!uri) {
        setError('This file is no longer on your device.');
        return;
      }
      if (!isLocalUri(uri) && !downloads.isOnline()) {
        setError('You are offline. Pick a downloaded song or one of your own files.');
        return;
      }
      if (key === current) {
        if (status.playing) player.pause();
        else {
          if (status.duration > 0 && status.currentTime >= status.duration - 0.5) void player.seekTo(0);
          player.play();
        }
        return;
      }
      try {
        if (main.playing) main.pause();
        player.replace({ uri });
        applyRate(player, rate, false);
        player.play();
        setCurrent(key);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not play this audio.');
      }
    },
    [current, main, player, rate, status.playing, status.duration, status.currentTime],
  );

  const stop = useCallback(() => {
    player.pause();
    setCurrent(null);
  }, [player]);

  return { status, current, error, toggle, stop };
}

const isLocalUri = (uri: string) => uri.startsWith('file:') || uri.startsWith('content:') || uri.startsWith('/');

/* ------------------------------------------------------------------ shared bits */

function Card({ children, gap = 12 }: { children: ReactNode; gap?: number }) {
  return (
    <Glass radius={radius.card} padding={16}>
      <View style={{ gap }}>{children}</View>
    </Glass>
  );
}

function PickRow({ track, selected, onPress, note }: { track: CatalogTrack; selected?: boolean; onPress: () => void; note?: string }) {
  return (
    <Tap
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      accessibilityLabel={`${track.title} by ${track.artist.name}${note ? `. ${note}` : ''}`}
      style={{ minHeight: 60 }}
    >
      <Row style={{ minHeight: 60 }}>
        <Cover artwork={track.artwork} id={track.id} size={48} radius={radius.sm} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T variant="bodyStrong" numberOfLines={1} color={selected ? colors.accentLight : colors.text}>
            {track.title}
          </T>
          <T variant="small" color={colors.textSecondary} numberOfLines={1}>
            {note ?? `${track.artist.name}${track.duration ? ` · ${formatDuration(track.duration)}` : ''}`}
          </T>
        </View>
        {selected ? <Icon name="check" size={20} color={colors.accentLight} /> : null}
      </Row>
    </Tap>
  );
}

/** The user's imported files, with an Import button. */
function OwnFiles({ selectedId, onPick }: { selectedId?: string; onPick: (t: CatalogTrack) => void }) {
  const items = useImported();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const doImport = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await importFiles();
      if (!r.cancelled) setMsg(r.failed ? `Added ${r.added}, ${r.failed} couldn’t be imported.` : `Added ${r.added} ${r.added === 1 ? 'file' : 'files'}.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  };

  if (Platform.OS === 'web') return <EmptyState icon="music" title="Not on the web" body="Your own files can only be used in the mobile app." />;

  return (
    <View style={{ gap: 8 }}>
      {items === null ? <Loading label="Loading your files" height={80} /> : null}
      {items?.length === 0 ? (
        <T size={14} color={colors.textSecondary} lineHeight={20}>
          No imported files yet. Import an audio file you made or own.
        </T>
      ) : null}
      {items?.map(({ track }) => (
        <PickRow key={track.id} track={track} selected={track.id === selectedId} onPress={() => onPick(track)} note="Your file" />
      ))}
      <Button label={busy ? 'Importing…' : 'Import audio file'} icon="plus" variant={busy ? 'disabled' : 'glass'} height={44} onPress={() => void doImport()} />
      {msg ? (
        <T size={13} color={colors.textSecondary} accessibilityLiveRegion="polite">
          {msg}
        </T>
      ) : null}
    </View>
  );
}

function SelectedTrack({ track, right }: { track: CatalogTrack; right?: ReactNode }) {
  return (
    <Row>
      <Cover artwork={track.artwork} id={track.id} size={64} radius={radius.sm} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="bodyStrong" numberOfLines={1}>
          {track.title}
        </T>
        <T variant="small" color={colors.textSecondary} numberOfLines={1}>
          {track.artist.name}
        </T>
      </View>
      {right}
    </Row>
  );
}

/* ------------------------------------------------------------------ slowed */

function CatalogSearch({ selectedId, onPick }: { selectedId?: string; onPick: (t: CatalogTrack) => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 350);
  const res = useAsync(() => catalog.searchTracks(dq, { limit: 15 }), [dq], 'app/create-tool:226');
  return (
    <View style={{ gap: 8 }}>
      <TextField label="Search songs" hideLabel placeholder="Search songs" value={q} onChangeText={setQ} icon="search" returnKeyType="search" autoCorrect={false} />
      {!dq.trim() ? null : res.loading ? (
        <Loading label="Searching" height={80} />
      ) : res.error ? (
        <ErrorState message={`Search failed. ${res.error}`} onRetry={res.reload} />
      ) : res.data?.length ? (
        res.data.map((t) => <PickRow key={t.id} track={t} selected={t.id === selectedId} onPress={() => onPick(t)} />)
      ) : (
        <T size={14} color={colors.textSecondary}>
          No songs found.
        </T>
      )}
    </View>
  );
}

function SlowedTool() {
  const { track: nowPlaying } = usePlayerPick('track');
  const [source, setSource] = useState(nowPlaying ? 0 : 1);
  const [picked, setPicked] = useState<CatalogTrack | null>(nowPlaying);
  const [rate, setRate] = useState<number>(0.85);
  const preview = usePreview(rate);
  const { status } = preview;
  const key = picked ? `slowed:${picked.id}` : null;
  const active = !!key && preview.current === key;
  const playing = active && status.playing;
  const loading = active && (!status.isLoaded || status.isBuffering);
  const progress = active && status.duration > 0 ? Math.min(1, status.currentTime / status.duration) : 0;

  const pick = (t: CatalogTrack) => {
    if (preview.current) preview.stop();
    setPicked(t);
  };

  return (
    <>
      <Card>
        <T variant="section" accessibilityRole="header">
          1. Pick a song
        </T>
        <Segmented options={['Now playing', 'Search', 'Your files']} initial={source} onChange={setSource} />
        {source === 0 ? (
          nowPlaying ? (
            <PickRow track={nowPlaying} selected={picked?.id === nowPlaying.id} onPress={() => pick(nowPlaying)} />
          ) : (
            <T size={14} color={colors.textSecondary}>
              Nothing is playing right now.
            </T>
          )
        ) : source === 1 ? (
          <CatalogSearch selectedId={picked?.id} onPick={pick} />
        ) : (
          <OwnFiles selectedId={picked?.id} onPick={pick} />
        )}
      </Card>

      <Card>
        <T variant="section" accessibilityRole="header">
          2. How slow
        </T>
        <Row gap={8} style={{ flexWrap: 'wrap' }}>
          {SLOW_RATES.map((r) => (
            <Chip key={r} label={`${r}x`} active={rate === r} onPress={() => setRate(r)} />
          ))}
        </Row>
        <T size={13} color={colors.textSecondary}>
          {`Tempo ${Math.round(rate * 100)}% · pitch ${semitonesFor(rate)} semitones`}
        </T>
      </Card>

      <Card>
        <T variant="section" accessibilityRole="header">
          3. Listen
        </T>
        {picked ? (
          <>
            <SelectedTrack
              track={picked}
              right={
                <IconButton
                  icon={playing ? 'pause' : 'play'}
                  filled
                  label={playing ? 'Pause slowed preview' : 'Play slowed preview'}
                  bg={colors.accent}
                  color={colors.onAccent}
                  size={52}
                  onPress={() => key && preview.toggle(key, uriFor(picked))}
                />
              }
            />
            <ProgressBar value={progress} />
            <Row style={{ justifyContent: 'space-between' }}>
              <T mono size={12} color={colors.textSecondary}>
                {active ? formatDuration(status.currentTime) : '0:00'}
              </T>
              <T size={12} color={colors.textSecondary}>
                {loading ? 'Loading…' : playing ? `Playing at ${rate}x` : ' '}
              </T>
              <T mono size={12} color={colors.textSecondary}>
                {active && status.duration > 0 ? formatDuration(status.duration) : picked.duration ? formatDuration(picked.duration) : '--:--'}
              </T>
            </Row>
            {preview.error ? (
              <T size={13} color={colors.error} accessibilityLiveRegion="polite">
                {preview.error}
              </T>
            ) : null}
            <T size={12} color={colors.textTertiary} lineHeight={17}>
              The preview plays here in the studio and pauses your main player. Nothing is saved or uploaded.
            </T>
          </>
        ) : (
          <T size={14} color={colors.textSecondary}>
            Pick a song first.
          </T>
        )}
      </Card>

      <Unavailable title="Reverb" body="Not available in this version. Adding echo needs an audio effects engine that Zoyra doesn’t include yet, so you’ll hear the slowed track without reverb." />
    </>
  );
}

function Unavailable({ title, body }: { title: string; body: string }) {
  return (
    <View accessible accessibilityLabel={`${title}. ${body}`}>
      <Glass radius={radius.card} padding={16} style={{ opacity: 0.75 }}>
        <View style={{ gap: 6 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T variant="bodyStrong">{title}</T>
            <OutlineTag label="Not available" color={colors.textSecondary} />
          </Row>
          <T size={13} color={colors.textSecondary} lineHeight={18}>
            {body}
          </T>
        </View>
      </Glass>
    </View>
  );
}

/* ------------------------------------------------------------------ stems */

type Job =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'working'; jobId: string; label: string }
  | { state: 'done'; stems: Stem[] }
  | { state: 'error'; message: string; setup?: boolean };

const POLL_MS = 4000;
const POLL_LIMIT = 150; // ~10 minutes

function RemixableSearch({ selectedId, onPick }: { selectedId?: string; onPick: (t: CatalogTrack, basis: string) => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 350);
  const res = useAsync(() => searchRemixable(dq), [dq], 'app/create-tool:385');
  return (
    <View style={{ gap: 8 }}>
      <TextField label="Search remixable tracks" hideLabel placeholder="Search remixable tracks" value={q} onChangeText={setQ} icon="search" returnKeyType="search" autoCorrect={false} />
      <T size={12} color={colors.textTertiary} lineHeight={17}>
        Only shows tracks the artist made free to download, or released under a Creative Commons licence that allows remixes.
      </T>
      {!dq.trim() ? null : res.loading ? (
        <Loading label="Searching" height={80} />
      ) : res.error ? (
        <ErrorState message={`Search failed. ${res.error}`} onRetry={res.reload} />
      ) : res.data?.length ? (
        res.data.map(({ track, basis }) => <PickRow key={track.id} track={track} selected={track.id === selectedId} onPress={() => onPick(track, basis)} note={`${track.artist.name} · ${basis}`} />)
      ) : (
        <T size={14} color={colors.textSecondary}>
          No remixable tracks found for that search.
        </T>
      )}
    </View>
  );
}

/** Check whether the song that's playing may be split, and say why not when it can't. */
function NowPlayingCheck({ selectedId, onPick }: { selectedId?: string; onPick: (t: CatalogTrack, basis: string) => void }) {
  const { track } = usePlayerPick('track');
  const [check, setCheck] = useState<{ id: string; state: 'checking' } | { id: string; state: 'done'; rights: Rights } | { id: string; state: 'error'; message: string } | null>(null);
  if (!track) return null;
  const mine = check?.id === track.id ? check : null;

  const run = async () => {
    setCheck({ id: track.id, state: 'checking' });
    try {
      const rights = await checkRights(track);
      setCheck({ id: track.id, state: 'done', rights });
      if (rights.ok) onPick(track, rights.basis);
    } catch (e) {
      setCheck({ id: track.id, state: 'error', message: e instanceof Error ? e.message : 'Check failed' });
    }
  };

  return (
    <View style={{ gap: 6 }}>
      <Row>
        <Cover artwork={track.artwork} id={track.id} size={40} radius={radius.xs} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={12} color={colors.textSecondary}>
            Now playing
          </T>
          <T size={14} weight={600} numberOfLines={1} color={track.id === selectedId ? colors.accentLight : colors.text}>
            {track.title}
          </T>
        </View>
        <Button label={mine?.state === 'checking' ? 'Checking…' : 'Use this'} variant={mine?.state === 'checking' ? 'disabled' : 'glass'} height={40} onPress={() => void run()} />
      </Row>
      {mine?.state === 'done' && !mine.rights.ok ? (
        <T size={13} color={colors.warning} lineHeight={18} accessibilityLiveRegion="polite">
          {`Can’t split this one. ${mine.rights.reason} Zoyra only separates music the artist allows, or your own files.`}
        </T>
      ) : null}
      {mine?.state === 'error' ? (
        <T size={13} color={colors.error} accessibilityLiveRegion="polite">
          {`Couldn’t check this track. ${mine.message}`}
        </T>
      ) : null}
    </View>
  );
}

function StemsTool({ tool }: { tool: StudioTool }) {
  const mode: StemMode = tool.id === 'vocals' ? 'vocals' : 'stems';
  const [source, setSource] = useState(0);
  const [picked, setPicked] = useState<{ track: CatalogTrack; basis: string } | null>(null);
  const [owns, setOwns] = useState(false);
  const [job, setJob] = useState<Job>({ state: 'idle' });
  const preview = usePreview(1);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const own = !!picked && isLocalTrack(picked.track);
  const busy = job.state === 'starting' || job.state === 'working';
  const canStart = !!picked && (!own || owns) && !busy;

  const pick = (track: CatalogTrack, basis: string) => {
    if (busy) return;
    if (preview.current) preview.stop();
    setPicked({ track, basis });
    setOwns(false);
    setJob({ state: 'idle' });
  };

  const poll = (jobId: string, n: number) => {
    timer.current = setTimeout(() => {
      void (async () => {
        const r = await stemsStatus(jobId);
        if (!alive.current) return;
        if (!r.ok) return setJob({ state: 'error', message: r.message, setup: r.reason === 'not_configured' });
        if (r.data.status === 'done') return setJob(r.data.stems.length ? { state: 'done', stems: r.data.stems } : { state: 'error', message: 'The service returned no stems.' });
        if (r.data.status === 'failed') return setJob({ state: 'error', message: r.data.error ?? 'Separation failed.' });
        if (n >= POLL_LIMIT) return setJob({ state: 'error', message: 'This is taking too long. Try again later.' });
        setJob({ state: 'working', jobId, label: r.data.status === 'queued' ? 'Waiting in line…' : 'Separating…' });
        poll(jobId, n + 1);
      })();
    }, POLL_MS);
  };

  const start = async () => {
    if (!picked) return;
    setJob({ state: 'starting' });
    const r = await startStems(picked.track, mode, owns);
    if (!alive.current) return;
    if (!r.ok) return setJob({ state: 'error', message: r.message, setup: r.reason === 'not_configured' });
    const d = r.data;
    if (d.status === 'done') return setJob(d.stems.length ? { state: 'done', stems: d.stems } : { state: 'error', message: 'The service returned no stems.' });
    if (d.status === 'failed' || !d.jobId) return setJob({ state: 'error', message: d.error ?? 'Separation failed.' });
    setJob({ state: 'working', jobId: d.jobId, label: 'Uploading done. Separating…' });
    poll(d.jobId, 0);
  };

  const shareStem = async (s: Stem) => {
    try {
      await Share.share({ message: s.url, url: s.url });
    } catch {
      // share sheet dismissed
    }
  };

  return (
    <>
      <Card>
        <T variant="section" accessibilityRole="header">
          1. Pick audio you’re allowed to split
        </T>
        <Segmented options={['Your files', 'Remixable on Audius']} initial={source} onChange={setSource} />
        {source === 0 ? <OwnFiles selectedId={picked?.track.id} onPick={(t) => pick(t, 'Your own file')} /> : <RemixableSearch selectedId={picked?.track.id} onPick={pick} />}
        <NowPlayingCheck selectedId={picked?.track.id} onPick={pick} />
      </Card>

      <Card>
        <T variant="section" accessibilityRole="header">
          {mode === 'vocals' ? '2. Split vocals' : '2. Split into stems'}
        </T>
        {picked ? (
          <>
            <SelectedTrack track={picked.track} />
            <Row gap={8}>
              <Icon name="shield" size={18} color={colors.success} />
              <T size={13} color={colors.textSecondary} style={{ flex: 1 }}>
                {picked.basis}
              </T>
            </Row>
            {own ? (
              <Row>
                <T size={14} style={{ flex: 1 }} lineHeight={20}>
                  I made this recording or have the rights to edit it.
                </T>
                <Toggle value={owns} onChange={setOwns} label="I made this recording or have the rights to edit it" />
              </Row>
            ) : null}
            <T size={13} color={colors.textSecondary} lineHeight={18}>
              {mode === 'vocals' ? 'You’ll get two layers: vocals and instrumental.' : 'You’ll get four layers: vocals, drums, bass and melody.'} The audio is sent to our stem separation service for processing.
            </T>
            <Button
              label={job.state === 'starting' ? (own ? 'Uploading…' : 'Starting…') : job.state === 'working' ? 'Working…' : mode === 'vocals' ? 'Remove vocals' : 'Split stems'}
              icon="sliders"
              variant={canStart ? 'primary' : 'disabled'}
              onPress={() => void start()}
            />
          </>
        ) : (
          <T size={14} color={colors.textSecondary}>
            Pick a track first.
          </T>
        )}
        {job.state === 'working' || job.state === 'starting' ? <Loading label={job.state === 'working' ? job.label : 'Sending audio'} height={72} /> : null}
        {job.state === 'error' ? (
          <View style={{ gap: 4 }} accessibilityLiveRegion="polite">
            <T size={14} weight={600} color={job.setup ? colors.warning : colors.error}>
              {job.setup ? 'Stem separation isn’t set up yet' : 'Couldn’t split this track'}
            </T>
            <T size={13} color={colors.textSecondary} lineHeight={18}>
              {job.setup ? 'This feature needs a stem separation service on the server. Nothing was processed.' : job.message}
            </T>
          </View>
        ) : null}
      </Card>

      {job.state === 'done' ? (
        <Card>
          <T variant="section" accessibilityRole="header">
            Your layers
          </T>
          {job.stems.map((s) => {
            const key = `stem:${s.url}`;
            const on = preview.current === key && preview.status.playing;
            const label = stemLabel(s.name);
            return (
              <Row key={s.url}>
                <Art art={tool.art} size={44} radius={14} style={{ alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={label === 'Vocals' ? 'mic' : 'music'} size={20} color={colors.white} strokeWidth={1.6} />
                </Art>
                <T variant="bodyStrong" style={{ flex: 1 }}>
                  {label}
                </T>
                <IconButton icon="share" label={`Share ${label} link`} color={colors.textSecondary} onPress={() => void shareStem(s)} />
                <IconButton icon={on ? 'pause' : 'play'} filled label={on ? `Pause ${label}` : `Play ${label}`} bg={colors.accent} color={colors.onAccent} onPress={() => preview.toggle(key, s.url)} />
              </Row>
            );
          })}
          {preview.error ? (
            <T size={13} color={colors.error}>
              {preview.error}
            </T>
          ) : null}
          <T size={12} color={colors.textTertiary} lineHeight={17}>
            Links come from the separation service and may expire. Respect the artist’s licence when you share.
          </T>
        </Card>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ screen */

export default function CreateTool() {
  const { tool: id } = useLocalSearchParams<{ tool?: string }>();
  const tool = toolById(id);

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'none', orbs: true }}>
      <ScreenHeader title={tool?.title ?? 'Create'} />
      {!tool ? (
        <EmptyState icon="search" title="Tool not found" body="This studio tool doesn’t exist." action="Back to Create" href="/create" />
      ) : tool.status === 'unavailable' ? (
        <Unavailable title={tool.title} body={tool.note ?? 'Not available in this version.'} />
      ) : (
        <>
          <T variant="display" accessibilityRole="header">
            {tool.title}
          </T>
          <T size={14} weight={300} color={colors.textSecondary} lineHeight={20}>
            {tool.note ?? tool.blurb}
          </T>
          {tool.id === 'slowed' ? <SlowedTool /> : <StemsTool tool={tool} />}
        </>
      )}
    </Screen>
  );
}
