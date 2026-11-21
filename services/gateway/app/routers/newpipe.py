"""NewPipe Extractor, via the internal sidecar in services/newpipe: YouTube search + a direct audio URL.

Off by default: with NEWPIPE_BASE empty every call answers 503 not_configured. Unlike the youtube router (official Data
API, embedded player only), this extracts raw stream URLs, which YouTube's terms do not allow and which can break whenever
YouTube changes. Keep it behind your own decision to enable it.

POST { action: "search", q } | { action: "stream", id }   (sign-in required)
"""

import re
from typing import Any

from fastapi import APIRouter, Depends, Request

from ..auth import User
from ..deps import plain_json, rate_limit
from ..errors import GatewayError

router = APIRouter(prefix="/v1/newpipe", tags=["newpipe"])

ID = re.compile(r"^[A-Za-z0-9_-]{6,20}$")


def _s(v: Any, mx: int = 100) -> str | None:
    return v.strip()[:mx] if isinstance(v, str) and v.strip() else None


TOPIC = re.compile(r"\s*-\s*Topic\s*$", re.I)  # auto-generated artist channels: "Artist - Topic"
SIZE_PARAM = re.compile(r"=(?:w\d+-h\d+|s\d+)(?=-|$)")


def art_url(u: Any) -> str | None:
    """https thumbnail only. YouTube Music album art ends in =w60-h60-...: ask for 544 px instead of a 60 px blur."""
    if not isinstance(u, str) or not u.startswith("https://"):
        return None
    host = u.split("/")[2] if u.count("/") >= 2 else ""
    return SIZE_PARAM.sub(lambda m: "=s544" if m.group(0).startswith("=s") else "=w544-h544", u, count=1) if host.endswith("googleusercontent.com") else u


def clean_track(t: Any) -> dict | None:
    """Keep only the fields the app needs, with types enforced, from the sidecar's search item."""
    if not isinstance(t, dict) or not isinstance(t.get("id"), str) or not ID.match(t["id"]) or not isinstance(t.get("title"), str):
        return None
    dur = t.get("durationSec")
    views = t.get("views")
    return {
        "id": t["id"],
        "title": t["title"][:200],
        "artist": TOPIC.sub("", t["artist"])[:120] if isinstance(t.get("artist"), str) else "",
        "durationSec": dur if isinstance(dur, int) and dur > 0 else None,
        "views": views if isinstance(views, int) and views >= 0 else None,
        "thumbnail": art_url(t.get("thumbnail")),
    }


def clean_stream(d: Any) -> dict | None:
    t = clean_track(d)
    audio = d.get("audio") if isinstance(d, dict) else None
    if not t or not isinstance(audio, dict) or not isinstance(audio.get("url"), str) or not audio["url"].startswith("https://"):
        return None
    bitrate = audio.get("bitrate")
    video = d.get("video") if isinstance(d, dict) else None
    clean_video = None
    if isinstance(video, dict) and isinstance(video.get("url"), str) and video["url"].startswith("https://"):
        h = video.get("height")
        clean_video = {"url": video["url"], "mime": "video/mp4", "height": h if isinstance(h, int) and h > 0 else None}
    return {
        **t,
        "video": clean_video,
        "audio": {
            "url": audio["url"],
            "mime": audio["mime"] if isinstance(audio.get("mime"), str) else None,
            "bitrate": bitrate if isinstance(bitrate, int) and bitrate > 0 else None,
        },
    }


async def sidecar(request: Request, path: str, **params: str) -> Any:
    s = request.app.state.settings
    headers = {"X-Internal-Token": s.newpipe_token} if s.newpipe_token else None
    res = await request.app.state.upstream.request("newpipe", "GET", f"{s.newpipe_base.rstrip('/')}/{path}", params=params, headers=headers, retries=0)
    try:
        data = res.json()
    except ValueError:
        data = {}
    if res.status_code == 400:
        raise GatewayError(404, "not_found", ((data.get("error") or {}).get("message")) or "Nothing playable for that.")
    if res.status_code in (401, 403):
        raise GatewayError(503, "not_configured", "The NewPipe service rejected the gateway token.", service="newpipe")
    if res.status_code >= 400:
        raise GatewayError(502, "newpipe_failed", "Could not read that from YouTube right now.")
    return data


