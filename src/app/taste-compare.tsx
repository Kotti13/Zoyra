import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { Button, Cover, EmptyState, ErrorState, Glass, IconButton, LinkText, Loading, ProgressBar, Row, Screen, ScreenHeader, SectionHeader, Spacer, T, Tap, flash, useAsync } from '../components';
import type { CatalogTrack } from '../lib/catalog';
import { chatPeerParams } from '../lib/chat';
import { startChat } from '../lib/dm';
import { friendlySocialError, useBlocks } from '../lib/social';
import { supabase } from '../lib/supabase';
import { shareSnapshot } from '../lib/share-snapshots';
import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

type Person = { id: string; display_name: string; avatar_url: string | null };
type HistoryRow = { track: CatalogTrack };
type SharedArtist = { id: string; name: string; image?: string; plays: number };
type Comparison = {
  other: Person;
  value: number;
  sharedArtists: SharedArtist[];
  sharedCount: number;
  genres: { name: string; value: number }[];
  blend: CatalogTrack[];
  theirPlays: number;
  myPlays: number;
};

const GENRE_COLORS = [colors.accent, colors.amber, colors.like];

function cosine(a: Map<string, number>, b: Map<string, number>) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  a.forEach((v, k) => {
    na += v * v;
    dot += v * (b.get(k) ?? 0);
  });
  b.forEach((v) => (nb += v * v));
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function counts(rows: HistoryRow[], key: (t: CatalogTrack) => string | undefined) {
  const m = new Map<string, number>();
  rows.forEach((r) => {
    const k = key(r.track);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  });
  return m;
}

function uniqueTracks(rows: HistoryRow[]) {
  const seen = new Set<string>();
  return rows.map((r) => r.track).filter((t) => t?.id && (seen.has(t.id) ? false : (seen.add(t.id), true)));
}

function compare(other: Person, mine: HistoryRow[], theirs: HistoryRow[]): Comparison {
  const aa = counts(mine, (t) => t.artist?.id);
  const ab = counts(theirs, (t) => t.artist?.id);
  const ga = counts(mine, (t) => t.genre);
  const gb = counts(theirs, (t) => t.genre);
  const value = 0.5 * cosine(aa, ab) + 0.5 * cosine(ga, gb);

  const artistInfo = new Map<string, SharedArtist>();
  [...mine, ...theirs].forEach((r) => {
    const a = r.track.artist;
    if (a?.id && !artistInfo.has(a.id)) artistInfo.set(a.id, { id: a.id, name: a.name, image: a.image, plays: 0 });
  });
  const sharedIds = [...aa.keys()].filter((k) => ab.has(k));
  const sharedArtists = sharedIds
    .map((k) => ({ ...(artistInfo.get(k) as SharedArtist), plays: (aa.get(k) ?? 0) + (ab.get(k) ?? 0) }))
    .sort((x, y) => y.plays - x.plays);

  const totalA = mine.length || 1;
  const totalB = theirs.length || 1;
  const genres = [...ga.keys()]
    .filter((g) => gb.has(g))
    .map((g) => {
      const pa = (ga.get(g) ?? 0) / totalA;
      const pb = (gb.get(g) ?? 0) / totalB;
      return { name: g, value: Math.min(pa, pb) / Math.max(pa, pb), weight: pa + pb };
    })
    .sort((x, y) => y.weight - x.weight)
    .slice(0, 3)
    .map(({ name, value: v }) => ({ name, value: v }));

  // Blend: alternate between both listeners' recent tracks, shared-artist tracks first.
  const shared = new Set(sharedIds);
  const sortShared = (list: CatalogTrack[]) => [...list.filter((t) => shared.has(t.artist.id)), ...list.filter((t) => !shared.has(t.artist.id))];
  const a = sortShared(uniqueTracks(mine)).slice(0, 25);
  const b = sortShared(uniqueTracks(theirs)).slice(0, 25);
  const blend: CatalogTrack[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    [a[i], b[i]].forEach((t) => {
      if (t && !seen.has(t.id)) {
        seen.add(t.id);
        blend.push(t);
      }
    });
  }

  return { other, value, sharedArtists, sharedCount: sharedIds.length, genres, blend, theirPlays: theirs.length, myPlays: mine.length };
}

function headline(v: number) {
  if (v >= 0.8) return 'Soul mates in sound';
  if (v >= 0.6) return 'Seriously in sync';
  if (v >= 0.4) return 'Plenty in common';
  if (v >= 0.2) return 'Some common ground';
  return 'Opposites attract';
}

