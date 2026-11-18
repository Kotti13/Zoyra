// mood-from-photo: Claude vision → one of the app's moods. The image is never stored.
// POST { imageBase64, mediaType } → { mood, confidence, reason }
import { askClaude, ClaudeError, parseJsonObject } from '../_shared/anthropic.ts';
import { error, errMessage, json, notConfigured, preflight, readJson, requireUser } from '../_shared/http.ts';

const MOODS = ['Chill', 'Focus', 'Workout', 'Sleep', 'Happy', 'Party', 'Sad', 'Romantic'] as const;
type Mood = (typeof MOODS)[number];
const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_BASE64 = 7_000_000; // ~5 MB decoded, the API's per-image limit

const SYSTEM = `You pick a music mood that fits a photo. Allowed moods: ${MOODS.join(', ')}.
Reply with ONE JSON object and nothing else: {"mood": one of the allowed moods, "confidence": number 0-1, "reason": string (max 20 words, describes the scene's vibe, never identifies people)}.`;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return error(405, 'method_not_allowed');

  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return notConfigured('anthropic');

  const body = await readJson(req);
  const data = typeof body?.imageBase64 === 'string' ? body.imageBase64.replace(/^data:[^,]+,/, '').replace(/\s/g, '') : '';
  const mediaType = typeof body?.mediaType === 'string' && MEDIA_TYPES.includes(body.mediaType) ? body.mediaType : 'image/jpeg';
  if (!data) return error(400, 'invalid_body', { message: 'imageBase64 is required' });
  if (data.length > MAX_BASE64) return error(413, 'image_too_large', { message: 'Use an image under 5 MB' });

  try {
    const reply = await askClaude({
      apiKey,
      system: SYSTEM,
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
        { type: 'text', text: 'Which mood fits this photo?' },
      ],
      maxTokens: 1000,
      effort: 'low',
    });
    const out = parseJsonObject(reply);
    const raw = typeof out?.mood === 'string' ? out.mood.trim().toLowerCase() : '';
    const mood: Mood | undefined = MOODS.find((m) => m.toLowerCase() === raw);
    if (!mood) return error(502, 'ai_failed', { message: 'Could not read a mood' });
    const c = typeof out?.confidence === 'number' && Number.isFinite(out.confidence) ? out.confidence : 0.5;
    const reason = typeof out?.reason === 'string' ? out.reason.trim().slice(0, 200) : '';
    return json({ mood, confidence: Math.min(1, Math.max(0, c)), reason });
  } catch (e) {
    return error(e instanceof ClaudeError && e.status === 422 ? 422 : 502, 'ai_failed', { message: errMessage(e) });
  }
});
