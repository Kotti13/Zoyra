"""Port of src/lib/lyrics-sync.ts (cleanTitle, primaryArtist, durationMatches, closestByDuration)
and the candidate logic of src/lib/lyrics.ts."""

import re
from typing import Any

DURATION_TOLERANCE_S = 2.0
NOISE = re.compile(
    r"\b(official|video|audio|lyrics?|lyric video|visuali[sz]er|music video|mv|hd|hq|4k|1080p|720p|remaster(ed)?|explicit|clean|color coded|full song|topic)\b",
    re.I,
)
FEAT_INNER = re.compile(r"^\s*(feat\.?|ft\.?|featuring|with)\s", re.I)


def duration_matches(a: float | None, b: float | None, tol: float = DURATION_TOLERANCE_S) -> bool:
    return bool(a and b and a > 0 and b > 0 and abs(a - b) <= tol)


def closest_by_duration(items: list[dict[str, Any]], target: float) -> dict[str, Any] | None:
    best, best_diff = None, float("inf")
    for it in items:
        d = it.get("duration")
        diff = abs(d - target) if d and d > 0 and target > 0 else float("inf")
        if best is None or diff < best_diff:
            best, best_diff = it, diff
    return best


def clean_title(title: str, artist: str = "") -> str:
    def brackets(m: re.Match[str]) -> str:
        inner = m.group(1)
        return " " if NOISE.search(inner) or FEAT_INNER.match(inner) else m.group(0)

    t = re.sub(r"\s*[(\[{【]([^)\]}】]*)[)\]}】]", brackets, title)
    t = re.split(r"\s+[|｜]\s+", t)[0]
    t = re.sub(r"\s+(feat\.?|ft\.?|featuring)\s+.*$", "", t, flags=re.I)
    a = artist.strip().lower()
    dash = re.split(r"\s+[-–—]\s+", t)
    if len(dash) >= 2 and a and dash[0].strip().lower() == a:
        t = " - ".join(dash[1:])
    t = re.sub(r"\s+", " ", t).strip()
    return t or title.strip()


def primary_artist(artist: str) -> str:
    first = re.split(r"\s*,\s*|\s+&\s+|\s+x\s+|\s+(?:feat\.?|ft\.?|featuring)\s+", artist, flags=re.I)[0].strip()
    return first or artist.strip()


def _strip_brackets(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"\s*[(\[].*?[)\]]\s*", " ", s)).strip()


def original_candidates(title: str, artist_name: str) -> list[dict[str, str]]:
    """'Original Artist - Song (Someone Remix)' -> the underlying song."""
    out: list[dict[str, str]] = []
    dash = re.split(r"\s+[-–—]\s+", title)
    if len(dash) >= 2:
        who = re.split(r"\s+(?:x|X|&|feat\.?|ft\.?)\s+|,\s*", dash[0])[0].strip()
        out.append({"title": _strip_brackets(" - ".join(dash[1:])), "artist": who})
    cleaned = _strip_brackets(title)
    if cleaned and cleaned != title:
        out.append({"title": cleaned, "artist": artist_name})
    return [c for c in out if c["title"] and c["artist"]]


def search_candidates(title: str, artist: str) -> list[dict[str, Any]]:
    cleaned = clean_title(title, artist)
    lst = [
        {"title": cleaned, "artist": artist, "original": False},
        {"title": cleaned, "artist": primary_artist(artist), "original": False},
        *({**c, "original": True} for c in original_candidates(title, artist)),
    ]
    seen: set[str] = set()
    out = []
    for c in lst:
        k = f"{c['title'].lower()}|{c['artist'].lower()}"
        if not c["title"] or not c["artist"] or k in seen:
            continue
        seen.add(k)
        out.append(c)
    return out


def build_result(r: dict[str, Any], source: str, allow_synced: bool, *, timing_mismatch: bool = False) -> dict[str, Any]:
    synced = r.get("syncedLyrics") if allow_synced else None
    dur = r.get("duration")
    return {
        "found": True,
        "source": source,
        "instrumental": bool(r.get("instrumental")),
        "syncedLyrics": synced or None,
        "plainLyrics": r.get("plainLyrics") or None,
        "matchedTitle": r.get("trackName"),
        "matchedArtist": r.get("artistName"),
        "timedDuration": dur if dur and dur > 0 else None,
        "timingMismatch": timing_mismatch,
    }
