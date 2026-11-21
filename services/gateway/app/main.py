import json
import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from .cache import build_cache
from .config import Settings, get_settings
from .errors import install_error_handlers
from .ratelimit import build_limiter
from .routers import audius, concerts, lastfm, librivox, listenbrainz, lyrics, meta, newpipe, spotify, youtube, zoyra_compat
from .upstream import Upstream

_STD = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    """One JSON object per line. Only explicit `extra=` fields are added; never log tokens or query strings."""

    def format(self, record: logging.LogRecord) -> str:
        out = {"ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"), "level": record.levelname, "logger": record.name, "msg": record.getMessage()}
        out.update({k: v for k, v in record.__dict__.items() if k not in _STD})
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, default=str)


def setup_logging(level: str) -> None:
    h = logging.StreamHandler()
    h.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [h]
    root.setLevel(level.upper())
    logging.getLogger("httpx").setLevel(logging.WARNING)  # httpx logs full URLs (may carry API keys)


def create_app(settings: Settings | None = None) -> FastAPI:
    s = settings or get_settings()
    setup_logging(s.log_level)
    access = logging.getLogger("gateway.access")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.upstream = Upstream(s)
        yield
        await app.state.upstream.close()
        await app.state.cache.close()
        await app.state.limiter.close()

    app = FastAPI(title="Zoyra Gateway", version="0.1.0", lifespan=lifespan, docs_url=None if s.env == "prod" else "/docs", redoc_url=None)
    app.state.settings = s
    app.state.cache = build_cache(s.redis_url, s.ttl_stale)
    app.state.limiter = build_limiter(s.redis_url)
    install_error_handlers(app)

    if s.cors_list:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=s.cors_list,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "X-Spotify-Token", "X-ListenBrainz-Token", "X-Request-ID"],
            expose_headers=["X-Request-ID", "X-Cache", "Retry-After"],
        )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        rid = request.headers.get("x-request-id", "")[:64] or uuid.uuid4().hex[:16]
        request.state.request_id = rid
        t0 = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            ms = (time.perf_counter() - t0) * 1000
            response.headers["X-Request-ID"] = rid
            response.headers["Server-Timing"] = f"app;dur={ms:.1f}"
            return response
        finally:
            access.info("request", extra={"request_id": rid, "method": request.method, "path": request.url.path, "status": status, "ms": round((time.perf_counter() - t0) * 1000, 1)})

    @app.get("/healthz", include_in_schema=False)
    async def healthz():
        return {"ok": True}

    for r in (audius, lyrics, librivox, listenbrainz, lastfm, concerts, youtube, newpipe, zoyra_compat, spotify, meta):
        app.include_router(r.router)
    return app


app = create_app() if __name__ != "__main__" else None  # uvicorn app.main:app
