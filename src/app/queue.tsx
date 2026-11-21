import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, Cover, isWideThumb, wideWidth, EmptyState, Glass, Icon, IconButton, Row, Screen, ScreenHeader, T, Tap, Toast, Toggle } from '../components';
import { EqBars } from '../components/art-fx';
import { LiveSeekBar, TransportControls } from '../components/PlayerControls';
import { catalog, formatDuration } from '../lib/catalog';
import { usePlayPref } from '../lib/play-prefs';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';
import { LinearGradient } from 'expo-linear-gradient';

type Note = { message: string; error?: boolean };

export default function Queue() {
  const { track, queue, index, playing, skipTo, removeFromQueue, moveInQueue, clearUpNext, addToQueue } = usePlayerPick('track', 'queue', 'index', 'playing');
  const { createPlaylist, addToPlaylist } = useLibrary();
  const [busy, setBusy] = useState<'save' | 'similar' | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [autoSimilar, setAutoSimilar] = usePlayPref('playback.autoplaySimilar');

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 2600);
    return () => clearTimeout(id);
  }, [note]);

  if (!track) {
    return (
      <Screen backdrop={{ pattern: 'lines', mesh: 'coral' }} top={4} gap={16} swipeDown="top">
        <ScreenHeader title="Queue" />
        <EmptyState icon="music" title="Your queue is empty" body="Play a song, album or playlist and it will show up here." action="Go to Home" href="/" />
      </Screen>
    );
  }

  const upNext = queue.map((t, i) => ({ t, i })).slice(index + 1);

  const saveAsPlaylist = async () => {
    if (busy) return;
    setBusy('save');
    try {
      const date = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const p = await createPlaylist({ title: `Queue · ${date}`, description: `Saved from your queue, starting with ${track.title}`, visibility: 'private' });
      await addToPlaylist(p.id, queue.slice(index));
      router.push({ pathname: '/playlist', params: { id: p.id } });
    } catch (e) {
      setNote({ message: e instanceof Error ? e.message : 'Could not save the playlist', error: true });
    } finally {
      setBusy(null);
    }
  };

  const addSimilar = async () => {
    if (busy) return;
    setBusy('similar');
    try {
      const have = new Set(queue.map((t) => t.id));
      const found = (await catalog.trending({ genre: track.genre, limit: 30 })).filter((t) => !have.has(t.id)).slice(0, 10);
      found.forEach(addToQueue);
      setNote(found.length ? { message: `Added ${found.length} similar ${found.length === 1 ? 'song' : 'songs'}` } : { message: 'No new similar songs found right now', error: true });
    } catch (e) {
      setNote({ message: e instanceof Error ? e.message : 'Could not load similar songs', error: true });
    } finally {
      setBusy(null);
    }
  };

  const left = queue.slice(index);
  const mins = Math.max(1, Math.round(left.reduce((n, t) => n + (t.duration || 0), 0) / 60));
  const sub = `${left.length} ${left.length === 1 ? 'song' : 'songs'} · ${mins} min`;

  return (
    <Screen
      backdrop={{ pattern: 'dots', mesh: 'coral', orbs: true }}
      top={4}
      gap={14}
      swipeDown="top"
      footer={
        <View style={{ paddingHorizontal: 16, gap: 10 }}>
          {/* Same controls as Now Playing: seek bar (tap or drag) and shuffle / previous / play / next / repeat */}
          <LiveSeekBar />
          <TransportControls />
          <Row gap={10}>
            <Button variant="glass" icon="plus" label={busy === 'save' ? 'Saving…' : 'Save as playlist'} height={50} style={{ flex: 1 }} onPress={saveAsPlaylist} />
            <Button icon="bolt" label={busy === 'similar' ? 'Finding…' : 'Add similar'} height={50} style={{ flex: 1 }} onPress={addSimilar} />
          </Row>
        </View>
      }
    >
      <Row gap={10} style={{ minHeight: 44 }}>
        <IconButton icon="back" label="Back" href="back" />
        <Cover artwork={track.artwork} id={track.id} size={44} radius={22} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={17} weight={700} accessibilityRole="header">
            Queue
          </T>
          <T size={12} color="#FF9AA0" numberOfLines={1}>
            {sub}
          </T>
        </View>
        {upNext.length ? (
          <Tap onPress={clearUpNext} accessibilityLabel="Clear up next" style={{ paddingHorizontal: 6, minHeight: 44, justifyContent: 'center' }}>
            <T size={14} weight={700} color="#FF7A8C">
              Clear
            </T>
          </Tap>
        ) : null}
      </Row>

      <View style={{ borderRadius: 26, overflow: 'hidden', borderWidth: 1, borderColor: withAlpha(colors.accent, 0.5) }}>
        <LinearGradient colors={[withAlpha(colors.accent, 0.34), 'rgba(20,20,20,0.6)']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ padding: 12 }}>
          <Row gap={12}>
            <Cover artwork={track.artwork} id={track.id} size={64} width={isWideThumb(track.artwork?.small) ? wideWidth(64) : 64} height={64} radius={isWideThumb(track.artwork?.small) ? 14 : 32} />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <T size={10} weight={700} tracking={1.4} color={colors.gold}>
                NOW PLAYING
              </T>
              <T size={16} weight={700} numberOfLines={1}>
                {track.title}
              </T>
              <T size={12} color="#FF9AA0" numberOfLines={1}>
                {track.artist.name}
              </T>
            </View>
            <EqBars active={playing} bars={6} height={24} barWidth={4} color={colors.accentLight} />
          </Row>
        </LinearGradient>
      </View>

      <Row style={{ justifyContent: 'space-between' }}>
        <T size={11} weight={700} tracking={1.4} color={colors.textSecondary}>
          NEXT UP
        </T>
        <T size={12} color={colors.textSecondary}>
          {upNext.length > 1 ? 'Tap the arrows to reorder' : `${upNext.length} ${upNext.length === 1 ? 'song' : 'songs'}`}
        </T>
      </Row>

      <View style={{ marginTop: -8 }}>
        {upNext.length === 0 ? (
          <T size={14} color={colors.textSecondary} style={{ paddingVertical: 16 }}>
            Nothing up next. Tap Add similar to keep the music going.
          </T>
        ) : (
          upNext.map(({ t, i }, n) => (
            <Row key={`${t.id}-${i}`} gap={4} style={{ minHeight: 68, borderTopWidth: n ? 1 : 0, borderTopColor: withAlpha(colors.white, 0.07) }}>
              <Tap onPress={() => skipTo(i)} accessibilityLabel={`Play ${t.title} by ${t.artist.name}`} style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingHorizontal: 4 }}>
                <Cover artwork={t.artwork} id={t.id} size={48} width={isWideThumb(t.artwork?.small) ? wideWidth(48) : 48} height={48} radius={isWideThumb(t.artwork?.small) ? 10 : 22} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T size={15} weight={600} numberOfLines={1}>
                    {t.title}
                  </T>
                  <T size={12} color={colors.textSecondary} numberOfLines={1}>
                    {t.artist.name}
                  </T>
                </View>
                <T mono size={12} color={colors.textSecondary}>
                  {formatDuration(t.duration)}
                </T>
              </Tap>
              <IconButton icon="close" label={`Remove ${t.title} from queue`} iconSize={20} color={colors.textSecondary} onPress={() => removeFromQueue(i)} />
              <IconButton
                icon="reorder"
                label={`Move ${t.title} up`}
                color={i - 1 > index ? colors.textSecondary : colors.textTertiary}
                onPress={() => (i - 1 > index ? moveInQueue(i, i - 1) : undefined)}
              />
            </Row>
          ))
        )}
      </View>

      <Glass radius={26} padding={4}>
        <Row gap={14} style={{ paddingVertical: 12, paddingHorizontal: 12 }}>
          <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: withAlpha(colors.white, 0.08), alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="bolt" size={20} color={colors.text} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={15} weight={600}>
              Autoplay similar
            </T>
            <T size={12} color={colors.textSecondary}>
              Keep playing when the queue ends
            </T>
          </View>
          <Toggle value={autoSimilar} onChange={setAutoSimilar} label="Autoplay similar" />
        </Row>
      </Glass>

      {note ? <Toast icon={note.error ? 'info' : 'check'} iconColor={note.error ? colors.accentLight : colors.success} message={note.message} /> : null}
    </Screen>
  );
}
