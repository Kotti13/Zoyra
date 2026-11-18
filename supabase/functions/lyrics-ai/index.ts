// lyrics-ai: translate or romanize lyric lines, keeping line count and order identical so synced
// timing still lines up. Results are cached in public.lyrics_cache (service role writes only).
// POST { lines: string[], mode: 'translate' | 'romanize', target?: string, trackId?: string }
//   → { lines: string[], cached: boolean }
import { askClaude, ClaudeError, parseJsonObject } from '../_shared/anthropic.ts';
import { adminClient, error, errMessage, json, notConfigured, preflight, readJson, requireUser } from '../_shared/http.ts';

const MAX_LINES = 300;
const MAX_LINE_CHARS = 300;

type Mode = 'translate' | 'romanize';

const systemFor = (mode: Mode, target: string) =>
  mode === 'translate'
    ? `You translate song lyrics into ${target}. You receive a JSON array of lyric lines.
Translate each line on its own, naturally and faithfully, keeping the tone. Do not merge, split, drop, reorder or add lines.
If a line is already in ${target}, return it unchanged. Keep names, ad-libs and vocalisations (oh, yeah, la la) as they are.
Reply with ONE JSON object and nothing else: {"lines": string[]} with exactly the same number of items as the input, in the same order.`
    : `You romanize song lyrics: transliterate each line into the Latin alphabet as it is pronounced (for example Hepburn for Japanese,
Revised Romanization for Korean, Pinyin with tone marks for Chinese, ISO-15919-style plain ASCII for Indic scripts, common
transliteration for others). Do NOT translate. Lines already in the Latin alphabet stay unchanged.
Do not merge, split, drop, reorder or add lines.
Reply with ONE JSON object and nothing else: {"lines": string[]} with exactly the same number of items as the input, in the same order.`;

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Exactly `n` strings from the model reply, or null when the shape is wrong. */
function readLines(reply: string, n: number): string[] | null {
  const v = parseJsonObject(reply)?.lines;
  if (!Array.isArray(v) || v.length !== n) return null;
  if (!v.every((x) => typeof x === 'string')) return null;
  return (v as string[]).map((x) => x.replace(/\s+/g, ' ').trim().slice(0, MAX_LINE_CHARS * 2));
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return error(405, 'method_not_allowed');

  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const body = await readJson(req);
  const mode: Mode | null = body?.mode === 'translate' || body?.mode === 'romanize' ? body.mode : null;
  if (!mode) return error(400, 'invalid_body', { message: "mode must be 'translate' or 'romanize'" });
  if (!Array.isArray(body?.lines) || body.lines.length === 0) return error(400, 'invalid_body', { message: 'lines is required' });
  if (body.lines.length > MAX_LINES) return error(400, 'invalid_body', { message: `at most ${MAX_LINES} lines` });
  const lines: string[] = body.lines.map((l: unknown) => (typeof l === 'string' ? l.slice(0, MAX_LINE_CHARS) : ''));

  const rawTarget = typeof body?.target === 'string' ? body.target.replace(/[^\p{L} ()-]/gu, '').trim().slice(0, 40) : '';
  const target = mode === 'translate' ? rawTarget || 'English' : '';
  const trackId = typeof body?.trackId === 'string' ? body.trackId.trim().slice(0, 100) : '';

  // Only non-empty lines go to the model; empty ones (instrumental breaks) keep their slot.
  const idx: number[] = [];
  lines.forEach((l, i) => l.trim() && idx.push(i));
  if (idx.length === 0) return json({ lines, cached: false });

  const admin = adminClient();
  const hash = await sha256(JSON.stringify(lines));
  if (admin && trackId) {
    const { data } = await admin
      .from('lyrics_cache')
      .select('lines')
      .match({ track_id: trackId, mode, target, source_hash: hash })
      .maybeSingle();
    const hit: unknown = data?.lines;
    if (Array.isArray(hit) && hit.length === lines.length && hit.every((x) => typeof x === 'string')) {
      return json({ lines: hit, cached: true });
    }
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return notConfigured('anthropic');

  const input = idx.map((i) => lines[i].trim());
  try {
    let out: string[] | null = null;
    for (let attempt = 0; attempt < 2 && !out; attempt++) {
      const reply = await askClaude({
        apiKey,
        system: systemFor(mode, target),
        content: [{ type: 'text', text: `Input (${input.length} lines):\n${JSON.stringify(input)}` }],
        maxTokens: Math.min(16000, 400 + input.length * 60),
        effort: 'low',
      });
      out = readLines(reply, input.length);
    }
    if (!out) return error(502, 'ai_failed', { message: 'The lyrics came back with a different number of lines' });

    const result = [...lines];
    idx.forEach((i, k) => (result[i] = out![k] || lines[i]));

    if (admin && trackId) {
      // A cache write failure is reported in `error` (not thrown) and never blocks the answer.
      await admin
        .from('lyrics_cache')
        .upsert({ track_id: trackId, mode, target, source_hash: hash, lines: result }, { onConflict: 'track_id,mode,target,source_hash' });
    }
    return json({ lines: result, cached: false });
  } catch (e) {
    return error(e instanceof ClaudeError && e.status === 422 ? 422 : 502, 'ai_failed', { message: errMessage(e) });
  }
});
