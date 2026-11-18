// concerts: Ticketmaster Discovery API proxy (music events only).
// GET ?lat=&lng=&city=&keyword=&page=   (or POST with the same fields as a JSON body)
// → { events: [{ id, name, artist, date, venue, city, imageUrl, url, priceMin?, priceMax?, currency? }] }
import { error, errMessage, json, notConfigured, preflight, readJson, requireUser } from '../_shared/http.ts';

type TmImage = { url: string; width?: number; ratio?: string };
type TmEvent = {
  id: string;
  name: string;
  url?: string;
  images?: TmImage[];
  dates?: { start?: { dateTime?: string; localDate?: string; localTime?: string } };
  priceRanges?: { min?: number; max?: number; currency?: string }[];
  _embedded?: {
    venues?: { name?: string; city?: { name?: string } }[];
    attractions?: { name?: string }[];
  };
};
type TmResponse = { _embedded?: { events?: TmEvent[] } };

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown, max = 100): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'GET' && req.method !== 'POST') return error(405, 'method_not_allowed');

  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const apiKey = Deno.env.get('TICKETMASTER_API_KEY');
  if (!apiKey) return notConfigured('ticketmaster');

  // supabase.functions.invoke sends POST + JSON body; plain GET uses the query string.
  const q: Record<string, unknown> =
    req.method === 'POST' ? ((await readJson(req)) ?? {}) : Object.fromEntries(new URL(req.url).searchParams);
  const lat = num(q.lat);
  const lng = num(q.lng);
  const city = str(q.city);
  const keyword = str(q.keyword);
  const page = Math.min(Math.max(Math.floor(num(q.page) ?? 0), 0), 49);

  const params = new URLSearchParams({
    apikey: apiKey,
    classificationName: 'music',
    sort: 'date,asc',
    size: '20',
    page: String(page),
  });
  if (lat !== undefined && lng !== undefined) {
    params.set('latlong', `${lat},${lng}`);
    params.set('radius', '100');
    params.set('unit', 'km');
  } else if (city) {
    params.set('city', city);
  }
  if (keyword) params.set('keyword', keyword);

  try {
    const res = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params.toString()}`);
    if (res.status === 401 || res.status === 403) return error(502, 'concerts_failed', { message: 'Ticketmaster rejected the API key' });
    if (!res.ok) return error(502, 'concerts_failed', { message: `Ticketmaster request failed (${res.status})` });
    const data = (await res.json()) as TmResponse;

    const events = (data._embedded?.events ?? []).map((e) => {
      const venue = e._embedded?.venues?.[0];
      const image = [...(e.images ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0)).find((i) => i.ratio === '16_9') ?? e.images?.[0];
      const price = e.priceRanges?.[0];
      const start = e.dates?.start;
      return {
        id: e.id,
        name: e.name,
        artist: e._embedded?.attractions?.[0]?.name ?? e.name,
        date: start?.dateTime ?? (start?.localDate ? `${start.localDate}${start.localTime ? `T${start.localTime}` : ''}` : null),
        venue: venue?.name ?? null,
        city: venue?.city?.name ?? null,
        imageUrl: image?.url ?? null,
        url: e.url ?? null,
        ...(price?.min !== undefined ? { priceMin: price.min } : {}),
        ...(price?.max !== undefined ? { priceMax: price.max } : {}),
        ...(price?.currency ? { currency: price.currency } : {}),
      };
    });
    return json({ events });
  } catch (e) {
    return error(502, 'concerts_failed', { message: errMessage(e) });
  }
});
