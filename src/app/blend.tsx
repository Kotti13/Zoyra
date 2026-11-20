import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { Button, Cover, EmptyState, ErrorState, Glass, Icon, Loading, Row, Screen, ScreenHeader, T, Tap, TrackItem, flash, useAsync } from '../components';
import { listMutualFriends, loadBlend, type BlendPerson, type BlendSource } from '../lib/blend';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';

const first = (n: string) => n.split(' ')[0] ?? n;
type Mode = 'all' | BlendSource;

function Face({ person, size = 56 }: { person: { id: string; display_name: string; avatar_url: string | null } | null; size?: number }) {
  return (
    <Cover uri={person?.avatar_url} id={person?.id} size={size} radius={size / 2} style={{ alignItems: 'center', justifyContent: 'center' }}>
      {person?.avatar_url ? null : (
        <T size={size * 0.38} weight={600} color={colors.white}>
          {(person?.display_name?.[0] ?? '?').toUpperCase()}
        </T>
      )}
    </Cover>
  );
}

/**
 * Blend (`/blend?user=<id>`): one playlist from your listening and a friend's (last 90 days). Pick a mutual
 * friend, filter by whose picks they are, play it or save it as a private playlist. Friends whose listening
 * is private (or who haven't listened) show an honest empty state.
 */
