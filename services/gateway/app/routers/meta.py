from fastapi import APIRouter, Request

router = APIRouter(prefix="/v1/meta", tags=["meta"])


@router.get("/health")
async def health(request: Request):
    s = request.app.state.settings
    up = request.app.state.upstream
    configured = {
        "supabase_auth": bool(s.supabase_jwt_secret or s.supabase_jwks_url),
        "lastfm": bool(s.lastfm_api_key and s.lastfm_shared_secret),
        "ticketmaster": bool(s.ticketmaster_api_key),
        "youtube": bool(s.youtube_api_key),
    }
    circuits = up.states()
    degraded = [p for p, c in circuits.items() if c["state"] != "closed"]
    return {"ok": True, "degraded": degraded, "circuits": circuits, "cache": request.app.state.cache.kind, "configured": configured}
