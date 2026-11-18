import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, Cover, EmptyState, Glass, Icon, IconButton, LinkText, Overline, Row, Screen, ScreenHeader, SectionHeader, T, Tap, Toast } from '../components';
import { catalog } from '../lib/catalog';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

type Note = { message: string; error?: boolean };

export default function Queue() {
  const { track, queue, index, playing, skipTo, removeFromQueue, moveInQueue, clearUpNext, addToQueue } = usePlayerPick('track', 'queue', 'index', 'playing');
  const { createPlaylist, addToPlaylist } = useLibrary();
  const [busy, setBusy] = useState<'save' | 'similar' | null>(null);
  const [note, setNote] = useState<Note | null>(null);

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

  return (
    <Screen backdrop={{ pattern: 'lines', mesh: 'coral' }} top={4} gap={16} swipeDown="top">
      <ScreenHeader title="Queue" right={upNext.length ? <LinkText label="Clear" onPress={clearUpNext} /> : undefined} />

      <Glass padding={12}>
        <Row gap={12}>
          <Cover artwork={track.artwork} id={track.id} size={56} radius={28} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Overline>NOW PLAYING</Overline>
            <T size={16} weight={600} numberOfLines={1}>
              {track.title}
            </T>
            <T size={14} color={colors.textSecondary} numberOfLines={1}>
              {track.artist.name}
            </T>
          </View>
          <Icon name={playing ? 'speaker' : 'pause'} size={22} color={colors.accentLight} />
        </Row>
      </Glass>

      <Row style={{ justifyContent: 'space-between' }}>
        <SectionHeader title="Next up" />
        <T mono size={12} color={colors.textSecondary}>
          {`${upNext.length} ${upNext.length === 1 ? 'song' : 'songs'}`}
        </T>
      </Row>

      <View style={{ marginTop: -8 }}>
        {upNext.length === 0 ? (
          <T size={14} color={colors.textSecondary} style={{ paddingVertical: 16 }}>
            Nothing up next. Tap Add similar to keep the music going.
          </T>
        ) : (
          upNext.map(({ t, i }) => (
            <Row key={`${t.id}-${i}`} gap={4} style={{ minHeight: 64 }}>
              <Tap onPress={() => skipTo(i)} accessibilityLabel={`Play ${t.title} by ${t.artist.name}`} style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64 }}>
                <Cover artwork={t.artwork} id={t.id} size={48} radius={14} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <T size={16} weight={600} numberOfLines={1}>
                    {t.title}
                  </T>
                  <T size={14} color={colors.textSecondary} numberOfLines={1}>
                    {t.artist.name}
                  </T>
                </View>
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

      {note ? <Toast icon={note.error ? 'info' : 'check'} iconColor={note.error ? colors.accentLight : colors.success} message={note.message} /> : null}

      <Row gap={12}>
        <Button variant="glass" icon="plus" label={busy === 'save' ? 'Saving…' : 'Save as playlist'} style={{ flex: 1 }} onPress={saveAsPlaylist} />
        <Button variant="glass" icon="bolt" label={busy === 'similar' ? 'Finding…' : 'Add similar'} style={{ flex: 1 }} onPress={addSimilar} />
      </Row>
    </Screen>
  );
}
