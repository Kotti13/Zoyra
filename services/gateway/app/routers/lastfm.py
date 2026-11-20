"""Last.fm scrobbling. Same contract as supabase/functions/lastfm: POST { action, ... }.
auth_url | session | now_playing | scrobble | disconnect. API key and shared secret stay on the server;
the session key is stored in public.scrobble_accounts via the Supabase service role."""

import hashlib
from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Request

from ..auth import User
from ..deps import rate_limit, uncached_json
from ..errors import GatewayError
from ..supabase_rest import ScrobbleStore

router = APIRouter(prefix="/v1/lastfm", tags=["lastfm"])
SERVICE = "lastfm"


def sign(params: dict[str, str], secret: str) -> str:
    base = "".join(k + params[k] for k in sorted(params) if k not in ("format", "callback"))
    return hashlib.md5((base + secret).encode("utf-8"), usedforsecurity=False).hexdigest()  # noqa: S324 (Last.fm requires md5)


def _s(v: Any, mx: int = 300) -> str | None:
    return v.strip()[:mx] if isinstance(v, str) and v.strip() else None


def _i(v: Any) -> int | None:
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else None


def parse_track(v: Any) -> dict[str, Any] | None:
    if not isinstance(v, dict):
        return None
    artist, track = _s(v.get("artist")), _s(v.get("track"))
    if not artist or not track:
        return None
    return {"artist": artist, "track": track, "album": _s(v.get("album")), "duration": _i(v.get("duration")), "timestamp": _i(v.get("timestamp"))}


async def call(request: Request, params: dict[str, str]) -> tuple[bool, dict[str, Any], int, str]:
    s = request.app.state.settings
    signed = {**params, "api_sig": sign(params, s.lastfm_shared_secret), "format": "json"}
    res = await request.app.state.upstream.request("lastfm", "POST", s.lastfm_base, data=signed)
    try:
        body = res.json()
    except ValueError:
        body = None
    if isinstance(body, dict) and isinstance(body.get("error"), int):
        return False, {}, body["error"], body.get("message") or "Last.fm error"
    if res.status_code >= 400 or not isinstance(body, dict):
        return False, {}, 0, f"Last.fm request failed ({res.status_code})"
    return True, body, 0, ""


def fail(code: int, message: str) -> GatewayError:
    if code == 9:
        return GatewayError(401, "lastfm_session_invalid", "Last.fm access was revoked. Connect again.")
    if code in (10, 26):
        return GatewayError(502, "lastfm_failed", "Last.fm rejected the API key.", retryable=False)
    return GatewayError(502, "lastfm_failed", message, retryable=code in (0, 11, 16, 29))


@router.post("")
async def lastfm(request: Request, body: dict[str, Any], user: User = Depends(rate_limit("lastfm", auth=True))):
    s = request.app.state.settings
    if not (s.lastfm_api_key and s.lastfm_shared_secret):
        raise GatewayError(503, "not_configured", "Last.fm is not configured.", service="lastfm")
    action = _s(body.get("action"), 40)

    if action == "auth_url":
        cb = _s(body.get("cb"), 300)
        if not cb or not cb.lower().startswith(("zoyra://", "exp://", "exps://")):
            raise GatewayError(400, "invalid_body", "cb must be an app link.")
        return uncached_json({"url": "https://www.last.fm/api/auth/?" + urlencode({"api_key": s.lastfm_api_key, "cb": cb})})

    store = ScrobbleStore(s, request.app.state.upstream)

    if action == "session":
        token = _s(body.get("token"), 100)
        if not token:
            raise GatewayError(400, "invalid_body", "token is required.")
        ok, data, code, msg = await call(request, {"method": "auth.getSession", "api_key": s.lastfm_api_key, "token": token})
        if not ok:
            if code in (4, 14, 15):
                raise GatewayError(400, "invalid_token", msg)
            raise fail(code, msg)
        sess = data.get("session") or {}
        if not sess.get("key") or not sess.get("name"):
            raise GatewayError(502, "lastfm_failed", "Last.fm returned no session.", retryable=False)
        await store.upsert(user.id, SERVICE, sess["name"], sess["key"])
        return uncached_json({"username": sess["name"]})

    if action == "disconnect":
        await store.delete(user.id, SERVICE)
        return uncached_json({"ok": True})

    if action not in ("now_playing", "scrobble"):
        raise GatewayError(400, "invalid_body", "Unknown action.")
    sk = await store.get_secret(user.id, SERVICE)
    if not sk:
        raise GatewayError(409, "not_connected", "Last.fm is not connected.")

    async def revoked(code: int, msg: str) -> GatewayError:
        if code == 9:
            await store.delete(user.id, SERVICE)
        return fail(code, msg)

    if action == "now_playing":
        t = parse_track(body.get("track"))
        if not t:
            raise GatewayError(400, "invalid_body", "track needs artist and track.")
        p = {"method": "track.updateNowPlaying", "api_key": s.lastfm_api_key, "sk": sk, "artist": t["artist"], "track": t["track"]}
        if t["album"]:
            p["album"] = t["album"]
        if t["duration"]:
            p["duration"] = str(t["duration"])
        ok, _, code, msg = await call(request, p)
        if not ok:
            raise await revoked(code, msg)
        return uncached_json({"ok": True})

    raw = body.get("tracks") if isinstance(body.get("tracks"), list) else []
    tracks = [t for t in (parse_track(x) for x in raw[:50]) if t and t["timestamp"]]
    if not tracks:
        raise GatewayError(400, "invalid_body", "tracks need artist, track and timestamp.")
    p = {"method": "track.scrobble", "api_key": s.lastfm_api_key, "sk": sk}
    for i, t in enumerate(tracks):
        p[f"artist[{i}]"], p[f"track[{i}]"], p[f"timestamp[{i}]"] = t["artist"], t["track"], str(t["timestamp"])
        if t["album"]:
            p[f"album[{i}]"] = t["album"]
        if t["duration"]:
            p[f"duration[{i}]"] = str(t["duration"])
    ok, data, code, msg = await call(request, p)
    if not ok:
        raise await revoked(code, msg)
    attr = (data.get("scrobbles") or {}).get("@attr") or {}
    return uncached_json({"accepted": int(attr.get("accepted") or 0), "ignored": int(attr.get("ignored") or 0)})
