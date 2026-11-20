import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Cover, EmptyState, ErrorState, Glass, Icon, Loading, Row, Screen, ScreenHeader, T, Tap, Toggle, flash, useAsync } from '../components';
import { getDailyMemory, loadMemories, monthDayLabel, playsLabel, setDailyMemory, yearsAgoLabel } from '../lib/memories';
import { shareContent, trackShareUrl } from '../lib/share-links';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

/**
 * On this day (`/memories`): the song you played most on today's date in each earlier year, from your own
 * listening history. Play any of them, turn them into a private playlist, or get a 9 AM nudge each day.
 */
export default function Memories() {
  const { user } = useAuth();
  const me = user?.id;
  const lib = useLibrary();
  const { playTracks } = usePlayerPick();
  const [daily, setDaily] = useState(false);
  const [busy, setBusy] = useState<'playlist' | 'daily' | null>(null);
  const today = new Date();

  const res = useAsync(() => (me ? loadMemories() : Promise.resolve([])), [me], 'app/memories:26');
  const list = res.data ?? [];
  const tracks = list.map((m) => m.track);

  useEffect(() => {
    void getDailyMemory().then(setDaily);
  }, []);

  const play = (i: number) => {
    playTracks(tracks, i, 'on-this-day');
    router.push('/player');
  };

  const makePlaylist = async () => {
    if (busy || !tracks.length) return;
    setBusy('playlist');
    try {
      const pl = await lib.createPlaylist({ title: `On this day · ${monthDayLabel(today)}`, description: `Songs from ${monthDayLabel(today)} in past years.`, visibility: 'private' });
      await lib.addToPlaylist(pl.id, tracks);
      flash('Memory playlist saved');
      router.push({ pathname: '/playlist', params: { id: pl.id } });
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Could not make the playlist');
    } finally {
      setBusy(null);
    }
  };

  const toggleDaily = async (on: boolean) => {
    if (busy) return;
    setBusy('daily');
    try {
      const ok = await setDailyMemory(on);
      if (!ok) flash('Allow notifications in Settings to get daily memories');
      else setDaily(on);
    } catch {
      flash('Could not change the daily reminder');
    } finally {
      setBusy(null);
    }
  };

  const share = async (i: number) => {
    const m = list[i];
    const url = trackShareUrl(m.track);
    if (!url) return flash('This song has no public link');
    await shareContent({ url, title: m.track.title, message: `${m.yearsAgo === 1 ? '1 year ago' : `${m.yearsAgo} years ago`} today I was playing ${m.track.title} by ${m.track.artist.name}` }).catch(() => undefined);
  };

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'none', mesh: 'coral' }} onRefresh={res.refresh}>
      <ScreenHeader title="On this day" back="/" />
      <T size={14} color={colors.textSecondary} style={{ marginTop: -8 }}>{`Songs that were on repeat on ${monthDayLabel(today)}.`}</T>

      {res.loading ? (
        <Loading />
      ) : res.error ? (
        <ErrorState message={res.error} onRetry={res.reload} />
      ) : !list.length ? (
        <EmptyState icon="clock" title="No memories for today yet" body={`Once you've listened on ${monthDayLabel(today)} in earlier years, your top song from each one shows up here.`} />
      ) : (
        <View style={{ gap: 12 }}>
          {list.map((m, i) => (
            <Glass key={m.year} radius={28} padding={0}>
              <Tap onPress={() => play(i)} onLongPress={() => void share(i)} accessibilityLabel={`${m.yearsAgo} ${m.yearsAgo === 1 ? 'year' : 'years'} ago: ${m.track.title} by ${m.track.artist.name}. Double tap to play, long press to share`} pressScale={0.98}>
                <Row gap={14} style={{ padding: 14 }}>
                  <Cover artwork={m.track.artwork} id={m.track.id} size={72} radius={20} />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <T variant="overline" color={colors.accentLight}>
                      {yearsAgoLabel(m.yearsAgo)}
                    </T>
                    <T size={17} weight={600} numberOfLines={1}>
                      {m.track.title}
                    </T>
                    <T size={13} color={colors.textSecondary} numberOfLines={2}>
                      {`${playsLabel(m.plays)} · ${m.track.artist.name}`}
                    </T>
                  </View>
                  <Icon name="play" size={22} color={colors.text} />
                </Row>
              </Tap>
            </Glass>
          ))}

          <Tap onPress={() => void makePlaylist()} accessibilityLabel="Make a memory playlist" pressScale={0.98}>
            <Row gap={12} style={{ padding: 16, borderRadius: 28, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.accentTint }}>
              <Icon name="queue" size={22} color={colors.accentLight} />
              <View style={{ flex: 1 }}>
                <T size={15} weight={600}>
                  {busy === 'playlist' ? 'Making your playlist…' : 'Make a memory playlist'}
                </T>
                <T size={13} color={colors.textSecondary}>{`All ${list.length} ${list.length === 1 ? 'song' : 'songs'}, ready to play or share`}</T>
              </View>
              <Icon name="chevronRight" size={16} color={colors.textSecondary} />
            </Row>
          </Tap>
        </View>
      )}

      <Glass radius={28} padding={16}>
        <Row gap={12}>
          <Icon name="bell" size={22} color={colors.accentLight} />
          <View style={{ flex: 1 }}>
            <T size={15} weight={600}>
              Daily memory
            </T>
            <T size={13} color={colors.textSecondary}>
              A 9 AM nudge from this phone. Turn it off any time.
            </T>
          </View>
          <Toggle value={daily} onChange={(v) => void toggleDaily(v)} label="Daily memory" />
        </Row>
      </Glass>
    </Screen>
  );
}
