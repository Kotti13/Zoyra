from fastapi import APIRouter, Depends, Request

from ..deps import cached_json, rate_limit
from ..errors import GatewayError

router = APIRouter(prefix="/v1/librivox", tags=["librivox"])

PARAMS = {"genre", "offset", "limit", "fields", "title", "author", "id", "extended"}


@router.get("/audiobooks")
async def audiobooks(request: Request, _=Depends(rate_limit("librivox"))):
    """LibriVox feed, JSON unchanged. LibriVox answers 404 for 'no match'; we return {"books": []} instead."""
    s = request.app.state.settings
    q = {k: v[:300] for k, v in sorted(request.query_params.items()) if k in PARAMS and v != ""}
    if "id" in q and not q["id"].isdigit():
        raise GatewayError(400, "bad_request", "id must be numeric.")
    if q.get("limit", "").isdigit():
        q["limit"] = str(min(int(q["limit"]), 100))
    q["format"] = "json"

    async def load():
        res = await request.app.state.upstream.request("librivox", "GET", s.librivox_base, params=q)
        if res.status_code == 404:
            return {"books": []}
        if res.status_code >= 400:
            raise GatewayError(502, "upstream_error", f"librivox returned {res.status_code}.", provider="librivox")
        try:
            return res.json()
        except ValueError:
            raise GatewayError(502, "upstream_error", "librivox returned invalid JSON.", provider="librivox") from None

    key = "librivox:" + "&".join(f"{k}={v}" for k, v in q.items())
    return cached_json(await request.app.state.cache.get_or_load(key, s.ttl_librivox, load), s.ttl_librivox)
