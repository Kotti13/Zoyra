"""LRCLIB with title cleaning and duration matching.
GET /get and /search mirror LRCLIB (JSON unchanged) so the app keeps its own matching code if it wants;
GET /match runs the whole app algorithm server side (exact get, then search, closest length within 2 s,
otherwise plain lyrics with timingMismatch)."""

from fastapi import APIRouter, Depends, Query, Request

from .. import lyrics_logic as L
from ..deps import plain_json, rate_limit
from ..errors import GatewayError

router = APIRouter(prefix="/v1/lyrics", tags=["lyrics"])
MAX_SEARCHES = 3


async def lrclib_get(request: Request, title: str, artist: str, duration: float) -> dict | None:
    s, up, cache = request.app.state.settings, request.app.state.upstream, request.app.state.cache
    params = {"track_name": title, "artist_name": artist, "duration": str(round(duration))}

    async def load():
        res = await up.request("lrclib", "GET", f"{s.lrclib_base}/get", params=params)
        if res.status_code == 404:
            return None
        if res.status_code >= 400:
            raise GatewayError(502, "upstream_error", f"lrclib returned {res.status_code}.", provider="lrclib")
        return res.json()

    r = await cache.get_or_load(f"lrclib:get:{title.lower()}|{artist.lower()}|{round(duration)}", s.ttl_lyrics, load)
    return r.value


async def lrclib_search(request: Request, title: str, artist: str) -> list[dict]:
    s, up, cache = request.app.state.settings, request.app.state.upstream, request.app.state.cache
    params = {"track_name": title, "artist_name": artist}

    async def load():
        res = await up.request("lrclib", "GET", f"{s.lrclib_base}/search", params=params)
        if res.status_code >= 400:
            raise GatewayError(502, "upstream_error", f"lrclib returned {res.status_code}.", provider="lrclib")
        data = res.json()
        return data if isinstance(data, list) else []

    r = await cache.get_or_load(f"lrclib:search:{title.lower()}|{artist.lower()}", s.ttl_lyrics, load)
    return r.value


@router.get("/get")
async def get_exact(request: Request, track_name: str = Query(min_length=1, max_length=200), artist_name: str = Query(min_length=1, max_length=200), duration: float = Query(gt=0, le=7200), _=Depends(rate_limit("lyrics"))):
    data = await lrclib_get(request, track_name, artist_name, duration)
    if data is None:
        raise GatewayError(404, "not_found", "No lyrics found.")
    return plain_json(data, request.app.state.settings.ttl_lyrics)


@router.get("/search")
async def search(request: Request, track_name: str = Query(min_length=1, max_length=200), artist_name: str = Query("", max_length=200), _=Depends(rate_limit("lyrics"))):
    data = await lrclib_search(request, track_name, artist_name)
    return plain_json(data, request.app.state.settings.ttl_lyrics)



async def match_lyrics(request: Request, title: str, artist: str, duration: float) -> dict:
    if duration > 0:
        cleaned = L.clean_title(title, artist)
        exact = await lrclib_get(request, title, artist, duration)
        if exact is None and cleaned != title:
            try:
                exact = await lrclib_get(request, cleaned, artist, duration)
            except GatewayError:
                exact = None
        if exact:
            return L.build_result(exact, "exact", L.duration_matches(exact.get("duration"), duration) or not exact.get("duration"))

    fallback = None
    for c in L.search_candidates(title, artist)[:MAX_SEARCHES]:
        try:
            raw = await lrclib_search(request, c["title"], c["artist"])
        except GatewayError:
            raw = []
        hits = [h for h in raw if h.get("syncedLyrics") or h.get("plainLyrics")]
        if not hits:
            continue
        timed = L.closest_by_duration([h for h in hits if h.get("syncedLyrics")], duration)
        if timed and L.duration_matches(timed.get("duration"), duration):
            return L.build_result(timed, "exact", True)
        if fallback is None:
            best = L.closest_by_duration(hits, duration) or hits[0]
            fallback = L.build_result(best, "original" if c["original"] else "exact", False, timing_mismatch=not c["original"] and bool(best.get("syncedLyrics")))
    return fallback or {"found": False}


@router.get("/match")
async def match(request: Request, title: str = Query(min_length=1, max_length=200), artist: str = Query(min_length=1, max_length=200), duration: float = Query(0, ge=0, le=7200), _=Depends(rate_limit("lyrics"))):
    return plain_json(await match_lyrics(request, title, artist, duration), request.app.state.settings.ttl_lyrics)
