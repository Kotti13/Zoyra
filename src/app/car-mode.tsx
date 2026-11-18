import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { Cover, EmptyState, Glass, Icon, IconButton, ProgressBar, Row, Screen, Sticker, T, Tap, Toast } from '../components';
import { LyricTicker } from '../components/LyricTicker';
import { catalog } from '../lib/catalog';
import { isVoiceSearchSupported, useVoiceSearch, VOICE_NEEDS_DEV_BUILD } from '../lib/voice';
import { usePlaybackProgress, usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

/** Live progress (isolated so only this re-renders every tick). */
function Progress() {
  const { progress } = usePlaybackProgress();
  return <ProgressBar value={progress} height={10} />;
}

type Command = { kind: 'pause' } | { kind: 'resume' } | { kind: 'next' } | { kind: 'previous' } | { kind: 'play'; query: string } | { kind: 'unknown' };

/** Short spoken commands: "pause", "play", "next", "previous", "play <song or artist>". */
function parseCommand(raw: string): Command {
  const t = raw.toLowerCase().replace(/[.,!?;:"“”]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(pause|stop|stop (the )?music|be quiet|quiet)$/.test(t)) return { kind: 'pause' };
  if (/^(play|resume|continue|keep playing|play music|unpause)$/.test(t)) return { kind: 'resume' };
  if (/^(next|skip|next (song|track)|skip (this )?(song|track)?)$/.test(t)) return { kind: 'next' };
  if (/^(previous|back|go back|last (song|track)|previous (song|track))$/.test(t)) return { kind: 'previous' };
  const m = /^(?:play|put on|listen to)\s+(?:some\s+)?(.+)$/.exec(t);
  if (m && m[1].trim()) return { kind: 'play', query: m[1].replace(/\s+(please|now)$/, '').trim() };
  return { kind: 'unknown' };
}

export default function CarMode() {
  const { track, playing, toggle, next, previous, play, pause, playTracks } = usePlayerPick('track', 'playing');
  const [note, setNote] = useState<string | null>(null);
  const [heard, setHeard] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wasPlaying = useRef(false);

  const resumeIfNeeded = useCallback(() => {
    if (wasPlaying.current) play();
    wasPlaying.current = false;
  }, [play]);

  const run = useCallback(
    async (text: string) => {
      setHeard(text);
      const cmd = parseCommand(text);
      if (cmd.kind === 'pause') {
        wasPlaying.current = false;
        return setNote('Paused');
      }
      if (cmd.kind === 'resume') {
        wasPlaying.current = false;
        if (!track) return setNote('Nothing to resume. Say "play" and a song or artist.');
        play();
        return setNote('Playing');
      }
      if (cmd.kind === 'next' || cmd.kind === 'previous') {
        if (!track) return setNote('Nothing is playing.');
        (cmd.kind === 'next' ? next : previous)();
        if (wasPlaying.current) play();
        wasPlaying.current = false;
        return setNote(cmd.kind === 'next' ? 'Next song' : 'Previous song');
      }
      if (cmd.kind === 'unknown') {
        resumeIfNeeded();
        return setNote(`Didn't understand "${text}". Try "next", "pause" or "play" and a song or artist.`);
      }
      setBusy(true);
      try {
        const results = await catalog.searchTracks(cmd.query, { limit: 20 });
        if (!results.length) {
          resumeIfNeeded();
          return setNote(`No songs found for "${cmd.query}".`);
        }
        wasPlaying.current = false;
        const r = playTracks(results, 0, `Car mode · ${cmd.query}`);
        setNote(r.reason ?? `Playing ${results[0].title} by ${results[0].artist.name}`);
      } catch (e: unknown) {
        resumeIfNeeded();
        setNote(e instanceof Error ? e.message : 'Search failed');
      } finally {
        setBusy(false);
      }
    },
    [track, play, next, previous, playTracks, resumeIfNeeded],
  );

  const voice = useVoiceSearch({
    onBeforeStart: () => {
      // Pause so the recognizer hears the driver, not the music; resumed unless the command was "pause".
      wasPlaying.current = playing;
      if (playing) pause();
    },
    onPartial: setHeard,
    onFinal: (text) => void run(text),
  });
  const voiceError = voice.voice.state === 'error' ? voice.voice.message : null;

  // Listening failed (no speech, permission, …): bring the music back.
  useEffect(() => {
    if (voiceError) resumeIfNeeded();
  }, [voiceError, resumeIfNeeded]);

  const supported = isVoiceSearchSupported();
  const onMic = () => {
    if (!supported) return setNote(`${VOICE_NEEDS_DEV_BUILD.replace('Voice search', 'Voice commands')}`);
    if (voice.listening) return voice.stop();
    setNote(null);
    setHeard(null);
    voice.dismiss();
    void voice.start();
  };
  const micLabel = voice.listening ? (heard ? `“${heard}”` : 'Listening…') : busy ? 'Finding it…' : 'Say a command';

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 2600);
    return () => clearTimeout(id);
  }, [note]);

  return (
    <Screen scroll={false} top={12} bottom={34} gap={20} backdrop={{ pattern: 'grid', mesh: 'peach' }} swipeDown>
      <Row style={{ justifyContent: 'space-between' }}>
        <Sticker label="CAR MODE" rotate={-3} />
        <Tap href="back" style={{ height: 44, paddingHorizontal: 18, borderRadius: 22, backgroundColor: colors.chipGhost, justifyContent: 'center' }}>
          <T size={14} weight={600}>
            Exit
          </T>
        </Tap>
      </Row>

      {track ? (
        <View style={{ gap: 8, marginTop: 12 }}>
          <Cover
            artwork={track.artwork}
            id={track.id}
            size={200}
            radius={48}
            style={{ shadowColor: colors.shadow, shadowOpacity: 0.6, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 16 }}
          />
          <T size={36} weight={300} tracking={-1} style={{ marginTop: 12 }} accessibilityRole="header" numberOfLines={1}>
            {track.title}
          </T>
          {/* Live line from the real synced lyrics; nothing extra when the song has none. */}
          <LyricTicker key={track.id} track={track} size={24} weight={700} height={56} style={{ marginTop: 10 }} />
          <T size={22} color={colors.peach} numberOfLines={1}>
            {track.artist.name}
          </T>
        </View>
      ) : (
        <EmptyState title="Nothing playing" body="Start some music, then come back to Car mode." action="Go to Home" href="/" />
      )}

      <View style={{ flex: 1 }} />

      {track ? <Progress /> : null}

      <Row style={{ justifyContent: 'space-between' }}>
        <IconButton icon="prev" label="Previous track" size={96} iconSize={44} bg={colors.chipGhost} onPress={track ? previous : undefined} />
        <IconButton
          icon={playing ? 'pause' : 'play'}
          label={playing ? 'Pause' : 'Play'}
          size={128}
          iconSize={56}
          bg={colors.accent}
          color={colors.onAccent}
          onPress={track ? toggle : undefined}
          style={{ shadowColor: colors.shadow, shadowOpacity: 0.4, shadowRadius: 0, shadowOffset: { width: 0, height: 6 }, elevation: 6 }}
        />
        <IconButton icon="next" label="Next track" size={96} iconSize={44} bg={colors.chipGhost} onPress={track ? next : undefined} />
      </Row>

      {voiceError ? (
        <Toast icon="info" iconColor={colors.error} message={voiceError} />
      ) : note ? (
        <Toast icon="info" iconColor={colors.accentLight} message={note} />
      ) : null}

      <Tap
        style={{ height: 72, borderRadius: 36 }}
        onPress={onMic}
        accessibilityLabel={voice.listening ? 'Stop listening' : 'Say a command: pause, next, previous, or play a song or artist'}
        accessibilityState={{ busy: voice.listening || busy }}
      >
        {voice.listening ? (
          <View style={{ flex: 1, borderRadius: 36, backgroundColor: colors.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 20 }}>
            <Icon name="mic" size={30} color={colors.onAccent} />
            <T size={20} weight={700} color={colors.onAccent} numberOfLines={1} style={{ flexShrink: 1 }}>
              {micLabel}
            </T>
          </View>
        ) : (
          <Glass radius={36} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 20 }}>
            <Icon name="mic" size={30} />
            <T size={20} weight={700} numberOfLines={1} style={{ flexShrink: 1 }}>
              {supported ? micLabel : 'Voice needs the development build'}
            </T>
          </Glass>
        )}
      </Tap>
    </Screen>
  );
}
