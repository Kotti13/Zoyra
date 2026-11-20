"""Token bucket per key. In-memory by default, Redis (atomic Lua) when REDIS_URL is set."""

import time
from collections import OrderedDict

_LUA = """
local k=KEYS[1]
local rate=tonumber(ARGV[1]); local cap=tonumber(ARGV[2]); local now=tonumber(ARGV[3])
local d=redis.call('HMGET',k,'t','ts')
local t=tonumber(d[1]); local ts=tonumber(d[2])
if t==nil then t=cap; ts=now end
t=math.min(cap,t+(now-ts)*rate)
local ok=0
if t>=1 then t=t-1; ok=1 end
redis.call('HSET',k,'t',t,'ts',now)
redis.call('PEXPIRE',k,math.ceil(cap/rate*1000)+1000)
return {ok, tostring(t)}
"""


class MemoryLimiter:
    def __init__(self, max_keys: int = 20000, clock=time.monotonic):
        self._b: OrderedDict[str, tuple[float, float]] = OrderedDict()
        self._max = max_keys
        self._clock = clock

    async def allow(self, key: str, per_minute: int, burst: int | None = None) -> tuple[bool, float]:
        """Returns (allowed, retry_after_seconds)."""
        rate = per_minute / 60.0
        cap = float(burst or per_minute)
        now = self._clock()
        tokens, ts = self._b.get(key, (cap, now))
        tokens = min(cap, tokens + (now - ts) * rate)
        ok = tokens >= 1
        if ok:
            tokens -= 1
        self._b[key] = (tokens, now)
        self._b.move_to_end(key)
        while len(self._b) > self._max:
            self._b.popitem(last=False)
        return ok, 0.0 if ok else (1 - tokens) / rate

    async def close(self) -> None:
        self._b.clear()


class RedisLimiter:
    def __init__(self, url: str, prefix: str = "gw:rl:"):
        import redis.asyncio as redis

        self._r = redis.from_url(url, decode_responses=True)
        self._prefix = prefix
        self._script = self._r.register_script(_LUA)

    async def allow(self, key: str, per_minute: int, burst: int | None = None) -> tuple[bool, float]:
        rate = per_minute / 60.0
        cap = burst or per_minute
        try:
            ok, tokens = await self._script(keys=[self._prefix + key], args=[rate, cap, time.time()])
        except Exception:
            return True, 0.0  # fail open: Redis trouble must not take the API down
        return bool(ok), 0.0 if ok else (1 - float(tokens)) / rate

    async def close(self) -> None:
        await self._r.aclose()


def build_limiter(redis_url: str):
    return RedisLimiter(redis_url) if redis_url else MemoryLimiter()
