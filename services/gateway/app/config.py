"""Environment settings. Nothing secret is hard-coded; every key comes from the environment."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", populate_by_name=True)

    env: str = "dev"
    log_level: str = "INFO"
    cors_origins: str = ""
    trust_proxy: bool = False

    # auth
    supabase_jwt_secret: str = ""
    supabase_jwks_url: str = ""
    supabase_jwt_audience: str = "authenticated"
    supabase_url: str = ""
    supabase_service_role_key: str = ""

    redis_url: str = ""

    # providers
    audius_base: str = "https://api.audius.co/v1"
    audius_app_name: str = "zoyra"
    lrclib_base: str = "https://lrclib.net/api"
    librivox_base: str = "https://librivox.org/api/feed/audiobooks"
    listenbrainz_base: str = "https://api.listenbrainz.org/1"
    lastfm_base: str = "https://ws.audioscrobbler.com/2.0/"
    lastfm_api_key: str = ""
    lastfm_shared_secret: str = ""
    ticketmaster_base: str = "https://app.ticketmaster.com/discovery/v2/events.json"
    ticketmaster_api_key: str = ""
    youtube_base: str = "https://www.googleapis.com/youtube/v3"
    youtube_api_key: str = ""
    spotify_base: str = "https://api.spotify.com/v1"
    # NewPipe sidecar (services/newpipe). Empty = feature off and the route answers 503 not_configured.
    newpipe_base: str = ""
    newpipe_token: str = ""
    # Shared key for the app-facing /api/* routes (same value as EXPO_PUBLIC_ZOYRA_API_KEY). Required: those routes
    # stream audio through this server, so they must never be open to anyone.
    zoyra_api_key: str = ""
    user_agent: str = "ZoyraGateway/0.1"

    # cache TTLs (seconds)
    ttl_audius: int = 300
    ttl_audius_detail: int = 1800
    ttl_lyrics: int = 7 * 86400
    ttl_lyrics_miss: int = 6 * 3600
    ttl_librivox: int = 1800
    ttl_concerts: int = 900
    ttl_newpipe_search: int = 6 * 3600
    ttl_newpipe_artist: int = 24 * 3600
    ttl_newpipe_suggest: int = 6 * 3600
    ttl_newpipe_stream: int = 20 * 60  # stream URLs expire after a few hours; stay well inside that
    ttl_stale: int = 86400  # how long an expired entry may still be served when the provider fails

    # upstream behaviour
    upstream_timeout: float = Field(7.0, description="seconds per upstream attempt")
    upstream_retries: int = 2
    upstream_backoff: float = 0.25
    breaker_threshold: int = 5
    breaker_open_seconds: float = 30.0

    # rate limits: requests per minute per client; signed-in users get a multiple
    rl_default: int = 120
    rl_audius: int = 240
    rl_lyrics: int = 120
    rl_librivox: int = 60
    rl_youtube: int = 60
    rl_lastfm: int = 60
    rl_concerts: int = 30
    rl_spotify: int = 60
    rl_newpipe: int = 300  # the app fans out: one search also pre-loads streams; sign-up looks up ~30 covers and photos
    rl_suggest: int = 240  # one call per pause while typing
    rl_listenbrainz: int = 60
    rl_user_multiplier: int = 3

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def rate_for(self, name: str) -> int:
        return int(getattr(self, f"rl_{name}", self.rl_default))


@lru_cache
def get_settings() -> Settings:
    return Settings()
