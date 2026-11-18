/**
 * Public-domain audiobooks from LibriVox (free API, no key).
 * https://librivox.org/api/info — "LibriVox recordings are in the public domain."
 *
 * Covers come from the Internet Archive item that hosts each book's MP3s.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { CatalogTrack } from './catalog';

const API = 'https://librivox.org/api/feed/audiobooks';

/**
 * The shared player streams by Audius id only (`sourceFor` in src/state/player.tsx). Until it also
 * honours `streamUrl` on a track, chapters play in the Audiobooks screen's own audio player. Flip
 * this to true once the player change lands to send chapters through `playTracks` instead.
 */
export const MAIN_PLAYER_STREAMS_URLS = true;

export const ATTRIBUTION = 'LibriVox recordings are in the public domain. Read by LibriVox volunteers.';

/** LibriVox genre names that the API accepts (some, like "Fiction" and "Mystery", return 500). */
export const BOOK_GENRES = [
  { label: 'Classics', genre: 'Romance' },
  { label: 'Detective', genre: 'Detective Fiction' },
  { label: 'Sci-fi', genre: 'Science Fiction' },
  { label: 'Adventure', genre: 'Action & Adventure Fiction' },
  { label: 'Kids', genre: "Children's Fiction" },
  { label: 'Myths', genre: 'Myths, Legends & Fairy Tales' },
  { label: 'History', genre: 'History' },
  { label: 'Mind', genre: 'Philosophy' },
  { label: 'Self-help', genre: 'Self-Help' },
  { label: 'Poetry', genre: 'Poetry' },
] as const;

export type Book = {
  id: string;
  title: string;
  description: string;
  authors: string;
  language: string;
  totalSecs: number;
  sections: number;
  cover: string | null;
  librivoxUrl: string | null;
  textUrl: string | null;
  copyrightYear: string | null;
};

export type Chapter = {
  id: string;
  n: number;
  title: string;
  url: string;
  secs: number;
  readers: string;
};

type RawAuthor = { first_name?: string | null; last_name?: string | null };
type RawSection = { id: string; section_number?: string | null; title?: string | null; listen_url?: string | null; playtime?: string | null; readers?: { display_name?: string | null }[] | null };
type RawBook = {
  id: string;
  title?: string | null;
  description?: string | null;
  language?: string | null;
  copyright_year?: string | null;
  num_sections?: string | null;
  totaltimesecs?: number | null;
  url_librivox?: string | null;
  url_text_source?: string | null;
  url_iarchive?: string | null;
  url_zip_file?: string | null;
  authors?: RawAuthor[] | null;
  sections?: RawSection[] | null;
};