async def search_tracks(request: Request, q: str, limit: int = 50) -> dict:
    """Cached search through the sidecar -> {"tracks": [...]}.

    Two tiers: up to 20 songs is one result page (fast, what the All tab needs); more reads further pages. Each tier is
    cached once per query and callers slice what they need."""
    s = request.app.state.settings
    tier = 20 if limit <= 20 else 50

    async def load():
        data = await sidecar(request, "search", q=q, limit=str(tier))
        return {"tracks": [t for t in map(clean_track, data.get("tracks") or []) if t]}

    return (await request.app.state.cache.get_or_load(f"np:search{tier}:{q.lower()}", s.ttl_newpipe_search, load)).value


URL_RE = re.compile(r"https?://[^\s<>\"')\]]+", re.I)
# (host suffix, label, kind) in priority order; anything else becomes a plain "Website".
LINK_KINDS = [
    ("patreon.com", "Patreon", "tip"), ("ko-fi.com", "Ko-fi", "tip"), ("buymeacoffee.com", "Buy me a coffee", "tip"), ("paypal.me", "PayPal", "tip"), ("paypal.com", "PayPal", "tip"),
    ("instagram.com", "Instagram", "ig"), ("x.com", "X (Twitter)", "x"), ("twitter.com", "X (Twitter)", "x"), ("tiktok.com", "TikTok", "tt"), ("facebook.com", "Facebook", "fb"),
    ("music.apple.com", "Apple Music", "music"), ("open.spotify.com", "Spotify", "music"), ("spotify.com", "Spotify", "music"), ("music.youtube.com", "YouTube Music", "music"),
]
SKIP_HOSTS = ("youtube.com", "youtu.be", "google.com", "goo.gl", "bit.ly")  # redirects and the channel itself, not the artist's own links


def extract_links(text: Any, channel_url: Any = None) -> list[dict]:
    """The artist's own links from their channel description (https only, no duplicates), plus the channel itself."""
    out: list[dict] = []
    seen: set[str] = set()
    for raw in URL_RE.findall(text if isinstance(text, str) else ""):
        url = raw.rstrip(".,;:!?")
        host = (url.split("/")[2] if url.count("/") >= 2 else "").lower().split(":")[0]
        if not url.lower().startswith("https://") or not host or url in seen or len(url) > 300:
            continue
        kind = next(((lab, k) for suf, lab, k in LINK_KINDS if host == suf or host.endswith("." + suf)), None)
        if kind is None and any(host == h or host.endswith("." + h) for h in SKIP_HOSTS):
            continue
        seen.add(url)
        out.append({"key": kind[1] if kind else "site", "label": kind[0] if kind else "Website", "url": url, "detail": host.removeprefix("www.")})
    order = {"tip": 0, "site": 1, "ig": 2, "x": 3, "tt": 4, "fb": 5, "music": 6}
    out = sorted(out, key=lambda x: order.get(x["key"], 9))[:8]
    if isinstance(channel_url, str) and channel_url.startswith("https://"):
        out.append({"key": "yt", "label": "YouTube channel", "url": channel_url, "detail": "Subscribe and watch their videos"})
    return out


def clean_artist(a: Any) -> dict | None:
    """Name + https image (+ banner, bio for a single artist). Subscriber counts are left out: YouTube Music's
    figure for artists is not a follower count, so showing it as one would mislead."""
    if not isinstance(a, dict) or not isinstance(a.get("name"), str) or not a["name"].strip():
        return None
    banner = a.get("banner")
    desc = a.get("description")
    return {
        "name": a["name"].strip()[:120],
        "image": art_url(a.get("image")),
        "banner": banner if isinstance(banner, str) and banner.startswith("https://") else None,
        "description": desc[:600] if isinstance(desc, str) and desc.strip() else None,
        "links": extract_links(desc, a.get("channelUrl")),
        "verified": a.get("verified") is True,
    }


async def artists_search(request: Request, q: str) -> list[dict]:
    s = request.app.state.settings

    async def load():
        data = await sidecar(request, "artists", q=q)
        return [x for x in map(clean_artist, data.get("artists") or []) if x][:12]

    return (await request.app.state.cache.get_or_load(f"np:artists:{q.lower()}", s.ttl_newpipe_artist, load)).value


async def artist_info(request: Request, name: str) -> dict:
    s = request.app.state.settings

    async def load():
        clean = clean_artist(await sidecar(request, "artist", name=name))
        if not clean:
            raise GatewayError(404, "not_found", "No artist found.")
        return clean

    return (await request.app.state.cache.get_or_load(f"np:artist:{name.lower()}", s.ttl_newpipe_artist, load)).value


