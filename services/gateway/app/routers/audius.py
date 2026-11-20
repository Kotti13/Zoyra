"""Audius pass-through. Same paths as https://api.audius.co/v1 (under /v1/audius), JSON unchanged,
so the app only swaps its base URL. app_name is added here, never trusted from the client."""

import re
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse

from ..deps import cached_json, rate_limit
from ..errors import GatewayError
from ..upstream import json_or_raise

router = APIRouter(prefix="/v1/audius", tags=["audius"])

ID = r"[A-Za-z0-9_-]{1,40}"
ALLOWED = [
    re.compile(p)
    for p in (
        r"tracks/trending",
        r"tracks/trending/underground",
        r"tracks/search",
        rf"tracks/{ID}",
        r"users/search",
        rf"users/{ID}",
        rf"users/{ID}/(?:tracks|albums|related)",
        r"playlists/trending",
        r"playlists/search",
        rf"playlists/{ID}",
        rf"playlists/{ID}/tracks",
    )
]
PARAMS = {"query", "genre", "mood", "time", "limit", "offset", "sort", "sort_method", "sort_direction"}
DETAIL = re.compile(rf"(?:tracks|users|playlists)/{ID}(?:/tracks|/albums|/related)?")


@router.get("/tracks/{track_id}/stream")
async def stream(track_id: str, request: Request, _=Depends(rate_limit("audius"))):
    """302 to Audius's own stream endpoint (which 302s to a signed CDN URL). Players follow redirects."""
    if not re.fullmatch(ID, track_id):
        raise GatewayError(400, "bad_request", "Invalid track id.")
    s = request.app.state.settings
    return RedirectResponse(f"{s.audius_base}/tracks/{track_id}/stream?{urlencode({'app_name': s.audius_app_name})}", status_code=302, headers={"Cache-Control": "private, max-age=60"})


@router.get("/{path:path}")
async def proxy(path: str, request: Request, _=Depends(rate_limit("audius"))):
    path = path.strip("/")
    if not any(p.fullmatch(path) for p in ALLOWED):
        raise GatewayError(404, "not_found", "Unknown Audius route.")
    s = request.app.state.settings
    q = {k: v[:200] for k, v in request.query_params.items() if k in PARAMS and v != ""}
    if "limit" in q:
        q["limit"] = str(min(max(int(q["limit"]) if q["limit"].isdigit() else 20, 1), 100))
    q = dict(sorted(q.items()))
    ttl = s.ttl_audius_detail if (DETAIL.fullmatch(path) and not path.startswith(("users/search",))) else s.ttl_audius

    async def load():
        res = await request.app.state.upstream.request("audius", "GET", f"{s.audius_base}/{path}", params={**q, "app_name": s.audius_app_name})
        return json_or_raise(res, "audius")

    result = await request.app.state.cache.get_or_load(f"audius:{path}?{urlencode(q)}", ttl, load)
    return cached_json(result, ttl)
