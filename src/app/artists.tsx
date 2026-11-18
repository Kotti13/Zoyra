import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { TextInput, View } from 'react-native';

import { Button, Cover, EmptyState, ErrorState, Icon, LinkText, Loading, Row, Screen, T, Tap, useAsync, useDebounced } from '../components';
import { catalog, type Artist, type CatalogTrack } from '../lib/catalog';
import { permissionsPending } from '../lib/permissions';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { colors, fonts } from '../theme/tokens';

const MIN_PICKS = 3;

/** Lightweight artist from a track's embedded artist (full profile fetched only for picks). */
const fromTrack = (a: CatalogTrack['artist']): Artist => ({
  id: a.id,
  name: a.name,
  handle: a.handle,
  verified: a.verified,
  followers: 0,
  image: a.image ? { small: a.image } : {},
});

/** Unique artists behind the trending tracks for the user's genres (or overall). */
async function trendingArtists(genres: string[]): Promise<Artist[]> {
  const lists = await Promise.all((genres.length ? genres.slice(0, 3) : [undefined]).map((genre) => catalog.trending({ genre, limit: 40 })));
  const seen = new Set<string>();
  const out: Artist[] = [];
  // Interleave genres so each one is represented.
  const max = Math.max(...lists.map((l) => l.length));
  for (let i = 0; i < max; i++)
    for (const l of lists) {
      const t = l[i];
      if (t && !seen.has(t.artist.id)) {
        seen.add(t.artist.id);
        out.push(fromTrack(t.artist));
      }
    }
  return out.slice(0, 12);
}

/** Onboarding step indicator: `total` bars, first `done` filled. */
function Steps({ done, total }: { done: number; total: number }) {
  return (
    <Row gap={6} style={{ flex: 1 }} >
      {Array.from({ length: total }, (_, i) => (
        <View key={i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i < done ? colors.accent : colors.track }} />
      ))}
    </Row>
  );
}

function ArtistPick({ artist, on, onPress }: { artist: Artist; on: boolean; onPress: () => void }) {
  const name = artist.name;
  return (
    <Tap
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={name}
      style={{ flex: 1, alignItems: 'center', gap: 8 }}
    >
      <View style={{ width: 88, height: 88 }}>
        {on ? (
          <View
            style={{ position: 'absolute', top: -5, left: -5, width: 98, height: 98, borderRadius: 49, borderWidth: 2, borderColor: colors.accentLight }}
          />
        ) : null}
        <Cover artwork={artist.image} id={artist.id} size={88} radius={44} />
        {on ? (
          <View
            style={{
              position: 'absolute',
              right: 0,
              bottom: 0,
              width: 26,
              height: 26,
              borderRadius: 13,
              backgroundColor: colors.accentLight,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="check" size={16} color={colors.onAccent} />
          </View>
        ) : null}
      </View>
      <T size={13} weight={500} align="center" lineHeight={17} numberOfLines={2}>
        {name}
      </T>
    </Tap>
  );
}

export default function Artists() {
  const { settings, updateSettings } = useAuth();
  const { isFollowingArtist, toggleFollowArtist } = useLibrary();
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim());
  const [picked, setPicked] = useState<Map<string, Artist>>(
    () =>
      new Map(
        (settings?.favorite_artists ?? []).map((a) => [a.id, { id: a.id, name: a.name, handle: '', verified: false, followers: 0, image: a.image ? { small: a.image } : {} }]),
      ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const genresKey = (settings?.genres ?? []).join('|');
  const trending = useAsync(() => trendingArtists(settings?.genres ?? []), [genresKey]);
  const search = useAsync(() => (q ? catalog.searchArtists(q, 12) : Promise.resolve<Artist[]>([])), [q]);
  const state = q ? search : trending;
  const list = state.data ?? [];

  const rows = useMemo(() => {
    const out: Artist[][] = [];
    for (let i = 0; i < list.length; i += 3) out.push(list.slice(i, i + 3));
    return out;
  }, [list]);

  const toggle = (a: Artist) =>
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(a.id)) next.delete(a.id);
      else next.set(a.id, a);
      return next;
    });

  const enough = picked.size >= MIN_PICKS;

  const save = async () => {
    if (!enough || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const picks = [...picked.values()];
      // Track-embedded artists lack follower counts etc.; fetch the full profile before storing a follow.
      const full = await Promise.all(picks.map((a) => (a.handle && a.followers ? Promise.resolve(a) : catalog.artist(a.id).catch(() => a))));
      await updateSettings({ favorite_artists: full.map((a) => ({ id: a.id, name: a.name, image: a.image.small ?? a.image.medium })) });
      await Promise.all(full.filter((a) => !isFollowingArtist(a.id)).map((a) => toggleFollowArtist(a)));
      router.push('/languages');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your artists');
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
      backdrop={{ pattern: 'dots', mesh: 'amberRose' }}
      gap={20}
      footer={
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24, gap: 8 }}>
          {error ? (
            <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite">
              {error}
            </T>
          ) : null}
          <Button
            label={busy ? 'Saving…' : enough ? `Continue (${picked.size} picked)` : `Pick ${MIN_PICKS - picked.size} more`}
            variant={enough && !busy ? 'primary' : 'disabled'}
            onPress={() => void save()}
          />
        </View>
      }
    >
      <Row gap={16}>
        <Steps done={2} total={3} />
        <LinkText label="Skip" onPress={() => void skip()} />
      </Row>

      <View style={{ gap: 8 }}>
        <T variant="display" lineHeight={32} accessibilityRole="header">
          Follow your favorites
        </T>
        <T size={16} color={colors.textSecondary} lineHeight={23}>
          Pick at least three. We will tune your feed to them.
        </T>
      </View>

      <Row gap={8} style={{ height: 48, borderRadius: 24, backgroundColor: colors.bgTertiary, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 }}>
        <Icon name="search" size={20} color={colors.textSecondary} />
        <TextInput
          accessibilityLabel="Search artists"
          value={query}
          onChangeText={setQuery}
          placeholder="Search artists"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={{ flex: 1, minWidth: 0, height: 44, color: colors.text, fontFamily: fonts.regular, fontSize: 16 }}
        />
        {query ? (
          <Tap accessibilityLabel="Clear search" onPress={() => setQuery('')} style={{ minWidth: 32, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={18} color={colors.textSecondary} />
          </Tap>
        ) : null}
      </Row>

      {state.loading && !state.data ? (
        <Loading label={q ? 'Searching artists' : 'Finding trending artists'} height={240} />
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={state.reload} />
      ) : !list.length ? (
        <EmptyState icon="search" title={q ? 'No artists found' : 'No artists right now'} body={q ? 'Try a different spelling or another artist.' : 'Search for an artist you love.'} />
      ) : (
        <View style={{ gap: 16, paddingTop: 5 }}>
          {rows.map((r, ri) => (
            <Row key={ri} gap={12} align="flex-start">
              {r.map((a) => (
                <ArtistPick key={a.id} artist={a} on={picked.has(a.id)} onPress={() => toggle(a)} />
              ))}
              {Array.from({ length: 3 - r.length }, (_, i) => (
                <View key={`pad${i}`} style={{ flex: 1 }} />
              ))}
            </Row>
          ))}
        </View>
      )}
    </Screen>
  );
}
