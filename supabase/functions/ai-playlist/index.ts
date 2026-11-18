// ai-playlist: prompt → Claude plan → Audius catalogue search → curated track ids.
// POST { prompt, length: 10|20|40, exclude?: string[] } → { title, description, trackIds }
import { askClaude, ClaudeError, parseJsonObject, stringArray } from '../_shared/anthropic.ts';
import { type AudiusTrack, isPlayable, searchTracks, trendingTracks } from '../_shared/audius.ts';
import { error, errMessage, json, notConfigured, preflight, readJson, requireUser } from '../_shared/http.ts';

const LENGTHS = [10, 20, 40] as const;
const MAX_PER_ARTIST = 2;

const SYSTEM = `You plan music playlists for Zoyra, an app whose catalogue is Audius (independent and electronic-leaning artists, hip-hop, lo-fi, pop, etc.).
Reply with ONE JSON object and nothing else — no prose, no code fences. Shape:
{"title": string (max 40 chars), "description": string (max 140 chars), "searches": string[] (6-12 short catalogue search queries: artist names, sub-genres, or 1-3 descriptive keywords; no full sentences), "genres": string[] (1-4 from: Electronic, Hip-Hop/Rap, Alternative, Ambient, Lo-Fi, Pop, R&B/Soul, Rock, House, Techno, Trap, Dubstep, Drum & Bass, Deep House, Jazz, Classical, Acoustic, Folk, Country, Latin, Reggae, Metal, Funk, Soundtrack, Experimental, World), "moods": string[] (1-3 from: Peaceful, Romantic, Sentimental, Tender, Easygoing, Yearning, Sophisticated, Sensual, Cool, Gritty, Melancholy, Serious, Brooding, Fiery, Defiant, Aggressive, Rowdy, Excited, Energizing, Empowering, Stirring, Upbeat, Other)}`;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return error(405, 'method_not_allowed');

  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return notConfigured('anthropic');

  const body = await readJson(req);
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim().slice(0, 500) : '';
  const length = LENGTHS.find((l) => l === body?.length) ?? 20;
  const exclude = new Set(stringArray(body?.exclude, 1000));
  if (!prompt) return error(400, 'invalid_body', { message: 'prompt is required' });

  let plan: Record<string, unknown> | null;
  try {
    const reply = await askClaude({
      apiKey,
      system: SYSTEM,
      content: [{ type: 'text', text: `Playlist request (${length} songs): ${prompt}` }],
      maxTokens: 2000,
      effort: 'low',
    });
    plan = parseJsonObject(reply);
  } catch (e) {
    return error(e instanceof ClaudeError && e.status === 422 ? 422 : 502, 'ai_failed', { message: errMessage(e) });
  }
  if (!plan) return error(502, 'ai_failed', { message: 'Could not read the playlist plan' });

  const title = typeof plan.title === 'string' && plan.title.trim() ? plan.title.trim().slice(0, 60) : prompt.slice(0, 40);
  const description = typeof plan.description === 'string' ? plan.description.trim().slice(0, 200) : '';
  const searches = stringArray(plan.searches, 12);
  const genres = stringArray(plan.genres, 4);
  const moods = new Set(stringArray(plan.moods, 3).map((m) => m.toLowerCase()));
  if (searches.length === 0) searches.push(prompt.slice(0, 60));

  // Fetch everything in parallel; search hits first (in order), then genre trending as filler.
  const [searchResults, trendingResults] = await Promise.all([
    Promise.all(searches.map(searchTracks)),
    Promise.all(genres.map(trendingTracks)),
  ]);

  // Round-robin across queries so one query can't dominate the list.
  const interleave = (lists: AudiusTrack[][]): AudiusTrack[] => {
    const out: AudiusTrack[] = [];
    const max = Math.max(0, ...lists.map((l) => l.length));
    for (let i = 0; i < max; i++) for (const l of lists) if (l[i]) out.push(l[i]);
    return out;
  };
  const primary = interleave(searchResults);
  // Within trending filler, prefer the planned moods.
  const filler = interleave(trendingResults).sort(
    (a, b) => Number(moods.has((b.mood ?? '').toLowerCase())) - Number(moods.has((a.mood ?? '').toLowerCase())),
  );

  const seen = new Set<string>();
  const perArtist = new Map<string, number>();
  const trackIds: string[] = [];
  for (const t of [...primary, ...filler]) {
    if (trackIds.length >= length) break;
    if (!t?.id || seen.has(t.id) || exclude.has(t.id) || !isPlayable(t)) continue;
    seen.add(t.id);
    const artist = t.user?.id ?? t.user?.name ?? '';
    const count = perArtist.get(artist) ?? 0;
    if (count >= MAX_PER_ARTIST) continue;
    perArtist.set(artist, count + 1);
    trackIds.push(t.id);
  }

  if (trackIds.length === 0) return error(404, 'no_tracks', { message: 'No playable songs matched that prompt' });
  return json({ title, description, trackIds });
});
