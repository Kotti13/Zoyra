"""Shared httpx client with timeouts, retries (backoff) and a circuit breaker per provider."""

import asyncio
import logging
import random
import time
from collections.abc import Callable
from typing import Any

import httpx

from .config import Settings
from .errors import GatewayError

log = logging.getLogger("gateway.upstream")


class CircuitBreaker:
    """closed -> (N consecutive failures) -> open for `open_seconds` -> half-open (one trial) -> closed/open."""

    def __init__(self, threshold: int, open_seconds: float, clock: Callable[[], float] = time.monotonic):
        self.threshold = threshold
        self.open_seconds = open_seconds
        self._clock = clock
        self.failures = 0
        self.opened_at: float | None = None
        self._trial = False

    @property
    def state(self) -> str:
        if self.opened_at is None:
            return "closed"
        return "half_open" if self._clock() - self.opened_at >= self.open_seconds else "open"

    def retry_after(self) -> int:
        if self.opened_at is None:
            return 0
        return max(1, int(self.open_seconds - (self._clock() - self.opened_at)) + 1)

    def allow(self) -> bool:
        s = self.state
        if s == "closed":
            return True
        if s == "half_open" and not self._trial:
            self._trial = True
            return True
        return False

    def success(self) -> None:
        self.failures = 0
        self.opened_at = None
        self._trial = False

    def failure(self) -> None:
        self.failures += 1
        self._trial = False
        if self.opened_at is not None or self.failures >= self.threshold:
            self.opened_at = self._clock()  # (re)open


class Upstream:
    def __init__(self, settings: Settings, *, clock: Callable[[], float] = time.monotonic):
        self.settings = settings
        self._clock = clock
        t = settings.upstream_timeout
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(t, connect=min(t, 4.0)),
            headers={"User-Agent": settings.user_agent, "Accept": "application/json"},
            follow_redirects=False,
            limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
        )
        self.breakers: dict[str, CircuitBreaker] = {}

    def breaker(self, provider: str) -> CircuitBreaker:
        b = self.breakers.get(provider)
        if b is None:
            s = self.settings
            b = self.breakers[provider] = CircuitBreaker(s.breaker_threshold, s.breaker_open_seconds, self._clock)
        return b

    def states(self) -> dict[str, dict[str, Any]]:
        return {p: {"state": b.state, "failures": b.failures} for p, b in self.breakers.items()}

    async def request(
        self,
        provider: str,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        data: Any = None,
        json: Any = None,
        retries: int | None = None,
    ) -> httpx.Response:
        """Returns any response with status < 500 (4xx is the caller's to interpret and does not trip the breaker).
        5xx / timeouts / network errors are retried (idempotent methods only) and then raise 502/503/504."""
        b = self.breaker(provider)
        if not b.allow():
            raise GatewayError(
                503,
                "provider_unavailable",
                f"{provider} is temporarily unavailable. Try again shortly.",
                headers={"Retry-After": str(b.retry_after())},
                provider=provider,
                retryAfter=b.retry_after(),
            )
        attempts = (self.settings.upstream_retries if retries is None else retries) if method.upper() in ("GET", "HEAD") else (retries or 0)
        last: str = "unknown"
        status = 502
        for attempt in range(attempts + 1):
            try:
                res = await self.client.request(method, url, params=params, headers=headers, data=data, json=json)
                if res.status_code < 500:
                    b.success()
                    return res
                last, status = f"upstream returned {res.status_code}", 502
            except httpx.TimeoutException:
                last, status = "upstream timed out", 504
            except httpx.HTTPError as e:
                last, status = f"network error ({type(e).__name__})", 502
            if attempt < attempts:
                await asyncio.sleep(self.settings.upstream_backoff * (2**attempt) * (0.5 + random.random()))
        b.failure()
        log.warning("upstream failed", extra={"provider": provider, "reason": last, "breaker": b.state})
        raise GatewayError(status, "upstream_failed", f"{provider} request failed: {last}.", provider=provider)

    async def close(self) -> None:
        await self.client.aclose()


def json_or_raise(res: httpx.Response, provider: str) -> Any:
    """Parse a successful response or map a 4xx onto the gateway error format."""
    if res.status_code == 404:
        raise GatewayError(404, "not_found", "Not found.", provider=provider)
    if res.status_code == 429:
        raise GatewayError(503, "upstream_rate_limited", f"{provider} is rate limiting us. Try again shortly.", headers={"Retry-After": "30"}, provider=provider)
    if res.status_code in (401, 403):
        raise GatewayError(502, "upstream_auth_failed", f"{provider} rejected the gateway credentials.", provider=provider)
    if res.status_code >= 400:
        raise GatewayError(400 if res.status_code == 400 else 502, "bad_request" if res.status_code == 400 else "upstream_error", f"{provider} returned {res.status_code}.", provider=provider)
    try:
        return res.json()
    except ValueError:
        raise GatewayError(502, "upstream_error", f"{provider} returned invalid JSON.", provider=provider) from None
