"""Spotify Web API calls the app used to make directly (playlist import). The user's Spotify access token
comes in X-Spotify-Token for this request only: never stored, cached or logged. PKCE login stays in the app."""

from fastapi import APIRouter, Depends, Header, Query, Request

from ..deps import rate_limit, uncached_json
from ..errors import GatewayError

router = APIRouter(prefix="/v1/spotify", tags=["spotify"])
LIKED = "__liked__"
MAX_PAGES = 12


class SpotifyClient:
    def __init__(self, request: Request, token: str | None):
        if not token or not token.strip():
            raise GatewayError(401, "spotify_token_missing", "X-Spotify-Token header is required.")
        self.up = request.app.state.upstream
        self.base = request.app.state.settings.spotify_base
        self.h = {"Authorization": f"Bearer {token.strip()}"}

    async def get(self, path: str, params: dict | None = None) -> dict:
        res = await self.up.request("spotify", "GET", f"{self.base}{path}", params=params, headers=self.h)
        if res.status_code == 401:
            raise GatewayError(401, "spotify_token_invalid", "Spotify session expired. Connect again.")
        if res.status_code == 403:
            raise GatewayError(403, "spotify_forbidden", "Spotify refused access. In development mode, add this account under your app's Users and Access.")
        if res.status_code == 429:
            raise GatewayError(429, "spotify_rate_limited", "Spotify is rate limiting requests. Try again in a minute.", headers={"Retry-After": res.headers.get("retry-after", "60")})
        if res.status_code == 404:
            raise GatewayError(404, "not_found", "Not found on Spotify.")
        if res.status_code >= 400:
            raise GatewayError(502, "spotify_failed", f"Spotify error {res.status_code}.")
        return res.json()

    async def paged(self, path: str, limit: int, cap: int):
        items: list = []
        offset = 0
        for _ in range(MAX_PAGES):
            page = await self.get(path, {"limit": limit, "offset": offset})
            got = page.get("items") or []
            items += got
            offset += limit
            if not page.get("next") or not got or len(items) >= cap:
                break
        return items


def _track(r: dict) -> dict | None:
    t = r.get("track") or r.get("item")
    if not t or (t.get("type") and t["type"] != "track") or not t.get("name"):
        return None
    return {"title": t["name"], "artists": [a["name"] for a in t.get("artists", [])], "durationSec": round((t.get("duration_ms") or 0) / 1000)}


@router.get("/playlists")
async def playlists(request: Request, x_spotify_token: str | None = Header(None), _=Depends(rate_limit("spotify", auth=True))):
    """-> [{id, name, image?, total}] with Liked Songs first (id '__liked__')."""
    sp = SpotifyClient(request, x_spotify_token)
    out = []
    for p in await sp.paged("/me/playlists", 50, 500):
        if not p:
            continue
        item = {"id": p["id"], "name": p["name"], "total": (p.get("tracks") or p.get("items") or {}).get("total", 0)}
        if p.get("images"):
            item["image"] = p["images"][0]["url"]
        out.append(item)
    try:
        liked = await sp.get("/me/tracks", {"limit": 1})
        if liked.get("total", 0) > 0:
            out.insert(0, {"id": LIKED, "name": "Liked Songs", "total": liked["total"]})
    except GatewayError as e:
        if e.status in (401, 429):
            raise
    return uncached_json(out)


@router.get("/playlists/{playlist_id}/tracks")
async def playlist_tracks(playlist_id: str, request: Request, max: int = Query(500, ge=1, le=1000), x_spotify_token: str | None = Header(None), _=Depends(rate_limit("spotify", auth=True))):
    """-> [{title, artists[], durationSec}] (playlist id '__liked__' = Liked Songs)."""
    sp = SpotifyClient(request, x_spotify_token)
    if playlist_id == LIKED:
        raw = await sp.paged("/me/tracks", 50, max)
    else:
        if not playlist_id.replace("_", "").replace("-", "").isalnum():
            raise GatewayError(400, "bad_request", "Invalid playlist id.")
        try:
            raw = await sp.paged(f"/playlists/{playlist_id}/items", 50, max)  # newer path
        except GatewayError as e:
            if e.status != 404:
                raise
            raw = await sp.paged(f"/playlists/{playlist_id}/tracks", 50, max)
    return uncached_json([t for t in map(_track, raw) if t][:max])