const stripHtml = (s: string) =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const https = (u: string | null | undefined): string | null => {
  if (!u) return null;
  const v = u.trim().replace(/^http:\/\//, 'https://');
  return /^https:\/\//.test(v) ? v : null;
};

/** Internet Archive thumbnail for the item that holds the MP3s. */
const coverFor = (b: RawBook): string | null => {
  const m = b.url_iarchive?.match(/archive\.org\/details\/([^/?#]+)/) ?? b.url_zip_file?.match(/archive\.org\/compress\/([^/?#]+)/);
  return m ? `https://archive.org/services/img/${encodeURIComponent(m[1])}` : null;
};

const toBook = (b: RawBook): Book => ({
  id: b.id,
  title: (b.title ?? 'Untitled').trim(),
  description: stripHtml(b.description ?? ''),
  authors:
    (b.authors ?? [])
      .map((a) => [a.first_name, a.last_name].filter(Boolean).join(' ').trim())
      .filter(Boolean)
      .join(', ') || 'Unknown author',
  language: b.language ?? '',
  totalSecs: b.totaltimesecs ?? 0,
  sections: Number(b.num_sections ?? 0) || 0,
  cover: coverFor(b),
  librivoxUrl: https(b.url_librivox),
  textUrl: https(b.url_text_source),
  copyrightYear: b.copyright_year && b.copyright_year !== '0' ? b.copyright_year : null,
});

const toChapter = (s: RawSection, i: number): Chapter | null => {
  const url = https(s.listen_url);
  if (!url) return null;
  return {
    id: s.id,
    n: Number(s.section_number ?? i + 1) || i + 1,
    title: stripHtml(s.title ?? '') || `Section ${i + 1}`,
    url,
    secs: Number(s.playtime ?? 0) || 0,
    readers: (s.readers ?? [])
      .map((r) => r.display_name?.trim())
      .filter(Boolean)
      .join(', '),
  };
};

const cache = new Map<string, { at: number; data: RawBook[] }>();
const TTL = 30 * 60 * 1000;

async function query(params: Record<string, string>): Promise<RawBook[]> {
  const qs = new URLSearchParams({ format: 'json', ...params }).toString();
  const hit = cache.get(qs);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const res = await fetch(`${API}?${qs}`, { headers: { Accept: 'application/json' } });
  // LibriVox answers 404 with {"error":"Audiobooks could not be found"} when nothing matches.
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`LibriVox request failed (${res.status})`);
  const json = (await res.json()) as { books?: RawBook[] | Record<string, RawBook> };
  const books = Array.isArray(json.books) ? json.books : json.books ? Object.values(json.books) : [];
  cache.set(qs, { at: Date.now(), data: books });
  return books;
}

const LIST_FIELDS = '{id,title,description,language,totaltimesecs,num_sections,url_librivox,url_text_source,url_iarchive,url_zip_file,copyright_year,authors}';

/**
 * A page of books in a LibriVox genre. English recordings are preferred (others are kept when a page
 * has few English ones). `next` is the raw API offset for the following page.
 */
export async function booksByGenre(genre: string, offset = 0, limit = 20): Promise<{ books: Book[]; next: number; end: boolean }> {
  const raw = await query({ genre, offset: String(offset), limit: String(limit * 2), fields: LIST_FIELDS });
  const books = raw.map(toBook);
  const english = books.filter((b) => b.language === 'English');
  return { books: (english.length >= Math.min(6, books.length) ? english : books).slice(0, limit), next: offset + raw.length, end: raw.length < limit * 2 };
}

/** Search by title prefix and by author surname. */
export async function searchBooks(q: string): Promise<Book[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const [byTitle, byAuthor] = await Promise.all([
    query({ title: `^${term}`, limit: '20', fields: LIST_FIELDS }).catch(() => [] as RawBook[]),
    query({ author: term, limit: '20', fields: LIST_FIELDS }).catch(() => [] as RawBook[]),
  ]);
  const seen = new Set<string>();
  return [...byTitle, ...byAuthor].filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true))).map(toBook);
}

/** One book with its chapters (MP3 sections). */
export async function bookDetail(id: string): Promise<{ book: Book; chapters: Chapter[] }> {
  if (!/^\d+$/.test(id)) throw new Error('Unknown audiobook.');
  const raw = await query({ id, extended: '1' });
  const b = raw[0];
  if (!b) throw new Error('This audiobook is no longer on LibriVox.');
  const chapters = (b.sections ?? []).map(toChapter).filter((c): c is Chapter => !!c);
  return { book: toBook(b), chapters };
}

export const formatLength = (secs: number): string => {
  if (!secs) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m} min`;
};

/** Track-shaped chapter for the shared player, once it honours `streamUrl` (see MAIN_PLAYER_STREAMS_URLS). */
export type BookTrack = CatalogTrack & { streamUrl: string };

export const chapterTrack = (book: Book, c: Chapter): BookTrack => ({
  id: `librivox:${c.id}`,
  title: c.title,
  artist: { id: `librivox-book:${book.id}`, name: book.authors, handle: 'librivox', verified: false },
  duration: c.secs,
  genre: 'Audiobook',
  artwork: book.cover ? { small: book.cover, medium: book.cover, large: book.cover } : {},
  plays: 0,
  likes: 0,
  url: book.librivoxUrl ?? undefined,
  streamUrl: c.url,
});

/* ------------------------------------------------------------------ continue listening (this device) */

export type BookProgress = { bookId: string; title: string; authors: string; cover: string | null; chapter: number; chapterTitle: string; position: number; at: number };

const PROGRESS_KEY = 'zoyra.audiobooks.progress';

export async function loadProgress(): Promise<BookProgress[]> {
  try {
    const raw = await AsyncStorage.getItem(PROGRESS_KEY);
    const list = raw ? (JSON.parse(raw) as BookProgress[]) : [];
    return Array.isArray(list) ? list.sort((a, b) => b.at - a.at) : [];
  } catch {
    return [];
  }
}

export async function saveProgress(p: BookProgress): Promise<void> {
  const list = (await loadProgress()).filter((x) => x.bookId !== p.bookId);
  await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify([p, ...list].slice(0, 20))).catch(() => {});
}
