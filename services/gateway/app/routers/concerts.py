"""Ticketmaster music events near a point or city. Port of supabase/functions/concerts."""

from fastapi import APIRouter, Depends, Query, Request

from ..deps import cached_json, rate_limit
from ..errors import GatewayError

router = APIRouter(prefix="/v1", tags=["concerts"])


def map_event(e: dict) -> dict:
    emb = e.get("_embedded") or {}
    venue = (emb.get("venues") or [{}])[0]
    images = e.get("images") or []
    by_width = sorted(images, key=lambda i: i.get("width") or 0, reverse=True)
    image = next((i for i in by_width if i.get("ratio") == "16_9"), images[0] if images else None)
    price = (e.get("priceRanges") or [{}])[0]
    start = (e.get("dates") or {}).get("start") or {}
    date = start.get("dateTime") or (f"{start['localDate']}{'T' + start['localTime'] if start.get('localTime') else ''}" if start.get("localDate") else None)
    out = {
        "id": e.get("id"),
        "name": e.get("name"),
        "artist": ((emb.get("attractions") or [{}])[0]).get("name") or e.get("name"),
        "date": date,
        "venue": venue.get("name"),
        "city": (venue.get("city") or {}).get("name"),
        "imageUrl": image.get("url") if image else None,
        "url": e.get("url"),
    }
    if price.get("min") is not None:
        out["priceMin"] = price["min"]
    if price.get("max") is not None:
        out["priceMax"] = price["max"]
    if price.get("currency"):
        out["currency"] = price["currency"]
    return out


@router.get("/concerts")
async def concerts(
    request: Request,
    lat: float | None = Query(None, ge=-90, le=90),
    lng: float | None = Query(None, ge=-180, le=180),
    city: str | None = Query(None, max_length=100),
    keyword: str | None = Query(None, max_length=100),
    page: int = Query(0, ge=0, le=49),
    _=Depends(rate_limit("concerts", auth=True)),
):
    s = request.app.state.settings
    if not s.ticketmaster_api_key:
        raise GatewayError(503, "not_configured", "Concerts are not configured.", service="ticketmaster")
    params = {"classificationName": "music", "sort": "date,asc", "size": "20", "page": str(page)}
    if lat is not None and lng is not None:
        params |= {"latlong": f"{round(lat, 2)},{round(lng, 2)}", "radius": "100", "unit": "km"}  # rounded: better cache hits
    elif city:
        params["city"] = city
    if keyword:
        params["keyword"] = keyword

    async def load():
        res = await request.app.state.upstream.request("ticketmaster", "GET", s.ticketmaster_base, params={**params, "apikey": s.ticketmaster_api_key})
        if res.status_code in (401, 403):
            raise GatewayError(502, "concerts_failed", "Ticketmaster rejected the API key.")
        if res.status_code == 429:
            raise GatewayError(503, "upstream_rate_limited", "Ticketmaster is rate limiting us.", headers={"Retry-After": "30"})
        if res.status_code >= 400:
            raise GatewayError(502, "concerts_failed", f"Ticketmaster request failed ({res.status_code}).")
        return {"events": [map_event(e) for e in ((res.json().get("_embedded") or {}).get("events") or [])]}

    key = "concerts:" + "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    return cached_json(await request.app.state.cache.get_or_load(key, s.ttl_concerts, load), s.ttl_concerts, public=False)
