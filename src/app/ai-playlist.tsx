import { router } from 'expo-router';
import { useState } from 'react';
import { TextInput, View } from 'react-native';

import {
  Button,
  ChipRow,
  Cover,
  EmptyState,
  Glass,
  IconButton,
  ListRow,
  Loading,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  Segmented,
  Sticker,
  T,
  Toast,
  Toggle,
} from '../components';
import { aiPlaylist } from '../lib/ai';
import { GENRES, MOOD_MAP, catalog, type CatalogTrack } from '../lib/catalog';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { colors, fonts } from '../theme/tokens';

const ideas = ['Late night drive', 'Gym push', 'Study focus', 'Rainy day lo-fi'];
const lengths = [10, 20, 40];
const MAX = 200;

/* ------------------------------------------------------------------ deterministic "smart mix" generator */

const GENRE_SYNONYMS: Record<string, string[]> = {
  Electronic: ['electronic', 'edm', 'electro', 'synth'],
  'Hip-Hop/Rap': ['hip hop', 'hip-hop', 'hiphop', 'rap', 'trap'],
  Pop: ['pop'],
  'Lo-Fi': ['lofi', 'lo-fi', 'lo fi', 'chillhop'],
  'R&B/Soul': ['r&b', 'rnb', 'soul'],
  Alternative: ['alternative', 'alt', 'indie'],
  Ambient: ['ambient', 'atmospheric', 'drone'],
  House: ['house', 'deep house'],
  Rock: ['rock', 'guitar', 'punk'],
  Jazz: ['jazz', 'swing'],
  Classical: ['classical', 'piano', 'orchestral', 'strings'],
  World: ['world', 'afro', 'global'],
  Acoustic: ['acoustic', 'unplugged'],
  Latin: ['latin', 'reggaeton', 'salsa'],
  Techno: ['techno', 'rave'],
  Folk: ['folk', 'country'],
};

const MOOD_SYNONYMS: Record<string, string[]> = {
  Chill: ['chill', 'calm', 'relax', 'soft', 'rainy', 'rain', 'sunday', 'mellow', 'cozy', 'slow'],
  Focus: ['focus', 'study', 'work', 'concentrate', 'reading', 'coding'],
  Workout: ['workout', 'gym', 'run', 'running', 'push', 'lift', 'training', 'cardio'],
  Sleep: ['sleep', 'bedtime', 'dream', 'night', 'late'],
  Happy: ['happy', 'sunny', 'joy', 'good vibes', 'road trip', 'summer'],
  Party: ['party', 'dance', 'club', 'hype', 'drive'],
  Sad: ['sad', 'heartbreak', 'cry', 'lonely', 'melancholy', 'breakup'],
  Romantic: ['love', 'romantic', 'romance', 'date', 'valentine'],
};

const STOP = new Set(
  'a an and the of for to in on at with no not but or my me i some something songs song music playlist mix like feel feeling vibe vibes very more less heavy light'.split(' '),
);

