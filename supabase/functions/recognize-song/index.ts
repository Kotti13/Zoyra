// recognize-song: ACRCloud identify (HMAC-SHA1 signed). The audio is never stored.
// POST { audioBase64, mimeType, mode?: 'listen' | 'hum' } → { match: { title, artist, album?, isrc?, offsetMs?, score? } | null }
// 'hum' (hum / sing) uses a separate ACRCloud humming project: ACRCLOUD_HUM_HOST / _ACCESS_KEY / _ACCESS_SECRET.
import { error, errMessage, json, notConfigured, preflight, readJson, requireUser } from '../_shared/http.ts';

const MAX_BYTES = 5 * 1024 * 1024; // ACRCloud recommends <= 5 MB / ~10-15 s of audio

type AcrMusic = {
  title?: string;
  score?: number;
  play_offset_ms?: number;
  artists?: { name?: string }[];
  album?: { name?: string };
  external_ids?: { isrc?: string | string[] };
};
type AcrResponse = { status?: { code?: number; msg?: string }; metadata?: { music?: AcrMusic[] } };

function encodeBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64); // throws on invalid input
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return encodeBase64(new Uint8Array(sig));
}

const extFor = (mime: string): string =>
  mime.includes('wav') ? 'wav' : mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : mime.includes('aac') ? 'aac' : mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : 'm4a';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return error(405, 'method_not_allowed');

  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const body = await readJson(req);
  const hum = body?.mode === 'hum';
  const prefix = hum ? 'ACRCLOUD_HUM_' : 'ACRCLOUD_';
  const host = Deno.env.get(`${prefix}HOST`)?.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const accessKey = Deno.env.get(`${prefix}ACCESS_KEY`);
  const accessSecret = Deno.env.get(`${prefix}ACCESS_SECRET`);
  if (!host || !accessKey || !accessSecret) return notConfigured(hum ? 'ACRCloud humming' : 'acrcloud');
  const b64 = typeof body?.audioBase64 === 'string' ? body.audioBase64.replace(/^data:[^,]+,/, '').replace(/\s/g, '') : '';
  const mimeType = typeof body?.mimeType === 'string' ? body.mimeType : 'audio/mp4';
  if (!b64) return error(400, 'invalid_body', { message: 'audioBase64 is required' });

  let audio: Uint8Array<ArrayBuffer>;
  try {
    audio = decodeBase64(b64);
  } catch {
    return error(400, 'invalid_body', { message: 'audioBase64 is not valid base64' });
  }
  if (audio.byteLength > MAX_BYTES) return error(413, 'audio_too_large', { message: 'Record a shorter clip (about 10 seconds)' });

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const dataType = 'audio';
  const signatureVersion = '1';
  const stringToSign = ['POST', '/v1/identify', accessKey, dataType, signatureVersion, timestamp].join('\n');

  try {
    const signature = await hmacSha1Base64(accessSecret, stringToSign);
    const form = new FormData();
    form.append('sample', new Blob([audio], { type: mimeType }), `sample.${extFor(mimeType)}`);
    form.append('sample_bytes', String(audio.byteLength));
    form.append('access_key', accessKey);
    form.append('data_type', dataType);
    form.append('signature_version', signatureVersion);
    form.append('signature', signature);
    form.append('timestamp', timestamp);

    const res = await fetch(`https://${host}/v1/identify`, { method: 'POST', body: form });
    if (!res.ok) return error(502, 'recognition_failed', { message: `ACRCloud request failed (${res.status})` });
    const data = (await res.json()) as AcrResponse;
    const code = data.status?.code;
    if (code === 1001) return json({ match: null }); // no result
    if (code !== 0) return error(502, 'recognition_failed', { message: data.status?.msg ?? `ACRCloud error ${code}` });

    const m = data.metadata?.music?.[0];
    if (!m?.title) return json({ match: null });
    const isrcRaw = m.external_ids?.isrc;
    const isrc = Array.isArray(isrcRaw) ? isrcRaw[0] : isrcRaw;
    const artist = (m.artists ?? []).map((a) => a.name).filter((n): n is string => !!n).join(', ');
    return json({
      match: {
        title: m.title,
        artist: artist || 'Unknown artist',
        ...(m.album?.name ? { album: m.album.name } : {}),
        ...(isrc ? { isrc } : {}),
        ...(typeof m.play_offset_ms === 'number' && m.play_offset_ms >= 0 ? { offsetMs: Math.round(m.play_offset_ms) } : {}),
        ...(typeof m.score === 'number' ? { score: m.score } : {}),
      },
    });
  } catch (e) {
    return error(502, 'recognition_failed', { message: errMessage(e) });
  }
});
