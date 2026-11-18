/**
 * Playlist files → catalogue tracks.
 *
 * Parses `.m3u` / `.m3u8` (with or without `#EXTINF`), `.csv` (any export with title + artist columns,
 * e.g. Exportify's "Track Name" / "Artist Name(s)") and plain `.txt` ("Artist - Title" per line), then
 * matches every entry against the catalogue with `catalog.searchTracks`.
 */
import { catalog, type CatalogTrack } from './catalog';

export type FileEntry = { title: string; artist?: string; durationSec?: number; raw: string };
export type MatchResult = { entry: FileEntry; track: CatalogTrack | null };

const MAX_ENTRIES = 1000;

/* ------------------------------------------------------------------ parsing */

const DASH = /\s+[-–—]\s+/;

/** "Artist - Title", "Title by Artist", or just a title. */
function fromText(raw: string): FileEntry | null {
  const line = raw.replace(/^\d+[.)]\s+/, '').trim(); // "12. Artist - Title"
  if (!line) return null;
  const parts = line.split(DASH);
  if (parts.length >= 2) {
    const artist = parts[0].trim();
    const title = parts.slice(1).join(' - ').trim();
    if (artist && title) return { artist, title, raw };
  }
  const by = /^(.+?)\s+by\s+(.+)$/i.exec(line);
  if (by) return { title: by[1].trim(), artist: by[2].trim(), raw };
  return { title: line, raw };
}

function fileStem(path: string) {
  let name = path;
  try {
    name = decodeURIComponent(path);
  } catch {
    // keep raw
  }
  name = name.split(/[\\/]/).pop() ?? name;
  return name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ');
}

function parseM3U(text: string): FileEntry[] {
  const out: FileEntry[] = [];
  let pending: FileEntry | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#EXTINF:/i.test(line)) {
      // #EXTINF:<seconds>[ key="value" ...],Artist - Title
      const comma = line.indexOf(',');
      const head = line.slice(8, comma === -1 ? undefined : comma);
      const info = comma === -1 ? '' : line.slice(comma + 1).trim();
      const secs = Number.parseFloat(head);
      const e = info ? fromText(info) : null;
      pending = e ? { ...e, durationSec: secs > 0 ? secs : undefined, raw: line } : null;
      continue;
    }
    if (line.startsWith('#')) continue; // #EXTM3U, #PLAYLIST, #EXTGRP, …
    if (pending) out.push(pending);
    else {
      const e = fromText(fileStem(line));
      if (e) out.push({ ...e, raw: line });
    }
    pending = null;
  }
  if (pending) out.push(pending);
  return out;
}

