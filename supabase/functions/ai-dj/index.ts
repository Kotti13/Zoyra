// ai-dj: short upbeat DJ intros for upcoming tracks (the app speaks them with expo-speech).
// POST { tracks: {title, artist, genre?}[], userName?, mood? } → { lines: string[] }
import { askClaude, ClaudeError, parseJsonObject, stringArray } from '../_shared/anthropic.ts';
import { error, errMessage, json, notConfigured, preflight, readJson, requireUser } from '../_shared/http.ts';

const MAX_TRACKS = 5;
const MAX_WORDS = 25;

type InTrack = { title: string; artist: string; genre?: string };

const SYSTEM = `You are "Zoyra DJ", a warm, upbeat radio DJ. For each upcoming track write ONE spoken intro line.
Rules: at most ${MAX_WORDS} words per line; plain speakable text (no emojis, hashtags, stage directions, or quotation marks around the whole line); mention the song title and artist; vary the openings; never invent facts about the artist.
Reply with ONE JSON object and nothing else: {"lines": string[]} — exactly one line per track, in the same order.`;

const clampWords = (s: string): string => {
  const words = s.replace(/\s+/g, ' ').trim().split(' ');
  return words.length <= MAX_WORDS ? words.join(' ') : `${words.slice(0, MAX_WORDS).join(' ').replace(/[,;:]$/, '')}.`;
};

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return error(405, 'method_not_allowed');

  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return notConfigured('anthropic');

  const body = await readJson(req);
  const tracks: InTrack[] = (Array.isArray(body?.tracks) ? body.tracks : [])
    .filter((t: unknown): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t: Record<string, unknown>) => ({
      title: typeof t.title === 'string' ? t.title.slice(0, 120) : '',
      artist: typeof t.artist === 'string' ? t.artist.slice(0, 80) : '',
      genre: typeof t.genre === 'string' ? t.genre.slice(0, 40) : undefined,
    }))
    .filter((t: InTrack) => t.title && t.artist)
    .slice(0, MAX_TRACKS);
  if (tracks.length === 0) return error(400, 'invalid_body', { message: 'tracks is required' });

  const userName = typeof body?.userName === 'string' ? body.userName.trim().slice(0, 40) : '';
  const mood = typeof body?.mood === 'string' ? body.mood.trim().slice(0, 40) : '';
  const list = tracks.map((t, i) => `${i + 1}. "${t.title}" by ${t.artist}${t.genre ? ` (${t.genre})` : ''}`).join('\n');
  const context = [userName && `Listener's name: ${userName} (use it at most once).`, mood && `Current mood: ${mood}.`]
    .filter(Boolean)
    .join(' ');

  try {
    const reply = await askClaude({
      apiKey,
      system: SYSTEM,
      content: [{ type: 'text', text: `${context}\nUpcoming tracks:\n${list}` }],
      maxTokens: 1500,
      effort: 'low',
    });
    const lines = stringArray(parseJsonObject(reply)?.lines, MAX_TRACKS).map(clampWords);
    if (lines.length === 0) return error(502, 'ai_failed', { message: 'Could not read the DJ script' });
    return json({ lines });
  } catch (e) {
    return error(e instanceof ClaudeError && e.status === 422 ? 422 : 502, 'ai_failed', { message: errMessage(e) });
  }
});
