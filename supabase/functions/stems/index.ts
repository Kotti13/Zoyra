// stems: vocal remover / stem studio via a third-party stem-separation API.
//
// Secrets: STEMS_API_URL, STEMS_API_KEY. Missing → 503 { error: 'not_configured', service: 'stem separation' }.
//
// POST { action: 'start', mode: 'vocals' | 'stems', source }
//   source = { kind: 'audius', trackId }                                  (server fetches + checks rights)
//          | { kind: 'upload', audioBase64, mimeType, name, rightsConfirmed: true }  (the user's own file)
// POST { action: 'status', jobId }
// → { status: 'queued' | 'processing' | 'done' | 'failed', jobId?, stems: [{ name, url }], error? }
//
// Provider contract (point STEMS_API_URL at the provider or a thin adapter):
//   POST {STEMS_API_URL}            multipart: audio (file), stems ('2' = vocals + accompaniment, '4' = vocals/drums/bass/other)
//                                   header Authorization: Bearer {STEMS_API_KEY}
//     → { stems: [{ name, url }] }  (finished)  or  { id, status }  (async job)
//   GET  {STEMS_API_URL}/{id}       → { status, stems?, error? }
//
// Legal guardrail: only the caller's own uploaded files (they must confirm the rights) or Audius
// tracks the artist made freely downloadable or published under a Creative Commons licence that
// allows derivatives. Everything else is refused with 403 `not_allowed`. Audio is never stored here.
import { error, errMessage, json, notConfigured, preflight, readJson, requireUser } from '../_shared/http.ts';

const AUDIUS = 'https://api.audius.co/v1';
const APP = 'zoyra';
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_AUDIUS_BYTES = 60 * 1024 * 1024;
const SERVICE = 'stem separation';

type Stem = { name: string; url: string };
type Status = 'queued' | 'processing' | 'done' | 'failed';

type AudiusRights = {
  id?: string;
  title?: string;
  is_downloadable?: boolean;
  is_download_gated?: boolean;
  download_conditions?: unknown;
  is_stream_gated?: boolean;
  stream_conditions?: unknown;
  is_delete?: boolean;
  license?: string | null;
};

const ccAllowsRemix = (license: string | null | undefined): boolean => {
  if (!license) return false;
  const l = license.toLowerCase();
  if (!l.includes('cc') && !l.includes('attribution') && !l.includes('creative commons')) return false;
  return !/no ?deriv|\bnd\b|-nd\b/.test(l);
};