const has = (text: string, word: string) => new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\&-]/g, '\\$&')}([^a-z]|$)`).test(text);

function parsePrompt(prompt: string) {
  const text = prompt.toLowerCase();
  const genres: string[] = GENRES.filter((g) => [g.toLowerCase(), ...(GENRE_SYNONYMS[g] ?? [])].some((w) => has(text, w)));
  const moods = Object.keys(MOOD_MAP).filter((m) => [m.toLowerCase(), ...(MOOD_SYNONYMS[m] ?? [])].some((w) => has(text, w)));
  const matched = new Set([...genres.flatMap((g) => GENRE_SYNONYMS[g] ?? []), ...moods.flatMap((m) => MOOD_SYNONYMS[m] ?? [])]);
  const words = text
    .replace(/[^a-z0-9&\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !matched.has(w));
  // Negations like "no heavy drums" → avoid those words in titles/tags.
  const avoid = [...text.matchAll(/\bno\s+(?:heavy\s+)?([a-z]+)/g)].map((m) => m[1]);
  return { genres, moods, words: words.filter((w) => !avoid.includes(w)).slice(0, 4), avoid };
}

function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10_000) / 10_000;
  };
}
const hash = (str: string) => [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

function titleFor(prompt: string, genres: string[], moods: string[]) {
  const parts = [moods[0], genres[0]].filter(Boolean);
  if (parts.length) return `${parts.join(' ')} mix`;
  const w = prompt.trim().split(/\s+/).slice(0, 4).join(' ');
  return w ? w.replace(/(^|\s)\S/g, (c) => c.toUpperCase()).replace(/[.,!?]+$/, '') : 'Smart mix';
}

type Source = 'ai' | 'smart';
type Generated = { title: string; tracks: CatalogTrack[]; pool: CatalogTrack[]; summary: string; source: Source; fallbackReason?: string };

async function generate(prompt: string, size: number, opts: { newMusic: boolean; explicit: boolean; seed: number }): Promise<Generated> {
  const { genres, moods, words, avoid } = parsePrompt(prompt);
  const sources: Promise<CatalogTrack[]>[] = [
    ...genres.map((g) => catalog.trending({ genre: g, limit: 40 })),
    ...moods.map((m) => catalog.byMood(m, 40)),
  ];
  if (words.length) sources.push(catalog.searchTracks(words.join(' '), { genre: genres.length === 1 ? genres[0] : undefined, limit: 40 }));
  if (opts.newMusic) sources.push(catalog.underground(30));
  if (!genres.length && !moods.length && !words.length) sources.push(catalog.trending({ limit: 50 }));

  const lists = (await Promise.all(sources.map((p) => p.catch(() => [] as CatalogTrack[])))).filter((l) => l.length);
  if (!lists.length) throw new Error('No matching songs found. Try different words, a genre or a mood.');

  const rnd = seeded(hash(prompt) + opts.seed * 7919);
  const shuffled = lists.map((l) => [...l].sort(() => rnd() - 0.5));
  const bad = (t: CatalogTrack) => {
    const hay = `${t.title} ${(t.tags ?? []).join(' ')}`.toLowerCase();
    if (!opts.explicit && /explicit|nsfw/.test(hay)) return true;
    return avoid.some((a) => hay.includes(a));
  };
  // Prefer tracks matching a requested genre when the source is mood/search based.
  const fit = (t: CatalogTrack) => !genres.length || (t.genre ? genres.includes(t.genre) : false);

  const pool: CatalogTrack[] = [];
  const seen = new Set<string>();
  const perArtist = new Map<string, number>();
  for (let i = 0; shuffled.some((l) => i < l.length); i++) {
    for (const l of shuffled) {
      const t = l[i];
      if (!t || seen.has(t.id) || bad(t)) continue;
      seen.add(t.id);
      pool.push(t);
    }
  }
  pool.sort((a, b) => Number(fit(b)) - Number(fit(a)));
  const tracks: CatalogTrack[] = [];
  const rest: CatalogTrack[] = [];
  for (const t of pool) {
    const n = perArtist.get(t.artist.id) ?? 0;
    if (tracks.length < size && n < 2) {
      tracks.push(t);
      perArtist.set(t.artist.id, n + 1);
    } else rest.push(t);
  }
  while (tracks.length < size && rest.length) tracks.push(rest.shift() as CatalogTrack);

  const matched = [...moods, ...genres].join(', ');
  return {
    source: 'smart',
    title: titleFor(prompt, genres, moods),
    tracks,
    pool: rest,
    summary: matched ? `Matched: ${matched}${words.length ? ` + "${words.join(' ')}"` : ''}` : words.length ? `Matched words: "${words.join(' ')}"` : 'Trending picks',
  };
}

/** Ask the server AI first; on any failure use the local smart mix and say why. */
async function generateWithAi(prompt: string, size: number, opts: { newMusic: boolean; explicit: boolean; seed: number; exclude: string[] }): Promise<Generated> {
  const ai = await aiPlaylist(prompt, size, opts.exclude);
  if (ai.ok) {
    const ids = [...new Set(ai.data.trackIds)].filter((id) => !opts.exclude.includes(id));
    const settled = await Promise.allSettled(ids.map((id) => catalog.track(id)));
    const tracks = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (tracks.length) {
      // Keep a local pool around so the per-song swap button still works.
      const local = await generate(prompt, size, opts).catch(() => null);
      const have = new Set(tracks.map((t) => t.id));
      return {
        source: 'ai',
        title: ai.data.title || titleFor(prompt, [], []),
        tracks: tracks.slice(0, size),
        pool: local ? [...local.tracks, ...local.pool].filter((t) => !have.has(t.id)) : [],
        summary: ai.data.description || 'Picked by AI from the catalogue',
      };
    }
  }
  const reason = ai.ok ? 'AI returned no playable songs' : ai.reason === 'not_configured' ? `AI needs ${ai.service} setup` : `AI unavailable: ${ai.message}`;
  const local = await generate(prompt, size, opts);
  return { ...local, fallbackReason: reason };
}

const totalTime = (l: CatalogTrack[]) => {
  const m = Math.round(l.reduce((s, t) => s + t.duration, 0) / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

/* ------------------------------------------------------------------ screen */

export default function AiPlaylist() {
  const { user } = useAuth();
  const { createPlaylist, addToPlaylist } = useLibrary();
  const { playTracks } = usePlayerPick();
  const [prompt, setPrompt] = useState('');
  const [newMusic, setNewMusic] = useState(true);
  const [explicit, setExplicit] = useState(false);
  const [size, setSize] = useState(20);
  const [seed, setSeed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Generated | null>(null);
  const [usedPrompt, setUsedPrompt] = useState('');

  const run = async (nextSeed: number) => {
    const p = prompt.trim();
    if (!p) return setError('Describe a mood, moment or genre first.');
    setBusy(true);
    setError(null);
    try {
      // On regenerate, ask the AI for different songs than the ones on screen.
      const exclude = nextSeed > 0 && result ? result.tracks.map((t) => t.id) : [];
      setResult(await generateWithAi(p, size, { newMusic, explicit, seed: nextSeed, exclude }));
      setUsedPrompt(p);
      setSeed(nextSeed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build that mix');
    } finally {
      setBusy(false);
    }
  };

  const swap = (id: string) =>
    setResult((r) => {
      if (!r || !r.pool.length) return r;
      const [next, ...pool] = r.pool;
      return { ...r, pool, tracks: r.tracks.map((t) => (t.id === id ? next : t)) };
    });

  const save = async () => {
    if (!result) return;
    if (!user) return setError('Sign in to save playlists.');
    setSaving(true);
    setError(null);
    try {
      const pl = await createPlaylist({ title: result.title.slice(0, 100), description: usedPrompt, is_ai: result.source === 'ai', ai_prompt: usedPrompt, visibility: 'private' });
      await addToPlaylist(pl.id, result.tracks);
      router.push({ pathname: '/playlist', params: { id: pl.id } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the playlist');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'grid', mesh: 'coral' }}>
      <ScreenHeader title="AI playlist" />

      <View style={{ gap: 8 }}>
        <T size={26} weight={700} tracking={-0.5} lineHeight={30} accessibilityRole="header">
          Describe your playlist
        </T>
        <T size={16} lineHeight={23} color={colors.textSecondary}>
          Zoyra's AI picks songs for your idea. If AI is unavailable, you get a smart mix built from the genres, moods and words you use.
        </T>
      </View>

      <Glass radius={36} padding={16} style={{ gap: 12 }}>
        <TextInput
          accessibilityLabel="Playlist idea"
          multiline
          maxLength={MAX}
          value={prompt}
          onChangeText={setPrompt}
          placeholder="A rainy Sunday morning. Soft lo-fi and indie, no heavy drums."
          placeholderTextColor={colors.textTertiary}
          style={{ height: 84, color: colors.text, fontFamily: fonts.regular, fontSize: 17, lineHeight: 24, textAlignVertical: 'top', padding: 0 }}
        />
        <Row style={{ justifyContent: 'space-between' }}>
          <T mono size={12} color={colors.textSecondary}>
            {prompt.length} / {MAX}
          </T>
          <Sticker label={result?.source === 'ai' ? 'AI' : result ? 'SMART MIX' : 'AI'} bg={colors.like} rotate={4} />
        </Row>
      </Glass>

      <ChipRow wrap options={ideas} initial={-1} onChange={(i) => setPrompt(ideas[i])} />

      <Segmented options={lengths.map((n) => `${n} songs`)} initial={1} onChange={(i) => setSize(lengths[i])} />

      <Glass radius={26} padding={4}>
        <ListRow minHeight={56} title="Include new music" subtitle="Mix in fresh underground picks" right={<Toggle label="New music" value={newMusic} onChange={setNewMusic} />} />
        <ListRow minHeight={56} divider title="Explicit songs" subtitle="Skips tracks tagged explicit when off" right={<Toggle label="Explicit" value={explicit} onChange={setExplicit} />} />
      </Glass>

      <Button label={busy ? 'Building…' : 'Generate playlist'} icon="bolt" variant={busy ? 'disabled' : 'primary'} onPress={() => void run(0)} />

      {error ? <Toast icon="info" iconColor={colors.error} message={error} /> : null}

      {busy && !result ? <Loading label="Building your mix" /> : null}

      {result ? (
        <>
          <SectionHeader title="Result" />
          <Glass radius={26} padding={16}>
            <Row>
              <Cover artwork={result.tracks[0]?.artwork} id={result.title} size={64} radius={22} />
              <View style={{ flex: 1, gap: 2 }}>
                <T size={17} weight={700} numberOfLines={1}>
                  {result.title}
                </T>
                <T size={13} color={colors.textSecondary}>
                  {result.tracks.length} songs · {totalTime(result.tracks)}
                </T>
                <T size={12} color={colors.textTertiary} numberOfLines={2}>
                  {result.source === 'ai' ? 'AI' : 'Smart mix'} · {result.summary}
                </T>
                {result.fallbackReason ? (
                  <T size={12} color={colors.amber} numberOfLines={2}>
                    {result.fallbackReason}
                  </T>
                ) : null}
              </View>
              <IconButton icon="shuffle" label="Regenerate" onPress={() => void run(seed + 1)} />
            </Row>
            {busy ? (
              <Loading height={80} />
            ) : (
              result.tracks.map((s, i) => (
                <Row key={s.id} style={{ minHeight: 56, borderTopWidth: 1, borderTopColor: colors.divider }}>
                  <Cover artwork={s.artwork} id={s.id} size={40} radius={20} />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <T size={16} weight={500} numberOfLines={1} onPress={() => playTracks(result.tracks, i, result.title)}>
                      {s.title}
                    </T>
                    <T size={14} color={colors.textSecondary} numberOfLines={1}>
                      {s.artist.name}
                    </T>
                  </View>
                  <IconButton
                    icon="shuffle"
                    label={`Swap ${s.title}`}
                    iconSize={18}
                    color={result.pool.length ? colors.textSecondary : colors.textTertiary}
                    onPress={() => swap(s.id)}
                  />
                </Row>
              ))
            )}
            <Row style={{ marginTop: 8 }}>
              <Button label="Preview" variant="glass" style={{ flex: 1 }} onPress={() => playTracks(result.tracks, 0, result.title)} />
              <Button label={saving ? 'Saving…' : 'Save playlist'} variant={saving ? 'disabled' : 'primary'} style={{ flex: 1 }} onPress={() => void save()} />
            </Row>
          </Glass>
        </>
      ) : !busy && error ? null : !busy ? (
        <EmptyState icon="music" title="Your mix will appear here" body="Mention a genre (lo-fi, jazz, house) or a mood (chill, focus, party)." />
      ) : null}
    </Screen>
  );
}
