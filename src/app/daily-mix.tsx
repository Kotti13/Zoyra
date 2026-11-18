import { router } from 'expo-router';
import { View } from 'react-native';

import { Art, Cover, ErrorState, Loading, MiniPlayer, Screen, ScreenHeader, T, Tap, useAsync } from '../components';
import { GENRES, catalog, type Artwork } from '../lib/catalog';
import { filterHidden } from '../lib/content-filter';
import { useAuth } from '../state/auth';
import { colors, withAlpha, type ArtName } from '../theme/tokens';

const arts: ArtName[] = ['coral', 'rose', 'amber', 'blue', 'green'];

type Mix = { genre: string; title: string; sub: string; artwork?: Artwork };

export default function DailyMix() {
  const { settings } = useAuth();
  const genres = settings?.genres?.length ? settings.genres : GENRES.slice(0, 4);
  const kidSafe = (settings?.privacy?.hide_explicit ?? false) || settings?.kids?.on === true;
  const key = `${genres.join('|')}:${kidSafe ? 1 : 0}`;

  const mixes = useAsync<Mix[]>(
    () =>
      Promise.all(
        genres.map(async (g, i): Promise<Mix> => {
          const title = `Daily Mix ${i + 1}`;
          try {
            // The tile previews (names, artwork) skip hidden songs/artists and kid-safe explicit songs.
            const t = filterHidden(await catalog.trending({ genre: g, limit: 8 }), kidSafe);
            const names = [...new Set(t.map((x) => x.artist.name))].slice(0, 2);
            return { genre: g, title, sub: names.length ? `${g} · ${names.join(', ')} and more` : `${g} picks for you`, artwork: t[0]?.artwork };
          } catch {
            return { genre: g, title, sub: `${g} picks for you` };
          }
        }),
      ),
    [key],
  );

  return (
    <Screen onRefresh={mixes.refresh} top={4} bottom={12} gap={16} backdrop={{ pattern: 'dots', mesh: 'coral' }} footer={<MiniPlayer />}>
      <ScreenHeader title="Made for you" />

      <View style={{ gap: 8 }}>
        <T size={26} weight={700} tracking={-0.5} lineHeight={30} accessibilityRole="header">
          Your mixes
        </T>
        <T size={16} lineHeight={23} color={colors.textSecondary}>
          {settings?.genres?.length ? 'Built from the genres you picked.' : 'Pick your genres in onboarding to personalise these.'}
        </T>
      </View>

      {mixes.loading && !mixes.data ? (
        <Loading label="Building your mixes" />
      ) : mixes.error ? (
        <ErrorState message={mixes.error} onRetry={mixes.reload} />
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 14 }}>
          {(mixes.data ?? []).map((m, i) => (
            <Tap
              key={m.genre}
              accessibilityLabel={`${m.title}, ${m.sub}`}
              onPress={() => router.push({ pathname: '/playlist', params: { mix: m.genre, title: m.title } })}
              style={{ flexBasis: '45%', flexGrow: 1, gap: 8 }}
            >
              <Cover artwork={m.artwork} id={m.genre} radius={32} sticker style={{ width: '100%', height: undefined, aspectRatio: 1, justifyContent: 'flex-end', padding: 14 }}>
                <View style={{ position: 'absolute', inset: 0, backgroundColor: withAlpha(colors.black, 0.25) }} />
                <T size={20} weight={700} lineHeight={22} color={colors.white}>
                  {m.title}
                </T>
              </Cover>
              <T size={12} lineHeight={17} color={colors.textSecondary} numberOfLines={2}>
                {m.sub}
              </T>
            </Tap>
          ))}
          <Tap accessibilityLabel="Release Radar, new from artists you follow" href="/new-releases" style={{ flexBasis: '45%', flexGrow: 1, gap: 8 }}>
            <Art art={arts[2]} radius={32} sticker style={{ width: '100%', height: undefined, aspectRatio: 1, justifyContent: 'flex-end', padding: 14 }}>
              <T size={20} weight={700} lineHeight={22} color={colors.white}>
                Release Radar
              </T>
            </Art>
            <T size={12} lineHeight={17} color={colors.textSecondary}>
              New from artists you follow
            </T>
          </Tap>
        </View>
      )}
    </Screen>
  );
}