/** 'download' = artist offers a free download, 'cc' = CC licence allowing derivatives, else the refusal reason. */
function audiusBasis(t: AudiusRights): { ok: true; via: 'download' | 'cc' } | { ok: false; reason: string } {
  if (t.is_delete) return { ok: false, reason: 'Track was removed by the artist.' };
  if (t.is_stream_gated || t.stream_conditions) return { ok: false, reason: 'Track is gated.' };
  if (t.is_downloadable && !t.is_download_gated && !t.download_conditions) return { ok: true, via: 'download' };
  if (ccAllowsRemix(t.license)) return { ok: true, via: 'cc' };
  return { ok: false, reason: 'The artist has not made this track downloadable or remixable.' };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const extFor = (mime: string): string =>
  mime.includes('wav') ? 'wav' : mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : mime.includes('flac') ? 'flac' : mime.includes('ogg') ? 'ogg' : mime.includes('aac') ? 'aac' : 'm4a';

/** Read a response body with a byte cap (avoids buffering huge files). */
async function readCapped(res: Response, cap: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const len = Number(res.headers.get('content-length') ?? '0');
  if (len > cap) return null;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

const normStatus = (s: unknown): Status => {
  const v = typeof s === 'string' ? s.toLowerCase() : '';
  if (['done', 'succeeded', 'success', 'completed', 'complete', 'finished'].includes(v)) return 'done';
  if (['failed', 'error', 'cancelled', 'canceled'].includes(v)) return 'failed';
  if (['processing', 'running', 'started', 'in_progress'].includes(v)) return 'processing';
  return 'queued';
};

/** Only https URLs come back to the app. */
const normStems = (v: unknown): Stem[] =>
  Array.isArray(v)
    ? v.flatMap((s) => (isObject(s) && typeof s.name === 'string' && typeof s.url === 'string' && /^https:\/\//i.test(s.url) ? [{ name: s.name, url: s.url }] : []))
    : isObject(v)
      ? Object.entries(v).flatMap(([name, url]) => (typeof url === 'string' && /^https:\/\//i.test(url) ? [{ name, url }] : []))
      : [];

function normJob(body: unknown) {
  if (!isObject(body)) return { status: 'failed' as Status, stems: [] as Stem[], error: 'Unexpected provider response' };
  const stems = normStems(body.stems);
  const jobId = typeof body.id === 'string' ? body.id : typeof body.job_id === 'string' ? body.job_id : undefined;
  const status: Status = stems.length && !body.status ? 'done' : normStatus(body.status);
  const err = typeof body.error === 'string' ? body.error : undefined;
  if (status === 'done' && !stems.length) return { status: 'failed' as Status, stems, jobId, error: 'The provider returned no stems' };
  return { status, stems, ...(jobId ? { jobId } : {}), ...(err ? { error: err } : {}) };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return error(405, 'method_not_allowed');

  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const apiUrl = Deno.env.get('STEMS_API_URL')?.replace(/\/+$/, '');
  const apiKey = Deno.env.get('STEMS_API_KEY');
  if (!apiUrl || !apiKey) return notConfigured(SERVICE);

  const body = await readJson(req);
  const action = body?.action;

  try {
    if (action === 'status') {
      const jobId = typeof body?.jobId === 'string' ? body.jobId : '';
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(jobId)) return error(400, 'invalid_body', { message: 'jobId is required' });
      const res = await fetch(`${apiUrl}/${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
      if (!res.ok) return error(502, 'provider_failed', { message: `Stem service error (${res.status})` });
      return json({ jobId, ...normJob(await res.json()) });
    }

    if (action !== 'start') return error(400, 'invalid_body', { message: "action must be 'start' or 'status'" });
    const mode = body?.mode === 'stems' ? 'stems' : body?.mode === 'vocals' ? 'vocals' : null;
    if (!mode) return error(400, 'invalid_body', { message: "mode must be 'vocals' or 'stems'" });
    const source = body && isObject(body.source) ? body.source : null;
    if (!source) return error(400, 'invalid_body', { message: 'source is required' });

    let audio: Uint8Array<ArrayBuffer>;
    let mimeType = 'audio/mpeg';
    let name = 'track';

    if (source.kind === 'upload') {
      if (source.rightsConfirmed !== true) return error(403, 'not_allowed', { message: 'Confirm you own this recording or have the rights to edit it.' });
      const b64 = typeof source.audioBase64 === 'string' ? source.audioBase64.replace(/^data:[^,]+,/, '').replace(/\s/g, '') : '';
      if (!b64) return error(400, 'invalid_body', { message: 'audioBase64 is required' });
      try {
        audio = decodeBase64(b64);
      } catch {
        return error(400, 'invalid_body', { message: 'audioBase64 is not valid base64' });
      }
      if (audio.byteLength > MAX_UPLOAD_BYTES) return error(413, 'audio_too_large', { message: 'Files up to 20 MB only' });
      if (typeof source.mimeType === 'string' && /^audio\/[a-z0-9.+-]+$/i.test(source.mimeType)) mimeType = source.mimeType;
      if (typeof source.name === 'string') name = source.name.slice(0, 80);
    } else if (source.kind === 'audius') {
      const trackId = typeof source.trackId === 'string' ? source.trackId : '';
      if (!/^[A-Za-z0-9]{1,32}$/.test(trackId)) return error(400, 'invalid_body', { message: 'trackId is required' });
      const meta = await fetch(`${AUDIUS}/tracks/${trackId}?app_name=${APP}`, { headers: { Accept: 'application/json' } });
      if (!meta.ok) return error(meta.status === 404 ? 404 : 502, 'track_unavailable', { message: 'Could not load this track' });
      const t = ((await meta.json()) as { data?: AudiusRights }).data ?? {};
      const basis = audiusBasis(t);
      if (!basis.ok) return error(403, 'not_allowed', { message: basis.reason });
      const path = basis.via === 'download' ? 'download' : 'stream';
      const res = await fetch(`${AUDIUS}/tracks/${trackId}/${path}?app_name=${APP}`, { redirect: 'follow' });
      if (!res.ok) return error(502, 'track_unavailable', { message: `Could not fetch the audio (${res.status})` });
      const bytes = await readCapped(res, MAX_AUDIUS_BYTES);
      if (!bytes) return error(413, 'audio_too_large', { message: 'This track is too long to split' });
      audio = bytes;
      mimeType = res.headers.get('content-type')?.split(';')[0] || 'audio/mpeg';
      name = (t.title ?? trackId).slice(0, 80);
    } else {
      return error(400, 'invalid_body', { message: "source.kind must be 'audius' or 'upload'" });
    }

    const form = new FormData();
    form.append('audio', new Blob([audio], { type: mimeType }), `${name.replace(/[^\w.-]+/g, '_') || 'track'}.${extFor(mimeType)}`);
    form.append('stems', mode === 'vocals' ? '2' : '4');
    const res = await fetch(apiUrl, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, body: form });
    if (!res.ok) return error(502, 'provider_failed', { message: `Stem service error (${res.status})` });
    const job = normJob(await res.json());
    if (job.status === 'failed') return error(502, 'provider_failed', { message: job.error ?? 'Separation failed' });
    return json(job);
  } catch (e) {
    return error(502, 'provider_failed', { message: errMessage(e) });
  }
});
