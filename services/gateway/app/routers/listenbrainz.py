"""ListenBrainz: submit listens and validate a token. The user's ListenBrainz token travels in
X-ListenBrainz-Token (Authorization carries the Supabase JWT) and is forwarded, never stored or logged."""

from typing import Any

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse

from ..deps import rate_limit, uncached_json
from ..errors import GatewayError

router = APIRouter(prefix="/v1/listenbrainz", tags=["listenbrainz"])


def _token(v: str | None) -> dict[str, str]:
    if not v or not v.strip():
        raise GatewayError(400, "bad_request", "X-ListenBrainz-Token header is required.")
    return {"Authorization": f"Token {v.strip()}"}


def _passthrough(res) -> JSONResponse:
    try:
        body: Any = res.json()
    except ValueError:
        body = {"error": {"code": "upstream_error", "message": f"ListenBrainz returned {res.status_code}."}}
    if res.status_code >= 400 and isinstance(body, dict) and not isinstance(body.get("error"), dict):
        # keep LB's own code/message but in our envelope
        body = {"error": {"code": "listenbrainz_rejected", "message": str(body.get("error") or "ListenBrainz rejected the request."), "upstreamCode": body.get("code")}}
    return uncached_json(body, res.status_code)


@router.get("/validate-token")
async def validate_token(request: Request, x_listenbrainz_token: str | None = Header(None), _=Depends(rate_limit("listenbrainz", auth=True))):
    s = request.app.state.settings
    res = await request.app.state.upstream.request("listenbrainz", "GET", f"{s.listenbrainz_base}/validate-token", headers=_token(x_listenbrainz_token))
    return _passthrough(res)


@router.post("/submit-listens")
async def submit_listens(request: Request, body: dict[str, Any], x_listenbrainz_token: str | None = Header(None), _=Depends(rate_limit("listenbrainz", auth=True))):
    s = request.app.state.settings
    if body.get("listen_type") not in ("single", "playing_now", "import") or not isinstance(body.get("payload"), list) or len(body["payload"]) > 1000:
        raise GatewayError(400, "bad_request", "Expected {listen_type, payload[]} (max 1000 listens).")
    # POST is not retried: a retry after a lost response could duplicate listens.
    res = await request.app.state.upstream.request("listenbrainz", "POST", f"{s.listenbrainz_base}/submit-listens", headers=_token(x_listenbrainz_token), json=body)
    return _passthrough(res)
