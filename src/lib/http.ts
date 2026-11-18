/**
 * Network hardening for the global `fetch` (Expo SDK 58: `expo/fetch`, OkHttp on Android).
 *
 * Why: on Android, `ExpoFetchModule`'s `NativeRequest.start` builds the OkHttp request synchronously. Anything
 * OkHttp refuses while building it (a header value with a newline / non-ASCII character or a null value, a body on
 * a GET/HEAD, a non-http(s) URL) is thrown inside the native AsyncFunction body, so expo-modules-core rejects the
 * promise as "Call to function 'NativeRequest.start' has been rejected. → Caused by: …", and `expo/fetch` rethrows it
 * as "fetch failed: …" (node_modules/expo/src/winter/fetch/fetch.ts, FetchErrors.ts). Real network failures
 * (offline, DNS, TLS, timeouts) reject later with the OkHttp IOException message. supabase-js then hands either one
 * back as `error.message`, and screens used to print it verbatim.
 *
 * `hardenedFetch` normalises the request so OkHttp can't refuse it, and retries once when the native layer rejected
 * the request before sending it (nothing reached the server, so even a POST is safe to repeat).
 * `isNetworkError` recognises transport failures so callers can retry / show a friendly sentence instead.
 */

/** Shown instead of raw transport errors on live screens. */
export const LIVE_CONNECT_ERROR = "Couldn't connect to the live session. Check your connection and try again.";

/** A transport-level failure (no HTTP answer) re-thrown with a user-facing message. Safe to retry. */
export class NetworkError extends Error {
  constructor(message = 'Couldn’t connect. Check your connection and try again.') {
    super(message);
    this.name = 'NetworkError';
  }
}

const NETWORK_RE =
  /fetch failed|NativeRequest|has been rejected|Network request failed|Failed to fetch|network (error|is unreachable)|Unable to resolve host|failed to connect|ConnectException|SocketTimeout|timed? ?out|timeout|Connection (reset|refused|closed|abort)|ECONN|ENOTFOUND|EAI_AGAIN|SSL|handshake|unexpected end of stream|Software caused connection abort|canceled|aborted|AbortError/i;

const messageOf = (e: unknown): string => {
  if (!e || typeof e !== 'object') return typeof e === 'string' ? e : '';
  const o = e as { message?: unknown; name?: unknown; details?: unknown };
  return [o.name, o.message, o.details].filter((x): x is string => typeof x === 'string').join(' ');
};

/**
 * True for transport-level failures (request never got an HTTP answer): expo/fetch native rejections, offline,
 * DNS, timeouts, aborts. Server answers (RLS, constraint, `raise exception`) are not network errors. PostgREST
 * returns status 0 / empty code for these; their messages look like "Error: fetch failed: …" / "TypeError: …".
 */
export function isNetworkError(e: unknown): boolean {
  if (!e) return false;
  if (e instanceof NetworkError) return true;
  const status = typeof e === 'object' && e && 'status' in e ? (e as { status?: unknown }).status : undefined;
  if (status === 0) return true;
  const code = typeof e === 'object' && e && 'code' in e ? (e as { code?: unknown }).code : undefined;
  // Postgres / PostgREST errors carry a code (e.g. P0001, 42501, PGRST116): those are answers, not transport.
  if (typeof code === 'string' && code !== '' && !/^(ABORT_ERR|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)/.test(code)) return false;
  return NETWORK_RE.test(messageOf(e));
}

/** The native layer refused to build/start the request (it never left the device). */
const isNativeStartRejection = (e: unknown) => /NativeRequest\.start|has been rejected/i.test(messageOf(e));

/** OkHttp accepts header names of visible ASCII token chars and values of TAB / visible ASCII / space. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function cleanHeaderValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  // Line breaks become spaces (a pasted token with a trailing newline), other control / non-ASCII chars are dropped.
  return String(v).replace(/[\r\n]+/g, ' ').replace(/[^\t\x20-\x7e]/g, '').trim();
}

function cleanHeaders(init: HeadersInit | undefined): [string, string][] {
  const out: [string, string][] = [];
  const add = (k: unknown, v: unknown) => {
    const name = typeof k === 'string' ? k.trim() : '';
    const value = cleanHeaderValue(v);
    if (!name || !HEADER_NAME_RE.test(name) || value === null) return;
    out.push([name, value]);
  };
  if (!init) return out;
  if (Array.isArray(init)) for (const pair of init) add(pair[0], pair[1]);
  else if (typeof (init as Headers).forEach === 'function') (init as Headers).forEach((v, k) => add(k, v));
  else for (const [k, v] of Object.entries(init as Record<string, unknown>)) add(k, v);
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `fetch` with request normalisation and one retry for native start rejections. Use as supabase `global.fetch`. */
export const hardenedFetch: typeof fetch = async (input, init) => {
  // A Request object carries its own headers/body: leave it to fetch as is (supabase-js always passes a string).
  if (typeof input !== 'string' && !(input instanceof URL)) return fetch(input, init);
  const url = typeof input === 'string' ? input : input.href;
  if (!/^https?:\/\//i.test(url)) throw new TypeError(`fetch failed: unsupported URL ${url.slice(0, 40)}`);
  const method = (init?.method ?? 'GET').toUpperCase();
  const next: RequestInit = { ...init, headers: cleanHeaders(init?.headers) };
  // OkHttp throws "method GET must not have a request body" for any non-null body (even "").
  if (method === 'GET' || method === 'HEAD') delete next.body;
  try {
    return await fetch(url, next);
  } catch (e) {
    if (init?.signal?.aborted || !isNativeStartRejection(e)) throw e;
    await sleep(300);
    return fetch(url, next);
  }
};

/** Runs `fn`, and once more after a short pause if it failed with a network error. */
export async function retryOnNetworkError<T>(fn: () => Promise<T>, delayMs = 800): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    await sleep(delayMs);
    return fn();
  }
}
