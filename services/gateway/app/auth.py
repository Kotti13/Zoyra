"""Verify the Supabase user JWT (Authorization: Bearer). HS256 secret or JWKS (asymmetric keys)."""

import asyncio
from typing import Any

import jwt
from fastapi import Depends, Request
from jwt import PyJWKClient
from pydantic import BaseModel

from .config import Settings
from .errors import GatewayError


class User(BaseModel):
    id: str
    email: str | None = None
    role: str | None = None


_jwks: dict[str, PyJWKClient] = {}


def _bearer(request: Request) -> str | None:
    h = request.headers.get("authorization", "")
    scheme, _, token = h.partition(" ")
    return token.strip() if scheme.lower() == "bearer" and token.strip() else None


def auth_configured(s: Settings) -> bool:
    return bool(s.supabase_jwt_secret or s.supabase_jwks_url)


async def decode_token(token: str, s: Settings) -> dict[str, Any]:
    try:
        alg = jwt.get_unverified_header(token).get("alg", "")
        opts = {"require": ["exp", "sub"]}
        if alg == "HS256" and s.supabase_jwt_secret:
            return jwt.decode(token, s.supabase_jwt_secret, algorithms=["HS256"], audience=s.supabase_jwt_audience, options=opts)
        if s.supabase_jwks_url and alg in ("ES256", "RS256", "EdDSA"):
            client = _jwks.setdefault(s.supabase_jwks_url, PyJWKClient(s.supabase_jwks_url, cache_keys=True, lifespan=3600))
            key = await asyncio.to_thread(client.get_signing_key_from_jwt, token)
            return jwt.decode(token, key.key, algorithms=[alg], audience=s.supabase_jwt_audience, options=opts)
    except jwt.PyJWTError:
        raise GatewayError(401, "invalid_token", "Your session is invalid or expired. Sign in again.") from None
    except Exception:  # JWKS fetch trouble
        raise GatewayError(503, "auth_unavailable", "Could not verify your session right now.") from None
    raise GatewayError(401, "invalid_token", "Unsupported token.")


async def optional_user(request: Request) -> User | None:
    """None when anonymous (or auth is not configured); 401 when a token is present but bad."""
    token = _bearer(request)
    s: Settings = request.app.state.settings
    if not token or not auth_configured(s):
        return None
    claims = await decode_token(token, s)
    return User(id=str(claims["sub"]), email=claims.get("email"), role=claims.get("role"))


async def require_user(request: Request, user: User | None = Depends(optional_user)) -> User:
    if user is not None:
        return user
    if not auth_configured(request.app.state.settings):
        raise GatewayError(503, "auth_not_configured", "The gateway has no Supabase JWT secret or JWKS URL configured.")
    raise GatewayError(401, "unauthorized", "Sign in to use this feature.")