/** RFC 4180-ish CSV: quoted fields, doubled quotes, commas/newlines inside quotes. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const delim = (text.split(/\r?\n/, 1)[0].match(/;/g)?.length ?? 0) > (text.split(/\r?\n/, 1)[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim()));
}

function parseCSV(text: string): FileEntry[] {
  const rows = csvRows(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const find = (...names: RegExp[]) => {
    for (const re of names) {
      const i = header.findIndex((h) => re.test(h));
      if (i !== -1) return i;
    }
    return -1;
  };
  const titleCol = find(/^(track|song)\s*name$/, /^title$/, /^(track|song)$/, /^name$/, /title/);
  const artistCol = find(/^artist\s*name\(s\)$/, /^artist\s*name$/, /^artists?$/, /artist/);
  const durCol = find(/duration\s*\(ms\)/, /^duration$/, /^length$/);
  if (titleCol === -1) {
    // No header we recognise: treat every row as "Artist - Title" text.
    return rows.map((r) => fromText(r.join(' - '))).filter((e): e is FileEntry => !!e);
  }
  return rows
    .slice(1)
    .map((r): FileEntry | null => {
      const title = (r[titleCol] ?? '').trim();
      if (!title) return null;
      // Exportify joins multiple artists with commas; the first is enough to search.
      const artist = artistCol === -1 ? undefined : (r[artistCol] ?? '').split(/,|;|\s+feat\.?\s+/i)[0].trim() || undefined;
      let durationSec: number | undefined;
      if (durCol !== -1) {
        const raw = (r[durCol] ?? '').trim();
        const mmss = /^(\d+):(\d{2})$/.exec(raw);
        const n = Number(raw);
        durationSec = mmss ? Number(mmss[1]) * 60 + Number(mmss[2]) : Number.isFinite(n) && n > 0 ? (/ms/.test(header[durCol]) || n > 10_000 ? n / 1000 : n) : undefined;
      }
      return { title, artist, durationSec, raw: r.join(', ') };
    })
    .filter((e): e is FileEntry => !!e);
}

function parseTXT(text: string): FileEntry[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'))
    .map(fromText)
    .filter((e): e is FileEntry => !!e);
}

/** Parses by extension (falls back to sniffing the content). Dedupes and caps at 1000 entries. */
export function parsePlaylistFile(name: string, text: string): FileEntry[] {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const body = text.replace(/^﻿/, '');
  const entries =
    ext === 'm3u' || ext === 'm3u8' || /^#EXTM3U/i.test(body)
      ? parseM3U(body)
      : ext === 'csv'
        ? parseCSV(body)
        : parseTXT(body);
  const seen = new Set<string>();
  return entries
    .filter((e) => {
      const k = `${normalize(e.artist ?? '')}|${normalize(e.title)}`;
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .slice(0, MAX_ENTRIES);
}

/* ------------------------------------------------------------------ matching */

export function normalize(s: string) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\((feat|ft|with|prod)[^)]*\)|\[(feat|ft|with|prod)[^\]]*\]/g, ' ')
    .replace(/\s-\s(remaster(ed)?|\d{4} remaster|radio edit|single version|live).*$/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Dice coefficient on character bigrams of the normalised strings (0..1). */
function similarity(a: string, b: string) {
  const x = normalize(a).replace(/ /g, '');
  const y = normalize(b).replace(/ /g, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) grams.set(x.slice(i, i + 2), (grams.get(x.slice(i, i + 2)) ?? 0) + 1);
  let hit = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      grams.set(g, n - 1);
      hit++;
    }
  }
  return (2 * hit) / (x.length + y.length - 2);
}

const THRESHOLD = 0.72;

/** Title 60 %, artist 30 %, duration ±5 s 10 %; weights rescale when the file has no artist/duration. */
function score(e: FileEntry, c: CatalogTrack) {
  let total = 0.6;
  let s = similarity(e.title, c.title) * 0.6;
  if (e.artist) {
    total += 0.3;
    s += Math.max(similarity(e.artist, c.artist.name), similarity(e.artist, c.artist.handle)) * 0.3;
  }
  if (e.durationSec) {
    total += 0.1;
    s += Math.abs(e.durationSec - c.duration) <= 5 ? 0.1 : 0;
  }
  return s / total;
}

async function findMatch(e: FileEntry): Promise<CatalogTrack | null> {
  const results = await catalog.searchTracks(`${normalize(e.title)} ${e.artist ? normalize(e.artist) : ''}`.trim(), { limit: 10 });
  let best: CatalogTrack | null = null;
  let bestScore = 0;
  for (const c of results) {
    const s = score(e, c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return bestScore >= THRESHOLD ? best : null;
}

/**
 * Matches entries 4 at a time. `onResult` fires per entry (in completion order) with its index;
 * stops early when `cancelled()` returns true. Resolves with results in file order.
 */
export async function matchEntries(
  entries: FileEntry[],
  onResult: (index: number, result: MatchResult, done: number) => void,
  cancelled: () => boolean = () => false,
): Promise<MatchResult[]> {
  const results: MatchResult[] = entries.map((entry) => ({ entry, track: null }));
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < entries.length && !cancelled()) {
      const i = next++;
      let track: CatalogTrack | null = null;
      try {
        track = await findMatch(entries[i]);
      } catch {
        track = null; // one failed lookup shouldn't sink the import
      }
      results[i] = { entry: entries[i], track };
      done++;
      onResult(i, results[i], done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, worker));
  return results;
}
