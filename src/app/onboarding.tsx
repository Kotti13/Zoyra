import { router } from 'expo-router';
import { useState } from 'react';
import { View, useWindowDimensions } from 'react-native';

import { Button, LinkText, Row, Screen, T } from '../components';
import { CategoryTile } from '../components/CategoryTile';
import { GENRES } from '../lib/catalog';
import { permissionsPending } from '../lib/permissions';
import { useAuth } from '../state/auth';
import { colors, tile } from '../theme/tokens';

type CatalogGenre = (typeof GENRES)[number];
/** `q`: what to search for the tile's picture (the top song of that kind of music). */
type Genre = { t: string; bg: string; border: string; g: CatalogGenre; q: string };

/** Selected-state fill / border per genre (unselected tiles are bgTertiary / border); `g` is the catalogue genre the tile tunes the feed to. */
const genres: Genre[] = [
  { t: 'Pop', g: 'Pop', bg: tile.rose, border: colors.like, q: 'top pop songs' },
  { t: 'Tamil Film', g: 'World', bg: tile.coral, border: colors.accentLight, q: 'top Tamil film songs' },
  { t: 'Hindi', g: 'World', bg: tile.gold, border: colors.amber, q: 'top Hindi songs' },
  { t: 'Indie', g: 'Alternative', bg: tile.bronze, border: colors.amber, q: 'top indie songs' },
  { t: 'Rock', g: 'Rock', bg: tile.coral, border: colors.accentLight, q: 'top rock songs' },
  { t: 'Hip-hop', g: 'Hip-Hop/Rap', bg: tile.blue, border: colors.info, q: 'top hip hop songs' },
  { t: 'Lo-fi', g: 'Lo-Fi', bg: tile.navy, border: colors.info, q: 'lofi beats' },
  { t: 'K-pop', g: 'Pop', bg: tile.rose, border: colors.like, q: 'top K-pop songs' },
  { t: 'Classical', g: 'Classical', bg: tile.green, border: colors.success, q: 'classical music' },
  { t: 'Electronic', g: 'Electronic', bg: tile.blue, border: colors.info, q: 'top electronic dance songs' },
  { t: 'Jazz', g: 'Jazz', bg: tile.bronze, border: colors.amber, q: 'jazz classics' },
  { t: 'Devotional', g: 'World', bg: tile.gold, border: colors.amber, q: 'top devotional songs' },
];

export default function Onboarding() {
  const { settings, updateSettings } = useAuth();
  const { width: winW } = useWindowDimensions();
  const tileW = Math.floor((winW - 32 - 20) / 3); // three across
  // Re-entering onboarding: preselect the first tile for each saved catalogue genre.
  const [selected, setSelected] = useState<string[]>(() => {
    const saved = new Set(settings?.genres ?? []);
    const seen = new Set<string>();
    return genres.filter((x) => saved.has(x.g) && !seen.has(x.g) && (seen.add(x.g), true)).map((x) => x.t);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const toggle = (t: string) => setSelected((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));

  const save = async () => {
    if (!selected.length || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const mapped = [...new Set(genres.filter((x) => selected.includes(x.t)).map((x) => x.g))];
      await updateSettings({ genres: mapped });
      router.push('/languages');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your genres');
    } finally {
      setBusy(false);
    }
  };

  const skip = async () => {
    try {
      await updateSettings({ onboarded: true });
      // First-run permissions step (once per device), then Home.
      router.replace(permissionsPending() ? '/permissions' : '/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not skip setup');
    }
  };

  return (
    <Screen
      gap={24}
      bottom={34}
      contentStyle={{ flexGrow: 1 }}
      backdrop={{ pattern: 'dots', mesh: 'none', orbs: false }}
    >
      {/* Progress + skip */}
      <Row gap={16}>
        <Row gap={6} style={{ flex: 1 }} accessibilityLabel="Step 1 of 3">
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i === 0 ? colors.accent : colors.track }} />
          ))}
        </Row>
        <LinkText label="Skip" onPress={() => void skip()} />
      </Row>

      <View style={{ gap: 8 }}>
        <T variant="hero" lineHeight={37} accessibilityRole="header">
          What do you listen to?
        </T>
        <T size={16} lineHeight={23} color={colors.textSecondary}>
          Pick a few genres. Zoyra tunes your Home feed and daily mixes from these.
        </T>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {genres.map((g) => (
          <CategoryTile
            key={g.t}
            label={g.t}
            query={g.q}
            bg={g.bg}
            radius={22}
            width={tileW}
            height={104}
            selected={selected.includes(g.t)}
            onPress={() => toggle(g.t)}
          />
        ))}
      </View>

      <View style={{ flex: 1 }} />

      {error ? (
        <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite">
          {error}
        </T>
      ) : null}
      <Button
        label={busy ? 'Saving…' : selected.length ? 'Continue' : 'Pick at least one'}
        variant={selected.length && !busy ? 'primary' : 'disabled'}
        onPress={() => void save()}
      />
    </Screen>
  );
}