export default function Blend() {
  const { user: userParam } = useLocalSearchParams<{ user?: string }>();
  const { user, profile } = useAuth();
  const me = user?.id;
  const lib = useLibrary();
  const { playTracks } = usePlayerPick();
  const [picked, setPicked] = useState<string | null>(typeof userParam === 'string' && userParam ? userParam : null);
  const [mode, setMode] = useState<Mode>('all');
  const [saving, setSaving] = useState(false);

  const friends = useAsync<BlendPerson[]>(() => (me ? listMutualFriends(me) : Promise.resolve([])), [me], 'app/blend:42');
  const other = useMemo(() => {
    const list = friends.data ?? [];
    return list.find((f) => f.id === picked) ?? (picked ? null : list[0] ?? null);
  }, [friends.data, picked]);

  const blend = useAsync(() => (me && other ? loadBlend(me, other) : Promise.resolve(null)), [me, other?.id], 'app/blend:48');
  const b = blend.data;
  const myName = profile?.display_name ?? 'You';
  const meFace = { id: me ?? '', display_name: myName, avatar_url: profile?.avatar_url ?? null };

  const shown = (b?.tracks ?? []).filter((t) => mode === 'all' || t.source === mode);
  const list = shown.map((t) => t.track);

  const play = () => {
    if (!b || !list.length) return;
    playTracks(list, 0, `Blend · ${first(myName)} + ${first(b.other.display_name)}`);
    router.push('/player');
  };

  const save = async () => {
    if (!b || !b.tracks.length || saving) return;
    setSaving(true);
    try {
      const pl = await lib.createPlaylist({ title: `Blend · ${first(myName)} + ${first(b.other.display_name)}`, description: `A mix of ${first(myName)}'s and ${first(b.other.display_name)}'s recent listening.`, visibility: 'private' });
      await lib.addToPlaylist(pl.id, b.tracks.map((t) => t.track));
      flash('Blend saved to your library');
      router.push({ pathname: '/playlist', params: { id: pl.id } });
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Could not save the Blend');
    } finally {
      setSaving(false);
    }
  };

  const badge = (s: BlendSource) => {
    const label = s === 'both' ? '2' : s === 'me' ? (myName[0] ?? 'Y') : (b?.other.display_name[0] ?? '?');
    return (
      <View accessibilityLabel={s === 'both' ? 'Both of you' : s === 'me' ? 'Your pick' : `${first(b?.other.display_name ?? 'Friend')}'s pick`} style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: s === 'both' ? colors.accent : withAlpha(colors.white, 0.12) }}>
        <T size={12} weight={700} color={colors.white}>
          {label.toUpperCase()}
        </T>
      </View>
    );
  };

  if (!me || friends.loading) {
    return (
      <Screen top={4} gap={16} backdrop={{ pattern: 'none', mesh: 'coral' }}>
        <ScreenHeader title="Blend" />
        {me ? <Loading /> : <EmptyState icon="users" title="Sign in to make a Blend" />}
      </Screen>
    );
  }
  if (friends.error) {
    return (
      <Screen top={4} gap={16} backdrop={{ pattern: 'none', mesh: 'coral' }}>
        <ScreenHeader title="Blend" />
        <ErrorState message={friends.error} onRetry={friends.reload} />
      </Screen>
    );
  }
  if (!friends.data?.length) {
    return (
      <Screen top={4} gap={16} backdrop={{ pattern: 'none', mesh: 'coral' }}>
        <ScreenHeader title="Blend" />
        <EmptyState icon="users" title="No friends to blend with yet" body="A Blend needs someone you follow who follows you back." action="Find people" href="/followers" />
      </Screen>
    );
  }

  const tabs: { key: Mode; label: string }[] = [
    { key: 'me', label: 'Your picks' },
    { key: 'both', label: 'Both' },
    { key: 'them', label: `${first(other?.display_name ?? 'Friend')}’s picks` },
  ];

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'none', mesh: 'coral' }} onRefresh={blend.refresh}>
      <ScreenHeader title="Blend" />
      <T size={14} color={colors.textSecondary} style={{ marginTop: -8 }}>
        One playlist from your taste and a friend’s.
      </T>

      {friends.data.length > 1 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {friends.data.map((f) => {
            const on = f.id === other?.id;
            return (
              <Tap key={f.id} onPress={() => (setPicked(f.id), setMode('all'))} accessibilityState={{ selected: on }} accessibilityLabel={`Blend with ${f.display_name}`}>
                <View style={[{ height: 36, paddingHorizontal: 14, borderRadius: 18, justifyContent: 'center' }, on ? { backgroundColor: colors.accent } : { borderWidth: 1, borderColor: colors.chipOutline }]}>
                  <T size={13} weight={600} color={on ? colors.onAccent : colors.text}>
                    {first(f.display_name)}
                  </T>
                </View>
              </Tap>
            );
          })}
        </View>
      ) : null}

      <Glass radius={32} padding={20} style={{ alignItems: 'center', gap: 10 }}>
        <Row gap={10}>
          <Face person={meFace} />
          <T size={20} color={colors.textSecondary}>
            +
          </T>
          <Face person={other} />
        </Row>
        <T size={18} weight={600}>{`You and ${first(other?.display_name ?? 'friend')}`}</T>
        {blend.loading ? (
          <Loading height={60} />
        ) : b && b.myPlays > 0 && b.theirPlays > 0 ? (
          <>
            <T size={14} color={colors.accentLight} weight={600}>{`${Math.round(b.match * 100)}% match`}</T>
            <Row gap={6} style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
              {tabs.map((t) => {
                const on = mode === t.key;
                return (
                  <Tap key={t.key} onPress={() => setMode(on ? 'all' : t.key)} accessibilityState={{ selected: on }} accessibilityLabel={t.label}>
                    <View style={[{ height: 32, paddingHorizontal: 12, borderRadius: 16, justifyContent: 'center' }, on ? { backgroundColor: colors.accent } : { borderWidth: 1, borderColor: colors.chipOutline }]}>
                      <T size={12} weight={600} color={on ? colors.onAccent : colors.text}>
                        {t.label}
                      </T>
                    </View>
                  </Tap>
                );
              })}
            </Row>
          </>
        ) : null}
      </Glass>

      {blend.error ? (
        <ErrorState message={blend.error} onRetry={blend.reload} />
      ) : b && b.theirPlays === 0 ? (
        <EmptyState icon="users" title={`${first(b.other.display_name)}'s listening isn't visible`} body="They haven't listened lately, or they keep their listening activity private." />
      ) : b && b.myPlays === 0 ? (
        <EmptyState icon="music" title="Listen to a few songs first" body="Your Blend is built from what you've played in the last 90 days." />
      ) : b ? (
        <>
          <T variant="overline" color={colors.textSecondary}>
            TOP TRACKS IN THIS BLEND
          </T>
          {shown.length === 0 ? (
            <T size={14} color={colors.textSecondary}>
              Nothing here yet. Try another filter.
            </T>
          ) : (
            <View>
              {shown.map((t) => (
                <TrackItem key={t.track.id} track={t.track} list={list} context="blend" showDuration={false} right={badge(t.source)} />
              ))}
            </View>
          )}
          <Row gap={10}>
            <View style={{ flex: 1 }}>
              <Button label="Play" icon="play" variant="glass" onPress={play} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label={saving ? 'Saving…' : 'Save Blend'} icon="plus" variant={saving ? 'disabled' : 'primary'} onPress={() => void save()} />
            </View>
          </Row>
          <Row gap={6} style={{ justifyContent: 'center' }}>
            <Icon name="info" size={14} color={colors.textTertiary} />
            <T size={12} color={colors.textTertiary}>
              Built from the last 90 days of listening.
            </T>
          </Row>
        </>
      ) : null}
    </Screen>
  );
}