function MatchRing({ value }: { value: number }) {
  const size = 96;
  const stroke = 9;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <View accessibilityLabel={`${Math.round(value * 100)} percent match`} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.track} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colors.amber}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${c * value} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={{ width: 78, height: 78, borderRadius: 39, backgroundColor: colors.bgSecondary, alignItems: 'center', justifyContent: 'center' }}>
        <T size={24} weight={700}>
          {Math.round(value * 100)}%
        </T>
      </View>
    </View>
  );
}

function Initial({ name, id, uri }: { name: string; id?: string; uri?: string | null }) {
  return (
    <Cover uri={uri} id={id} size={64} radius={32} style={{ alignItems: 'center', justifyContent: 'center' }}>
      {uri ? null : (
        <T size={21} weight={600} color={colors.white}>
          {(name[0] ?? '?').toUpperCase()}
        </T>
      )}
    </Cover>
  );
}

const firstName = (n: string) => n.split(' ')[0] ?? n;

export default function TasteCompare() {
  const { user: userParam } = useLocalSearchParams<{ user?: string }>();
  const { user, profile } = useAuth();
  const me = user?.id;
  const { playTracks } = usePlayerPick();
  const { blocked, block, unblock } = useBlocks(me);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<'message' | 'block' | null>(null);

  const res = useAsync<Comparison | null>(async () => {
    if (!me) return null;
    let otherId = typeof userParam === 'string' && userParam ? userParam : null;
    if (!otherId) {
      const f = await supabase.from('follows').select('following_id').eq('follower_id', me).order('created_at', { ascending: false }).limit(1);
      if (f.error) throw new Error(f.error.message);
      otherId = (f.data?.[0] as { following_id: string } | undefined)?.following_id ?? null;
    }
    if (!otherId) return null;
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const [p, mine, theirs] = await Promise.all([
      supabase.from('profiles').select('id, display_name, avatar_url').eq('id', otherId).single(),
      supabase.from('play_history').select('track').eq('user_id', me).gte('played_at', since).order('played_at', { ascending: false }).limit(1000),
      supabase.from('play_history').select('track').eq('user_id', otherId).gte('played_at', since).order('played_at', { ascending: false }).limit(1000),
    ]);
    if (p.error) throw new Error(p.error.message);
    if (mine.error) throw new Error(mine.error.message);
    if (theirs.error) throw new Error(theirs.error.message);
    return compare(p.data as Person, (mine.data ?? []) as HistoryRow[], (theirs.data ?? []) as HistoryRow[]);
  }, [me, userParam]);

  const c = res.data;
  const myName = profile?.display_name ?? 'You';

  const share = async () => {
    if (!c) return;
    await shareSnapshot({
      kind: 'm',
      payload: { me: firstName(myName), you: firstName(c.other.display_name), pct: Math.round(c.value * 100), artists: c.sharedArtists.slice(0, 4).map((a) => a.name), genres: c.genres.slice(0, 3).map((g) => ({ n: g.name, p: Math.round(g.value * 100) })) },
      title: 'Taste match on Zoyra',
      me: { id: user?.id, username: profile?.username },
      message: `${firstName(myName)} and ${firstName(c.other.display_name)} are a ${Math.round(c.value * 100)}% taste match on Zoyra.` }).catch(() => undefined);
  };

  const playBlend = () => {
    if (!c?.blend.length) return;
    playTracks(c.blend, 0, `Blend · ${firstName(myName)} + ${firstName(c.other.display_name)}`);
    router.push('/player');
  };

  const message = async () => {
    if (!c || busy) return;
    setBusy('message');
    setNote(null);
    try {
      const { id, request } = await startChat(c.other.id);
      if (request) flash('Sent as a request');
      router.push({ pathname: '/chat-pro', params: { id, ...chatPeerParams(c.other) } });
    } catch (e) {
      setNote({ ok: false, text: friendlySocialError(e, 'Could not start a conversation') });
    } finally {
      setBusy(null);
    }
  };

  const toggleBlock = async () => {
    if (!c || busy) return;
    setBusy('block');
    setNote(null);
    try {
      const wasBlocked = blocked.has(c.other.id);
      const done = wasBlocked ? await unblock(c.other.id, c.other.display_name) : await block(c.other.id, c.other.display_name);
      if (done) setNote({ ok: true, text: wasBlocked ? `Unblocked ${c.other.display_name}` : `Blocked ${c.other.display_name}. Follows between you were removed.` });
    } catch (e) {
      setNote({ ok: false, text: friendlySocialError(e, 'Could not update block') });
    } finally {
      setBusy(null);
    }
  };

  if (res.loading || res.error || !c) {
    return (
      <Screen top={4} gap={16} backdrop={{ pattern: 'grid', mesh: 'rose' }} contentStyle={{ flexGrow: 1 }}>
        <ScreenHeader title="Taste match" />
        {res.loading ? (
          <Loading />
        ) : res.error ? (
          <ErrorState message={res.error} onRetry={res.reload} />
        ) : (
          <EmptyState icon="users" title="No one to compare with" body="Follow a friend to see how your tastes line up." action="Find people" href="/followers" />
        )}
      </Screen>
    );
  }

  const isBlocked = blocked.has(c.other.id);
  const noData = c.theirPlays === 0 || c.myPlays === 0;
  const subtitle = c.theirPlays === 0
    ? `${firstName(c.other.display_name)}'s listening is private or empty. Follow them and check back after they listen.`
    : c.myPlays === 0
      ? 'Listen to a few songs so we can compare your tastes.'
      : `You and ${firstName(c.other.display_name)} share ${c.sharedCount} ${c.sharedCount === 1 ? 'artist' : 'artists'}`;

  return (
    <Screen onRefresh={res.refresh} top={4} gap={16} backdrop={{ pattern: 'grid', mesh: 'rose' }} contentStyle={{ flexGrow: 1 }}>
      <ScreenHeader title="Taste match" right={<IconButton icon="share" label="Share" onPress={() => void share()} />} />

      <Row gap={14} style={{ justifyContent: 'center' }}>
        <Initial name={myName} id={me} uri={profile?.avatar_url} />
        <MatchRing value={c.value} />
        <Initial name={c.other.display_name} id={c.other.id} uri={c.other.avatar_url} />
      </Row>

      <View style={{ alignItems: 'center', gap: 4 }}>
        <T variant="title" align="center" accessibilityRole="header">
          {noData ? 'Not enough listening yet' : headline(c.value)}
        </T>
        <T size={14} color={colors.textSecondary} align="center">
          {subtitle}
        </T>
      </View>

      {c.sharedArtists.length ? (
        <>
          <SectionHeader title="Artists you both love" />
          <Row gap={8} style={{ justifyContent: 'space-around' }}>
            {c.sharedArtists.slice(0, 3).map((a) => (
              <Tap key={a.id} onPress={() => router.push({ pathname: '/artist', params: { id: a.id } })} accessibilityLabel={a.name} style={{ width: 72, alignItems: 'center', gap: 6 }}>
                <Cover uri={a.image} id={a.id} size={64} radius={32} />
                <T size={12} align="center" lineHeight={16} numberOfLines={2}>
                  {a.name}
                </T>
              </Tap>
            ))}
          </Row>
        </>
      ) : null}

      {c.genres.length ? (
        <>
          <SectionHeader title="Genre overlap" />
          <Glass padding={16}>
            <View style={{ gap: 12 }}>
              {c.genres.map((g, i) => (
                <Row key={g.name} gap={12}>
                  <T size={14} style={{ width: 72 }} numberOfLines={1}>
                    {g.name}
                  </T>
                  <ProgressBar value={g.value} height={8} color={GENRE_COLORS[i % GENRE_COLORS.length]} style={{ flex: 1 }} />
                  <T mono size={12} color={colors.textSecondary}>
                    {Math.round(g.value * 100)}%
                  </T>
                </Row>
              ))}
            </View>
          </Glass>
        </>
      ) : null}

      <Spacer />

      <Button label="Play a blend" icon="play" variant={c.blend.length ? 'primary' : 'disabled'} onPress={playBlend} />
      <Button label="Make a Blend playlist" icon="plus" variant="secondary" href={{ pathname: '/blend', params: { user: c.other.id } }} />
      {isBlocked ? null : (
        <Button label={busy === 'message' ? 'Opening…' : `Message ${firstName(c.other.display_name)}`} icon="mail" variant={busy ? 'disabled' : 'glass'} onPress={() => void message()} />
      )}
      {note ? (
        <T size={13} lineHeight={18} color={note.ok ? colors.textSecondary : colors.error} align="center" accessibilityLiveRegion="polite">
          {note.text}
        </T>
      ) : null}
      {c.other.id !== me ? (
        <View style={{ alignItems: 'center' }}>
          <LinkText
            label={busy === 'block' ? 'Working…' : isBlocked ? `Unblock ${firstName(c.other.display_name)}` : `Block ${firstName(c.other.display_name)}`}
            color={isBlocked ? colors.accentLight : colors.error}
            size={13}
            onPress={() => void toggleBlock()}
          />
        </View>
      ) : null}
    </Screen>
  );
}
