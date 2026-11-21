import { catalog, type Artist, type Artwork, type CatalogTrack } from './catalog';
import { cleanArtistName, isZoyraArtistId, zoyra, zoyraEnabled } from './zoyra-api';

/** The sign-up language choices (also what Settings stores in `languages`). */
export const LANGUAGES = ['Tamil', 'Hindi', 'English', 'Spanish', 'Korean', 'Telugu', 'Malayalam', 'Punjabi', 'Japanese', 'Bengali'];

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
/** Same artist? Equal once punctuation is ignored, or one name inside the other and at least half its length. */
const sameArtist = (wanted: string, found: string) => {
  const a = norm(wanted);
  const b = norm(found);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.includes(short) && short.length / long.length >= 0.5;
};

/** Popular songs in a language: the query the language tile and the artist suggestions both start from. */
const topSongs = (language: string, limit: number): Promise<CatalogTrack[]> => catalog.searchTracks(`top ${language} songs`, { limit });

/** Cover of the language's top song, shown as that language's tile. null when nothing came back. */
export async function languageTopSongArt(language: string): Promise<{ artwork: Artwork; title: string } | null> {
  const tracks = await topSongs(language, 5).catch(() => [] as CatalogTrack[]);
  const first = tracks.find((t) => t.artwork.large ?? t.artwork.medium ?? t.artwork.small);
  return first ? { artwork: first.artwork, title: first.title } : null;
}

/**
 * Artists to suggest for the languages a person picked: the artists behind each language's top songs, interleaved so
 * every language is represented, each with their real photo. Needs the Zoyra backend; empty when it is off.
 */
export async function artistsForLanguages(languages: string[], max = 12): Promise<Artist[]> {
  if (!zoyraEnabled || !languages.length) return [];
  const lists = await Promise.all(languages.slice(0, 4).map((l) => topSongs(l, 30).catch(() => [] as CatalogTrack[])));
  const seen = new Set<string>();
  const names: string[] = [];
  for (let i = 0; i < Math.max(0, ...lists.map((l) => l.length)) && names.length < max + 4; i++) {
    for (const l of lists) {
      const name = l[i] ? cleanArtistName(l[i].artist.name) : '';
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        names.push(name);
      }
    }
  }
  // Real photos: the artist search returns the matching YouTube Music artist with a picture.
  const found = await Promise.all(
    names.map(async (name): Promise<Artist | null> => {
      const hits = await zoyra.searchArtists(name, 3).catch(() => [] as Artist[]);
      // Best name match only: a search hit for someone else would put the wrong face on this artist.
      const hit = hits.find((a) => sameArtist(name, a.name));
      return hit && isZoyraArtistId(hit.id) && (hit.image.small ?? hit.image.medium) ? hit : null;
    }),
  );
  const out: Artist[] = [];
  const ids = new Set<string>();
  for (const a of found) {
    if (!a || ids.has(a.id)) continue;
    ids.add(a.id);
    out.push(a);
  }
  return out.slice(0, max);
}
