import { supabase } from './supabase';

/** Live listings from the `concerts` edge function (Ticketmaster Discovery API on the server). */

export type ConcertEvent = {
  id: string;
  name: string;
  artist: string | null;
  date: string; // ISO date or date-time
  venue: string | null;
  city: string | null;
  imageUrl: string | null;
  url: string | null;
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
};

export type ConcertQuery = { lat: number; lng: number } | { city: string } | { keyword: string };

export class ServiceNotConfiguredError extends Error {
  constructor(public service: string) {
    super(`Needs ${service} setup`);
    this.name = 'ServiceNotConfiguredError';
  }
}

export const TICKETMASTER_SETUP_MESSAGE = 'Concert listings need Ticketmaster setup.';

/** Pulls `{ status, body }` out of a supabase-js FunctionsHttpError (its `context` is the Response). */
async function httpErrorInfo(error: unknown): Promise<{ status: number | null; body: { error?: string; service?: string; message?: string } | null }> {
  const ctx: unknown = error && typeof error === 'object' ? (error as { context?: unknown }).context : null;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    const body = (await ctx
      .clone()
      .json()
      .catch(() => null)) as { error?: string; service?: string; message?: string } | null;
    return { status: ctx.status, body };
  }
  return { status: null, body: null };
}

export async function fetchConcerts(q: ConcertQuery): Promise<ConcertEvent[]> {
  const { data, error } = await supabase.functions.invoke<{ events?: ConcertEvent[] }>('concerts', { body: q });
  if (error) {
    const { status, body } = await httpErrorInfo(error);
    if (status === 503 || body?.error === 'not_configured') throw new ServiceNotConfiguredError(body?.service ?? 'Ticketmaster');
    if (status === 404) throw new Error('The concerts service is not deployed yet.');
    throw new Error(body?.message ?? body?.error ?? 'Could not load concerts');
  }
  return (data?.events ?? []).filter((e) => e && e.id && e.name);
}

export const priceRange = (e: ConcertEvent): string | null => {
  if (e.priceMin == null && e.priceMax == null) return null;
  const fmt = (n: number) => {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: e.currency ?? 'USD', maximumFractionDigits: 0 }).format(n);
    } catch {
      return `${Math.round(n)}${e.currency ? ` ${e.currency}` : ''}`;
    }
  };
  if (e.priceMin != null && e.priceMax != null && e.priceMax !== e.priceMin) return `${fmt(e.priceMin)}–${fmt(e.priceMax)}`;
  return fmt((e.priceMin ?? e.priceMax) as number);
};

/** Date-only strings ("2026-12-21") are local dates; don't let UTC parsing shift them a day. */
export const eventDate = (e: ConcertEvent): Date => (/^\d{4}-\d{2}-\d{2}$/.test(e.date) ? new Date(`${e.date}T12:00:00`) : new Date(e.date));
