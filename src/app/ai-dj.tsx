import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import { Button, ChipRow, EmptyState, ErrorState, Glass, Gradient, IconButton, Loading, Row, Screen, ScreenHeader, SectionHeader, Segmented, Sticker, T, Tap, Toast, TrackItem, useAsync } from '../components';
import { aiDjScript, speakAsync, stopSpeaking } from '../lib/ai';
import { GENRES, catalog, type CatalogTrack } from '../lib/catalog';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';

const DJ = 'Zoyra DJ';
const wave = [18, 43, 41, 53, 25, 24, 44, 41, 26, 42, 30, 46, 18, 23];
const rings: { size: number; alpha: number }[] = [
  { size: 250, alpha: 0.08 },
  { size: 216, alpha: 0.14 },
  { size: 182, alpha: 0.22 },
];

function partOfDay() {
  const h = new Date().getHours();
  return h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
}

/** Interleave sources, drop duplicates, max 2 per artist. */
function blend(lists: CatalogTrack[][], limit: number) {
  const seen = new Set<string>();
  const per = new Map<string, number>();
  const out: CatalogTrack[] = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max && out.length < limit; i++) {
    for (const l of lists) {
      const t = l[i];
      if (!t || seen.has(t.id)) continue;
      const n = per.get(t.artist.id) ?? 0;
      if (n >= 2) continue;
      seen.add(t.id);
      per.set(t.artist.id, n + 1);
      out.push(t);
      if (out.length >= limit) break;
    }
  }
  return out;
}

type Talk = 'Off' | 'Low' | 'High';
const TALK: Talk[] = ['Off', 'Low', 'High'];
const SCRIPT_LEN = 12;
const DUCK = 0.2;

/** Local template line, used when the AI script is unavailable. Still spoken with on-device TTS. */
function templateLine(t: CatalogTrack, i: number, name: string) {
  if (i === 0) return `${partOfDay()}, ${name}. This is your Zoyra DJ. Let's start with ${t.title} by ${t.artist.name}.`;
  const lines = [
    `Up next, ${t.title} from ${t.artist.name}.`,
    `Keeping it going with ${t.artist.name}. This one is ${t.title}.`,
    `Here's ${t.title}${t.genre ? `, a little ${t.genre}` : ''} from ${t.artist.name}.`,
    `${t.artist.name} is next with ${t.title}. Turn it up.`,
  ];
  return lines[i % lines.length];
}

const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T) =>
  Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

