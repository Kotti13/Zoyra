import { LinearGradient } from 'expo-linear-gradient';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Share, StyleSheet, View } from 'react-native';

import { Avatar, Button, Cover, Icon, IconButton, Row, Screen, Spacer, T, Tap, useAsync } from '../components';
import type { CatalogTrack } from '../lib/catalog';
import { shareContent, trackShareUrl } from '../lib/share-links';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { colors, gradients, withAlpha } from '../theme/tokens';

const SEGMENTS = 5;
const YEAR = new Date().getFullYear();

type Insights = {
  minutes: number;
  plays: number;
  top_artists: { name: string | null; plays: number }[];
  top_genres: { genre: string | null; plays: number }[];
  by_day: { day: string; minutes: number }[];
};

const GENRE_NOUN: [RegExp, string][] = [
  [/lo-?fi/i, 'Drifter'],
  [/hip-hop|rap/i, 'Wordsmith'],
  [/electronic|house|techno|dubstep|trance|drum/i, 'Pulse Chaser'],
  [/ambient|classical/i, 'Daydreamer'],
  [/pop/i, 'Hook Hunter'],
  [/r&b|soul|jazz/i, 'Smooth Operator'],
  [/rock|alternative|metal|punk/i, 'Rebel'],
  [/folk|acoustic|country/i, 'Storyteller'],
];

function personality(topGenre: string | null | undefined, peakHour: number) {
  const time = peakHour >= 22 || peakHour < 5 ? 'Night Orbit' : peakHour < 11 ? 'Sunrise' : peakHour < 17 ? 'Daylight' : 'Golden Hour';
  const noun = GENRE_NOUN.find(([re]) => topGenre && re.test(topGenre))?.[1] ?? 'Explorer';
  return `${time} ${noun}`;
}

