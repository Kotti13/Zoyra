import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Art, ChipRow, MiniPlayer, Row, Screen, ScreenHeader, SectionHeader, T, Tap, Toast } from '../components';
import { catalog } from '../lib/catalog';
import { usePlayerPick } from '../state/player';
import { colors, type ArtName } from '../theme/tokens';

/** `mood` is a MOOD_MAP key (passed to /playlist?mix=). */
type Board = { label: string; mood: string; art: ArtName; height: number };

/** 2-column grid rows; tiles keep their own height and align to the row top (CSS grid behaviour). */
const rows: Board[][] = [
  [
    { label: 'Chill', mood: 'Chill', art: 'amber', height: 150 },
    { label: 'Focus', mood: 'Focus', art: 'blue', height: 120 },
  ],
  [
    { label: 'Workout', mood: 'Workout', art: 'rose', height: 120 },
    { label: 'Sleep', mood: 'Sleep', art: 'coral', height: 150 },
  ],
  [
    { label: 'Happy', mood: 'Happy', art: 'amber', height: 120 },
    { label: 'Romance', mood: 'Romantic', art: 'rose', height: 120 },
  ],
  [
    { label: 'Party', mood: 'Party', art: 'coral', height: 150 },
    { label: 'Sad', mood: 'Sad', art: 'blue', height: 120 },
  ],
];

const decades = ['60s', '70s', '80s', '90s', '2000s', '2010s', '2020s'];

export default function MoodBoards() {
  const { playTracks } = usePlayerPick();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 3200);
    return () => clearTimeout(id);
  }, [note]);

  /** Decades: catalogue search for the decade keyword (the catalogue has no era metadata). */
  const playDecade = async (d: string) => {
    setBusy(d);
    try {
      const list = await catalog.searchTracks(`${d} music`, { limit: 30 });
      const fallback = list.length ? list : await catalog.searchTracks(d, { limit: 30 });
      if (!fallback.length) setNote(`No ${d} tracks found right now.`);
      else playTracks(fallback, 0, `${d} mix`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not load that decade');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen top={4} bottom={12} gap={16} backdrop={{ pattern: 'dots', mesh: 'amberRose' }} footer={<MiniPlayer />}>
      <ScreenHeader title="Explore" />

      <View style={{ gap: 8 }}>
        <T size={26} weight={700} tracking={-0.5} lineHeight={30} accessibilityRole="header">
          How are you feeling?
        </T>
        <T size={16} lineHeight={23} color={colors.textSecondary}>
          Pick a mood board.
        </T>
      </View>

      <View style={{ gap: 12 }}>
        {rows.map((row, i) => (
          <Row key={i} gap={12} align="flex-start">
            {row.map((b) => (
              <Tap key={b.label} accessibilityLabel={`${b.label} mood board`} onPress={() => router.push({ pathname: '/playlist', params: { mix: b.mood, title: `${b.label} mix` } })} style={{ flex: 1 }}>
                <Art art={b.art} height={b.height} radius={32} sticker style={{ width: '100%', padding: 16, justifyContent: 'flex-end' }}>
                  <T size={20} weight={700} color={colors.white}>
                    {b.label}
                  </T>
                </Art>
              </Tap>
            ))}
          </Row>
        ))}
      </View>

      <SectionHeader title="Decades" />
      {note ? <Toast icon="info" iconColor={colors.amber} message={note} /> : null}
      <ChipRow wrap options={decades} initial={-1} onChange={(i) => void playDecade(decades[i])} />
      {busy ? (
        <T size={13} color={colors.textSecondary}>
          Finding {busy} tracks…
        </T>
      ) : null}
    </Screen>
  );
}