const shuffle = <T,>(l: T[]) => {
  const a = [...l];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export default function AiDj() {
  const { user, profile, settings } = useAuth();
  const { liked } = useLibrary();
  const player = usePlayerPick('track', 'queue', 'index', 'playing', 'context');
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 3600);
    return () => clearTimeout(id);
  }, [note]);

  const [talk, setTalk] = useState<Talk>('Low');
  const [said, setSaid] = useState<string | null>(null);
  const [scriptInfo, setScriptInfo] = useState<string>('Voice uses on-device speech.');
  /** Spoken line per track id (AI or template). */
  const lines = useRef(new Map<string, string>());
  const speakToken = useRef(0);

  const genres = settings?.genres?.length ? settings.genres : GENRES.slice(0, 3);
  const uid = user?.id;

  const mix = useAsync(async () => {
    const history = uid
      ? await supabase
          .from('play_history')
          .select('track')
          .eq('user_id', uid)
          .order('played_at', { ascending: false })
          .limit(60)
          .then(({ data }) => (data ?? []).map((r: { track: CatalogTrack }) => r.track))
      : [];
    const byGenre = await Promise.all(genres.slice(0, 4).map((g) => catalog.trending({ genre: g, limit: 20 }).catch(() => [] as CatalogTrack[])));
    const lists = [...byGenre.map(shuffle), shuffle(liked), shuffle(history)];
    let tracks = blend(lists, 50);
    if (!tracks.length) tracks = await catalog.trending({ limit: 30 });
    const topGenre = (() => {
      const c = new Map<string, number>();
      [...history, ...liked].forEach((t) => t.genre && c.set(t.genre, (c.get(t.genre) ?? 0) + 1));
      return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? genres[0];
    })();
    return { tracks, topGenre, fromLikes: liked.length, fromHistory: history.length };
  }, [uid, genres.join('|'), liked.length]);

  const name = profile?.display_name ?? 'there';

  /** Fetch the AI script for these tracks; keep template lines when it fails. */
  const prepareScript = useCallback(
    async (tracks: CatalogTrack[], mood: string) => {
      const head = tracks.slice(0, SCRIPT_LEN);
      head.forEach((t, i) => lines.current.set(t.id, templateLine(t, i, name)));
      const res = await aiDjScript(
        head.map((t) => ({ title: t.title, artist: t.artist.name, genre: t.genre ?? '' })),
        name,
        mood,
      );
      if (res.ok && res.data.lines.length) {
        head.forEach((t, i) => {
          const l = res.data.lines[i]?.trim();
          if (l) lines.current.set(t.id, l);
        });
        setScriptInfo('AI script · on-device voice');
        return;
      }
      setScriptInfo(res.ok ? 'Template lines · on-device voice' : res.reason === 'not_configured' ? `Template lines · AI script needs ${res.service} setup` : 'Template lines · AI script unavailable');
    },
    [name],
  );

  /*
   * Ducking goes through the player, which owns the final volume (sleep fade × smooth transition,
   * capped by the duck level). Releasing the duck can never leave the music stuck at a faded level.
   */
  const { duck } = player;
  const restoreVolume = useCallback(() => duck(null), [duck]);

  /** Duck the music, speak, restore. A newer call cancels the older one. */
  const say = useCallback(
    async (text: string) => {
      const token = ++speakToken.current;
      await stopSpeaking();
      duck(DUCK);
      setSaid(text);
      try {
        await speakAsync(text);
      } finally {
        if (token === speakToken.current) restoreVolume();
      }
    },
    [duck, restoreVolume],
  );

  // Stop talking and give the music its volume back when leaving the screen.
  useEffect(
    () => () => {
      speakToken.current++;
      void stopSpeaking();
      restoreVolume();
    },
    [restoreVolume],
  );

  const djOn = player.context === DJ;

  // Speak the line for each new track as it starts (talk level sets how often).
  const currentId = player.track?.id;
  useEffect(() => {
    if (!djOn || !currentId || talk === 'Off') return;
    const t = player.queue[player.index];
    if (!t || t.id !== currentId) return;
    if (talk === 'Low' && player.index % 3 !== 0) return;
    void say(lines.current.get(t.id) ?? templateLine(t, player.index, name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [djOn, currentId, talk]);
  const upNext = useMemo(() => {
    if (djOn) return player.queue.slice(player.index + 1, player.index + 4);
    return (mix.data?.tracks ?? []).slice(0, 3);
  }, [djOn, player.queue, player.index, mix.data]);

  // Prefetch the script for the mix so the first line is ready when the DJ starts.
  useEffect(() => {
    const data = mix.data;
    if (!data?.tracks.length) return;
    // Started asynchronously: the script request updates state when it resolves, not during the effect.
    void Promise.resolve().then(() => prepareScript(data.tracks, `${partOfDay().toLowerCase()}, into ${data.topGenre}`));
  }, [mix.data, prepareScript]);

  const [preparing, setPreparing] = useState(false);
  const start = () => {
    const t = mix.data?.tracks;
    if (!t?.length) return setNote('Nothing to play yet. Like a few songs first.');
    player.playTracks(t, 0, DJ);
  };

  const request = async (i: number) => {
    try {
      const list =
        i === 0 ? await catalog.byMood('Chill', 30) : i === 1 ? await catalog.trending({ genre: mix.data?.topGenre, limit: 30 }) : shuffle(await catalog.underground(30));
      if (!list.length) return setNote('Could not find songs for that request right now.');
      setPreparing(true);
      const mood = i === 0 ? 'calm and relaxed' : i === 1 ? `more ${mix.data?.topGenre ?? 'of the same'}` : 'surprise, fresh underground picks';
      // Give the AI a few seconds to write the intro; template lines cover the rest.
      await withTimeout(prepareScript(list, mood), 6000, undefined);
      player.playTracks(list, 0, DJ);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setPreparing(false);
    }
  };

  const speech = said && djOn
    ? said
    : mix.data
    ? djOn && player.track
      ? `Now spinning "${player.track.title}" by ${player.track.artist.name}. Keep going, more ${mix.data.topGenre} is lined up.`
      : `${partOfDay()}, ${name}. You have been into ${mix.data.topGenre} lately, so I mixed it with ${mix.data.fromLikes ? 'your liked songs' : 'fresh picks'}${mix.data.fromHistory ? ' and recent favourites' : ''}. Tap Start DJ when you are ready.`
    : 'Getting your mix ready…';

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'dots', mesh: 'rose' }}>
      <ScreenHeader
        title="Zoyra DJ"
        right={
          <IconButton
            icon="sliders"
            label="DJ voice status"
            onPress={() => setNote(`${scriptInfo}. Talk level: ${talk}.`)}
          />
        }
      />

      {/* Orb */}
      <Tap
        accessibilityLabel={djOn ? (player.playing ? 'Pause DJ' : 'Resume DJ') : 'Start DJ'}
        onPress={() => (djOn ? player.toggle() : start())}
        style={{ width: 250, height: 250, alignSelf: 'center', alignItems: 'center', justifyContent: 'center' }}
      >
        {rings.map((r) => (
          <View
            key={r.size}
            style={{ position: 'absolute', width: r.size, height: r.size, borderRadius: r.size / 2, borderWidth: 2, borderColor: withAlpha(colors.white, r.alpha) }}
          />
        ))}
        <View style={{ width: 140, height: 140, borderRadius: 70, shadowColor: colors.accent, shadowOpacity: 0.6, shadowRadius: 30, shadowOffset: { width: 0, height: 0 }, elevation: 16 }}>
          <Gradient colors={[colors.accent, colors.like]} style={{ width: 140, height: 140, borderRadius: 70, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: '70%', height: 56, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              {wave.map((h, i) => (
                <View key={i} style={{ flex: 1, height: djOn && player.playing ? h : Math.max(6, h / 3), borderRadius: 2, backgroundColor: colors.bg }} />
              ))}
            </View>
          </Gradient>
        </View>
      </Tap>

      {/* DJ speech */}
      <Glass padding={18}>
        <View style={{ gap: 8 }}>
          <T variant="overline" color={colors.accentLight}>
            DJ IS SAYING
          </T>
          <T size={17} lineHeight={25}>
            {preparing ? 'Writing your intro…' : speech}
          </T>
          <T size={12} color={colors.textTertiary}>
            {scriptInfo}
          </T>
        </View>
      </Glass>

      {note ? <Toast icon="info" iconColor={colors.amber} message={note} /> : null}

      {/* Requests */}
      <ChipRow options={['Play something calmer', `More ${mix.data?.topGenre ?? genres[0]}`, 'Surprise me']} initial={-1} onChange={(i) => void request(i)} />

      {/* Up next */}
      <SectionHeader title="Up next" />
      <View style={{ marginTop: -8 }}>
        {mix.loading && !mix.data ? (
          <Loading label="Building your mix" />
        ) : mix.error ? (
          <ErrorState message={mix.error} onRetry={mix.reload} />
        ) : !upNext.length ? (
          <EmptyState title="Queue is empty" body="Start the DJ to line up a fresh mix." />
        ) : (
          upNext.map((t, i) => (
            <TrackItem
              key={t.id}
              track={t}
              list={djOn ? player.queue : mix.data?.tracks}
              context={DJ}
              showDuration={false}
              right={i === 0 ? <Sticker label="NEXT" rotate={3} style={{ alignSelf: 'center' }} /> : undefined}
            />
          ))
        )}
      </View>

      <View style={{ gap: 6 }}>
        <T size={13} color={colors.textSecondary}>
          DJ talk
        </T>
        <Segmented
          options={TALK}
          initial={TALK.indexOf(talk)}
          onChange={(i) => {
            const next = TALK[i];
            setTalk(next);
            if (next === 'Off') {
              speakToken.current++;
              void stopSpeaking();
              restoreVolume();
            }
          }}
        />
      </View>

      <Row>
        <Button label={djOn ? (player.playing ? 'Pause DJ' : 'Resume DJ') : 'Start DJ'} icon={djOn && player.playing ? 'pause' : 'play'} style={{ flex: 1 }} onPress={() => (djOn ? player.toggle() : start())} />
        <Button label="Ask the DJ" icon="mic" variant="glass" style={{ flex: 1 }} onPress={() => setNote('Talking to the DJ needs speech recognition, which this app build does not include yet. Use the request chips above.')} />
      </Row>
    </Screen>
  );
}
