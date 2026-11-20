"""Shared route dependencies: per-route rate limiting and cached JSON responses."""

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from .auth import User, optional_user, require_user
from .cache import CacheResult
from .errors import GatewayError


def client_ip(request: Request) -> str:
    if request.app.state.settings.trust_proxy:
        fwd = request.headers.get("x-forwarded-for", "")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limit(name: str, *, auth: bool = False) -> Callable[..., Awaitable[User | None]]:
    """Dependency: limits per user id (signed in) or per IP (anonymous). auth=True also requires sign-in."""

    async def dep(request: Request, user: User | None = Depends(require_user if auth else optional_user)) -> User | None:
        s = request.app.state.settings
        per_min = s.rate_for(name)
        if user is not None:
            key, per_min = f"{name}:u:{user.id}", per_min * s.rl_user_multiplier
        else:
            key = f"{name}:ip:{client_ip(request)}"
        ok, retry = await request.app.state.limiter.allow(key, per_min)
        if not ok:
            wait = max(1, int(retry) + 1)
            raise GatewayError(429, "rate_limited", "Too many requests. Slow down a little.", headers={"Retry-After": str(wait)}, retryAfter=wait)
        return user

    return dep


def cached_json(result: CacheResult, ttl: int, *, public: bool = True) -> JSONResponse:
    scope = "public" if public else "private"
    return JSONResponse(result.value, headers={"X-Cache": result.state.upper(), "Cache-Control": f"{scope}, max-age={ttl}"})


def uncached_json(body: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})


def plain_json(body: Any, ttl: int, *, public: bool = True) -> JSONResponse:
    return JSONResponse(body, headers={"Cache-Control": f"{'public' if public else 'private'}, max-age={ttl}"})