export default function Wrapped() {
  const { user } = useAuth();
  const [step, setStep] = useState(0);

  const q = useAsync(async () => {
    if (!user) return null;
    const [ins, hist] = await Promise.all([
      supabase.rpc('listening_insights', { days: 365 }),
      supabase
        .from('play_history')
        .select('track_id, track, played_at')
        .eq('user_id', user.id)
        .gte('played_at', new Date(Date.now() - 365 * 864e5).toISOString())
        .order('played_at', { ascending: false })
        .limit(5000),
    ]);
    if (ins.error) throw new Error(ins.error.message);
    if (hist.error) throw new Error(hist.error.message);
    const rows = (hist.data ?? []) as { track_id: string; track: CatalogTrack; played_at: string }[];
    const counts = new Map<string, { track: CatalogTrack; n: number }>();
    const hours = Array.from({ length: 24 }, () => 0);
    const artists = new Set<string>();
    for (const r of rows) {
      const c = counts.get(r.track_id);
      if (c) c.n++;
      else counts.set(r.track_id, { track: r.track, n: 1 });
      hours[new Date(r.played_at).getHours()]++;
      artists.add(r.track.artist?.id ?? r.track.artist?.name);
    }
    const topSong = [...counts.values()].sort((a, b) => b.n - a.n)[0]?.track ?? null;
    return { ins: ins.data as Insights, topSong, peakHour: hours.indexOf(Math.max(...hours)), artists: artists.size };
  }, [user?.id], 'app/wrapped:44');

  const d = q.data;
  const minutes = Number(d?.ins.minutes) || 0;
  const plays = Number(d?.ins.plays) || 0;
  const topArtist = d?.ins.top_artists?.[0]?.name ?? null;
  const topGenre = d?.ins.top_genres?.find((g) => g.genre)?.genre ?? null;
  const days = d?.ins.by_day?.length ?? 0;
  const persona = d ? personality(topGenre, d.peakHour) : '';

  const stories = useMemo(
    () => [
      { pre: 'You listened for', big: minutes.toLocaleString(), post: `minutes this year` },
      { pre: 'You pressed play', big: plays.toLocaleString(), post: plays === 1 ? 'time' : 'times' },
      { pre: 'You explored', big: String(d?.artists ?? 0), post: (d?.artists ?? 0) === 1 ? 'artist' : 'different artists' },
      { pre: 'Music kept you company on', big: String(days), post: days === 1 ? 'day' : 'days' },
      { pre: 'Your top genre was', big: topGenre ?? '—', post: 'and you owned it' },
    ],
    [minutes, plays, d, days, topGenre],
  );
  const s = stories[step];

  const share = () => {
    const message = `My Zoyra Wrapped ${YEAR}: ${minutes.toLocaleString()} minutes${topArtist ? `, top artist ${topArtist}` : ''}${d?.topSong ? `, top song “${d.topSong.title}”` : ''}. I'm a ${persona}.`;
    // The top song's link unfurls into a cover-art card in chat apps.
    const url = d?.topSong ? trackShareUrl(d.topSong) : null;
    void (url ? shareContent({ url, title: `My Zoyra Wrapped ${YEAR}`, message }) : Share.share({ message })).catch(() => undefined);
  };

  return (
    <Screen
      scroll={false}
      gap={20}
      bottom={10}
      backdrop={{ pattern: 'lines', mesh: 'none' }}
      underlay={
        <LinearGradient
          colors={gradients.wrapped}
          locations={[0, 0.55, 1]}
          start={{ x: 0.33, y: 0 }}
          end={{ x: 0.67, y: 1.05 }}
          style={StyleSheet.absoluteFill}
        />
      }
    >
      {/* Story progress — tap to advance */}
      <Tap accessibilityLabel={`Story ${step + 1} of ${SEGMENTS}`} onPress={() => setStep((x) => (x + 1) % SEGMENTS)} style={{ paddingVertical: 4, flexDirection: 'row', gap: 4 }}>
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <View key={i} style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: i <= step ? colors.white : withAlpha(colors.white, 0.3) }} />
        ))}
      </Tap>

      <Row style={{ justifyContent: 'space-between' }}>
        <T variant="overline" color={colors.white}>
          ZOYRA WRAPPED {YEAR}
        </T>
        <IconButton icon="close" label="Close" color={colors.white} href="back" />
      </Row>

      {!user ? (
        <View style={{ flex: 1, justifyContent: 'center', gap: 16 }}>
          <T variant="display" color={colors.white}>
            Sign in to see your year in music
          </T>
          <Button label="Sign in" variant="light" href="/login" />
        </View>
      ) : q.loading && !d ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.white} />
        </View>
      ) : q.error ? (
        <View style={{ flex: 1, justifyContent: 'center', gap: 16 }}>
          <T size={18} weight={500} color={colors.white}>
            {q.error}
          </T>
          <Button label="Try again" variant="light" onPress={q.reload} />
        </View>
      ) : plays === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center', gap: 16 }}>
          <T variant="display" color={colors.white}>
            Your Wrapped is still warming up
          </T>
          <T size={18} weight={500} color={colors.white}>
            Listen to a few songs and come back — every play counts toward your year.
          </T>
          <Button label="Find music" variant="light" href="/search" />
        </View>
      ) : (
        <>
          <Tap onPress={() => setStep((x) => (x + 1) % SEGMENTS)} accessibilityLabel="Next story" style={{ gap: 8 }}>
            <T size={18} weight={500} color={colors.white}>
              {s.pre}
            </T>
            <T mono weight={500} size={s.big.length > 8 ? 44 : 64} tracking={-2} lineHeight={s.big.length > 8 ? 50 : 68} color={colors.white} accessibilityRole="header" numberOfLines={2}>
              {s.big}
            </T>
            <T size={18} weight={500} color={colors.white}>
              {s.post}
            </T>
          </Tap>

          <View style={styles.card}>
            <Row>
              <Cover artwork={d?.topSong?.artwork} id={d?.topSong?.id} size={56} radius={28} />
              <View style={{ gap: 2, flex: 1 }}>
                <T size={12} tracking={0.5} color={colors.white}>
                  TOP SONG
                </T>
                <T size={18} weight={700} color={colors.white} numberOfLines={1}>
                  {d?.topSong?.title ?? '—'}
                </T>
              </View>
            </Row>
            <View style={{ height: 1, backgroundColor: withAlpha(colors.white, 0.2) }} />
            <Row>
              <Avatar initial={(topArtist ?? '?').charAt(0).toUpperCase()} art="amber" size={56} />
              <View style={{ gap: 2, flex: 1 }}>
                <T size={12} tracking={0.5} color={colors.white}>
                  TOP ARTIST
                </T>
                <T size={18} weight={700} color={colors.white} numberOfLines={1}>
                  {topArtist ?? '—'}
                </T>
              </View>
            </Row>
          </View>

          <View style={{ gap: 4 }}>
            <T size={12} tracking={0.5} color={colors.white}>
              YOUR LISTENING PERSONALITY
            </T>
            <T variant="display" color={colors.white}>
              {persona}
            </T>
          </View>
        </>
      )}

      <Spacer />

      {plays > 0 ? (
        <Tap style={styles.share} onPress={share}>
          <Icon name="share" size={20} color={colors.bg} />
          <T size={16} weight={600} color={colors.bg}>
            Share your Wrapped
          </T>
        </Tap>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 12,
    padding: 16,
    borderRadius: 26,
    backgroundColor: withAlpha(colors.bg, 0.35),
    borderWidth: 1,
    borderColor: withAlpha(colors.white, 0.2),
  },
  share: {
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.white,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
});