WORD = re.compile(r"[\w']+", re.UNICODE)
NOISE = {"official", "video", "music", "audio", "lyrics", "lyric", "full", "song", "hd", "4k", "from", "feat", "ft", "the", "a", "of"}


# Versions that are not the song's own video; a candidate with one of these is skipped unless the song's title has it too.
OTHER_VERSION = {"karaoke", "cover", "instrumental", "reaction", "tutorial", "lesson", "slowed", "reverb", "remix", "live", "8d", "nightcore", "mashup", "loop", "hour", "hours", "acoustic", "unplugged", "trailer", "teaser", "shorts", "dance", "choreography"}


def _words(text: str) -> set[str]:
    return {w for w in WORD.findall(text.lower()) if w not in NOISE and len(w) > 1}


def pick_music_video(items: list[dict], title: str, artist: str, duration: int | None) -> dict | None:
    """Best official-video candidate for a song: the title words must match, and the length must be close to the
    song's when it is known (a different cut, a live set or a 10 hour loop is not the video of this recording)."""
    want = _words(re.sub(r"\(.*?\)|\[.*?\]", " ", title))
    who = _words(artist)
    best, best_score = None, 0.0
    for it in items:
        c = clean_track(it)
        if not c or not want:
            continue
        title_words = _words(c["title"])
        if (title_words & OTHER_VERSION) - _words(title):
            continue
        have = title_words | _words(c["artist"])
        overlap = len(want & have) / len(want)
        if overlap < 0.6:
            continue
        score = overlap + (0.25 if who and who & have else 0)
        d = c["durationSec"]
        if duration and d:
            diff = abs(d - duration)
            if diff > max(12, duration * 0.12):
                continue
            score += max(0.0, 1 - diff / 30)
        if score > best_score:
            best, best_score = c, score
    return best


async def music_video(request: Request, title: str, artist: str, duration: int | None) -> dict | None:
    """The song's official music video (cached a day), or None when YouTube Music has no matching one."""
    s = request.app.state.settings

    async def load():
        data = await sidecar(request, "videos", q=f"{artist} {title}".strip()[:120])
        return pick_music_video(data.get("videos") or [], title, artist, duration)

    return (await request.app.state.cache.get_or_load(f"np:mv:{artist.lower()}|{title.lower()}|{duration or 0}", s.ttl_newpipe_artist, load)).value


async def suggestions(request: Request, q: str) -> list[str]:
    """Cached search-as-you-type suggestions -> up to 10 short strings."""
    s = request.app.state.settings

    async def load():
        data = await sidecar(request, "suggest", q=q)
        return [x.strip()[:100] for x in (data.get("suggestions") or []) if isinstance(x, str) and x.strip()][:10]

    return (await request.app.state.cache.get_or_load(f"np:suggest:{q.lower()}", s.ttl_newpipe_suggest, load)).value


async def stream_info(request: Request, vid: str, *, fresh: bool = False) -> dict:
    """Cached stream lookup through the sidecar. `fresh` drops the cached copy first (an expired URL answered 403)."""
    s = request.app.state.settings
    cache = request.app.state.cache
    key = f"np:stream:{vid}"
    if fresh:
        await cache.delete(key)

    async def load():
        clean = clean_stream(await sidecar(request, "stream", id=vid))
        if not clean:
            raise GatewayError(404, "not_found", "No playable audio for that video.")
        return clean

    return (await cache.get_or_load(key, s.ttl_newpipe_stream, load, stale_ttl=0)).value  # an expired stream URL is useless: never serve stale


@router.post("")
async def newpipe(request: Request, body: dict[str, Any], _user: User = Depends(rate_limit("newpipe", auth=True))):
    s = request.app.state.settings
    if not s.newpipe_base:
        raise GatewayError(503, "not_configured", "NewPipe is not configured.", service="newpipe")
    action = _s(body.get("action"), 20) or "search"

    if action == "search":
        q = _s(body.get("q"))
        if not q or len(q) < 2:
            raise GatewayError(400, "bad_request", "Type at least 2 characters.")

        return plain_json(await search_tracks(request, q), s.ttl_newpipe_search, public=False)

    if action == "stream":
        vid = _s(body.get("id"), 20)
        if not vid or not ID.match(vid):
            raise GatewayError(400, "bad_request", "stream needs id.")

        return plain_json(await stream_info(request, vid), s.ttl_newpipe_stream, public=False)

    raise GatewayError(400, "bad_request", f'Unknown action "{action}".')
