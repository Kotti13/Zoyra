/**
 * Client side of the server AI / recognition features.
 *
 * Every call goes through a Supabase Edge Function (secrets never live in the app). A function
 * answers HTTP 503 `{ error: 'not_configured', service }` when its server key is missing; callers
 * get that as `{ ok: false, reason: 'not_configured' }` so screens can say "needs <service> setup"
 * and fall back to local behaviour instead of faking success.
 */
import * as Speech from 'expo-speech';
import { FunctionsHttpError } from '@supabase/supabase-js';

import { supabase } from './supabase';

export type AiFailure = { ok: false; reason: 'not_configured'; service: string; message: string } | { ok: false; reason: 'error'; message: string };
export type AiResult<T> = { ok: true; data: T } | AiFailure;

type ErrorBody = { error?: string; service?: string; message?: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

async function readErrorBody(err: unknown): Promise<{ status: number; body: ErrorBody }> {
  if (err instanceof FunctionsHttpError && err.context instanceof Response) {
    const res = err.context;
    try {
      const json: unknown = await res.clone().json();
      return { status: res.status, body: isObject(json) ? (json as ErrorBody) : {} };
    } catch {
      return { status: res.status, body: {} };
    }
  }
  return { status: 0, body: {} };
}

/** Invoke an Edge Function and normalise every failure mode. */
export async function invokeFn<T>(name: string, body: Record<string, unknown>, fallbackService: string): Promise<AiResult<T>> {
  try {
    const { data, error } = await supabase.functions.invoke<T>(name, { body });
    if (error) {
      const { status, body: eb } = await readErrorBody(error);
      if (eb.error === 'not_configured' || status === 503) {
        const service = eb.service ?? fallbackService;
        return { ok: false, reason: 'not_configured', service, message: `Needs ${service} setup` };
      }
      if (status === 404) return { ok: false, reason: 'not_configured', service: fallbackService, message: `Needs ${fallbackService} setup (function not deployed)` };
      return { ok: false, reason: 'error', message: eb.message ?? eb.error ?? error.message ?? 'Request failed' };
    }
    if (data === null || data === undefined) return { ok: false, reason: 'error', message: 'Empty response' };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : 'Request failed' };
  }
}

/* ------------------------------------------------------------------ typed wrappers */

export type AiPlaylistResponse = { title: string; description: string; trackIds: string[] };
export const aiPlaylist = (prompt: string, length: number, exclude?: string[]) =>
  invokeFn<AiPlaylistResponse>('ai-playlist', { prompt, length, ...(exclude?.length ? { exclude } : {}) }, 'AI');

export type AiDjResponse = { lines: string[] };
export const aiDjScript = (tracks: { title: string; artist: string; genre?: string }[], userName: string, mood: string) =>
  invokeFn<AiDjResponse>('ai-dj', { tracks, userName, mood }, 'AI');

export type MoodFromPhotoResponse = { mood: string; confidence: number; reason: string };
export const moodFromPhoto = (imageBase64: string, mediaType = 'image/jpeg') =>
  invokeFn<MoodFromPhotoResponse>('mood-from-photo', { imageBase64, mediaType }, 'AI');

export type SongMatch = { title: string; artist: string; album?: string; isrc?: string; /** where in the song the clip was heard */ offsetMs?: number; score?: number } | null;
export type RecognizeSongResponse = { match: SongMatch };
export const recognizeSong = (audioBase64: string, mimeType: string, mode: 'listen' | 'hum' = 'listen') =>
  invokeFn<RecognizeSongResponse>('recognize-song', { audioBase64, mimeType, ...(mode === 'hum' ? { mode } : {}) }, mode === 'hum' ? 'ACRCloud humming' : 'ACRCloud');

export type LyricsAiMode = 'translate' | 'romanize';
export type LyricsAiResponse = { lines: string[]; cached: boolean };
/** Translate / romanize lyric lines. The reply has exactly as many lines as `lines`, in order. */
export const lyricsAi = (lines: string[], mode: LyricsAiMode, opts: { target?: string; trackId?: string } = {}) =>
  invokeFn<LyricsAiResponse>(
    'lyrics-ai',
    { lines, mode, ...(mode === 'translate' && opts.target ? { target: opts.target } : {}), ...(opts.trackId ? { trackId: opts.trackId } : {}) },
    'Anthropic',
  );

/* ------------------------------------------------------------------ on-device voice (no key needed) */

/** Speak `text` with the device TTS. Resolves when speech ends (or fails / is stopped). */
export function speakAsync(text: string, opts: { rate?: number; language?: string } = {}): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    // Safety net: never leave the music ducked if a callback is missed.
    const guard = setTimeout(finish, Math.min(30_000, 4_000 + text.length * 90));
    const end = () => {
      clearTimeout(guard);
      finish();
    };
    try {
      Speech.speak(text, { rate: opts.rate ?? 1, language: opts.language, onDone: end, onStopped: end, onError: end });
    } catch {
      end();
    }
  });
}

export const stopSpeaking = () => Speech.stop().catch(() => {});
