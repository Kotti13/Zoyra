"""Minimal PostgREST access (service role) for the Last.fm session key in public.scrobble_accounts.
Server-only credentials; the key never reaches the app."""

from urllib.parse import quote

from .config import Settings
from .errors import GatewayError
from .upstream import Upstream

TABLE = "scrobble_accounts"


class ScrobbleStore:
    def __init__(self, s: Settings, up: Upstream):
        if not (s.supabase_url and s.supabase_service_role_key):
            raise GatewayError(503, "not_configured", "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.", service="supabase")
        self.base = f"{s.supabase_url.rstrip('/')}/rest/v1/{TABLE}"
        self.h = {"apikey": s.supabase_service_role_key, "Authorization": f"Bearer {s.supabase_service_role_key}"}
        self.up = up

    def _filter(self, user_id: str, service: str) -> str:
        return f"user_id=eq.{quote(user_id, safe='')}&service=eq.{quote(service, safe='')}"

    async def get_secret(self, user_id: str, service: str) -> str | None:
        res = await self.up.request("supabase", "GET", f"{self.base}?{self._filter(user_id, service)}&select=secret", headers=self.h)
        if res.status_code >= 400:
            raise GatewayError(502, "db_failed", "Could not read the account.", provider="supabase")
        rows = res.json()
        return rows[0].get("secret") if rows else None

    async def upsert(self, user_id: str, service: str, username: str, secret: str) -> None:
        from datetime import UTC, datetime

        res = await self.up.request(
            "supabase",
            "POST",
            f"{self.base}?on_conflict=user_id,service",
            headers={**self.h, "Prefer": "resolution=merge-duplicates,return=minimal"},
            json={"user_id": user_id, "service": service, "username": username[:100], "secret": secret, "updated_at": datetime.now(UTC).isoformat()},
        )
        if res.status_code >= 400:
            raise GatewayError(502, "db_failed", "Could not save the account.", provider="supabase")

    async def delete(self, user_id: str, service: str) -> None:
        await self.up.request("supabase", "DELETE", f"{self.base}?{self._filter(user_id, service)}", headers=self.h)
