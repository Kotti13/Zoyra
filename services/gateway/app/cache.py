"""Async TTL cache: in-memory LRU by default, Redis when REDIS_URL is set.

`Cache.get_or_load` adds two behaviours on top of plain storage:
* request coalescing: identical in-flight loads share one upstream call;
* stale-while-error: if the loader fails and an expired entry is still inside its stale window, serve it.
Values must be JSON-serialisable (they are stored as JSON in Redis).
"""

import asyncio
import json
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol


@dataclass
class Entry:
    value: Any
    fresh_until: float
    stale_until: float


@dataclass
class CacheResult:
    value: Any
    state: str  # hit | miss | stale


class Backend(Protocol):
    async def get(self, key: str) -> Entry | None: ...
    async def set(self, key: str, entry: Entry) -> None: ...
    async def close(self) -> None: ...


class MemoryBackend:
    kind = "memory"

    def __init__(self, max_items: int = 5000):
        self.max_items = max_items
        self._data: OrderedDict[str, Entry] = OrderedDict()

    async def get(self, key: str) -> Entry | None:
        e = self._data.get(key)
        if e is None:
            return None
        if e.stale_until <= time.time():
            self._data.pop(key, None)
            return None
        self._data.move_to_end(key)
        return e

    async def set(self, key: str, entry: Entry) -> None:
        self._data[key] = entry
        self._data.move_to_end(key)
        while len(self._data) > self.max_items:
            self._data.popitem(last=False)

    async def close(self) -> None:
        self._data.clear()


class RedisBackend:
    kind = "redis"

    def __init__(self, url: str, prefix: str = "gw:cache:"):
        import redis.asyncio as redis

        self._r = redis.from_url(url, decode_responses=True)
        self._prefix = prefix

    async def get(self, key: str) -> Entry | None:
        raw = await self._r.get(self._prefix + key)
        if raw is None:
            return None
        d = json.loads(raw)
        return Entry(d["v"], d["f"], d["s"])

    async def set(self, key: str, entry: Entry) -> None:
        ttl_ms = max(1, int((entry.stale_until - time.time()) * 1000))
        await self._r.set(self._prefix + key, json.dumps({"v": entry.value, "f": entry.fresh_until, "s": entry.stale_until}), px=ttl_ms)

    async def close(self) -> None:
        await self._r.aclose()


class Cache:
    def __init__(self, backend: Backend, default_stale: int = 86400):
        self.backend = backend
        self.default_stale = default_stale
        self._inflight: dict[str, asyncio.Task[CacheResult]] = {}

    @property
    def kind(self) -> str:
        return getattr(self.backend, "kind", "custom")

    async def get_or_load(
        self,
        key: str,
        ttl: float,
        loader: Callable[[], Awaitable[Any]],
        *,
        stale_ttl: float | None = None,
    ) -> CacheResult:
        entry: Entry | None = None
        try:
            entry = await self.backend.get(key)
        except Exception:  # a broken cache must never break requests
            entry = None
        if entry is not None and entry.fresh_until > time.time():
            return CacheResult(entry.value, "hit")

        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._load(key, ttl, stale_ttl, loader, entry))
            self._inflight[key] = task
            task.add_done_callback(lambda _t, k=key: self._inflight.pop(k, None))
        # shield: one caller disconnecting must not cancel the load the others are waiting on
        return await asyncio.shield(task)

    async def _load(self, key: str, ttl: float, stale_ttl: float | None, loader: Callable[[], Awaitable[Any]], old: Entry | None) -> CacheResult:
        try:
            value = await loader()
        except Exception:
            if old is not None and old.stale_until > time.time():
                return CacheResult(old.value, "stale")
            raise
        now = time.time()
        try:
            await self.backend.set(key, Entry(value, now + ttl, now + ttl + (self.default_stale if stale_ttl is None else stale_ttl)))
        except Exception:
            pass
        return CacheResult(value, "miss")

    async def close(self) -> None:
        await self.backend.close()


def build_cache(redis_url: str, default_stale: int) -> Cache:
    backend: Backend = RedisBackend(redis_url) if redis_url else MemoryBackend()
    return Cache(backend, default_stale)
