"""App-facing /api/* routes (the contract in src/lib/zoyra-api.ts), served from NewPipe.

  GET  /api/health
  GET  /api/search?q=&limit=       -> { results: [{ id, title, artist, duration, thumbnail, views }] }
  GET  /api/artists?q=&limit=      -> { results: [{ name, image, verified }] }
  GET  /api/artist?name=           -> { name, image, banner, description, verified }
  GET  /api/suggest?q=             -> { suggestions: ["..."] } (search-as-you-type)
  GET  /api/song/{id}              -> { id, title, artist, duration, thumbnail }
  GET  /api/stream/{id}            -> the audio bytes (Range supported), streamed through this server
  GET  /api/musicvideo?title&artist&duration -> { id, title, durationSec } of the song's official music video (404 when none)
  GET  /api/video/{id}             -> the silent MP4 picture of the same track (Range supported), for the in-app video view
  POST /api/prefetch/{id}          -> warms the stream lookup
  GET  /api/download/{id}          -> the track converted to a real .mp3 (needs ffmpeg on the server)
  GET  /api/lyrics/{id}?title&artist&duration -> LRCLIB lyrics in the app's shape (404 when none)

Streaming through the gateway (instead of handing out the googlevideo URL) matters: those URLs are tied to the IP that
asked for them, so a phone on another network would get 403. Here the sidecar and this process share an egress IP.
Auth is a shared key (?key= for audio players, X-Zoyra-Key for fetch). Not configured = 503, never open.
"""

import asyncio
import hmac
import re
import shutil
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from ..deps import rate_limit
from ..errors import GatewayError
from .lyrics import match_lyrics
from .newpipe import ID, artist_info, artists_search, music_video, search_tracks, stream_info, suggestions

router = APIRouter(prefix="/api", tags=["zoyra-compat"])

# Only ever fetch audio from Google's media hosts, whatever the sidecar returns (SSRF guard).
MEDIA_HOST = re.compile(r"^[a-z0-9.-]+\.googlevideo\.com$")
PASS_HEADERS = ("content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0"


async def require_key(request: Request, key: str | None = Query(default=None)) -> None:
    expected = request.app.state.settings.zoyra_api_key
    if not request.app.state.settings.newpipe_base or not expected:
        raise GatewayError(503, "not_configured", "The music service is not configured.", service="newpipe")
    given = request.headers.get("x-zoyra-key") or key or ""
    if not hmac.compare_digest(expected.encode(), given.encode()):
        raise GatewayError(401, "unauthorized", "Missing or wrong key.")


def _id(v: str) -> str:
    if not ID.match(v):
        raise GatewayError(400, "bad_request", "Bad video id.")
    return v


def _song(t: dict) -> dict:
    return {"id": t["id"], "title": t["title"], "artist": t["artist"] or None, "duration": t["durationSec"], "thumbnail": t["thumbnail"] or f"https://i.ytimg.com/vi/{t['id']}/hq720.jpg", "views": t.get("views")}


@router.get("/health", include_in_schema=False)
async def health():
    return {"ok": True}


@router.get("/search")
async def search(request: Request, q: str = Query(min_length=2, max_length=100), limit: int = Query(default=25, ge=1, le=50), _rl=Depends(rate_limit("newpipe")), _k=Depends(require_key)):
    out = await search_tracks(request, q.strip(), limit)
    return JSONResponse({"results": [_song(t) for t in out["tracks"][:limit]]}, headers={"Cache-Control": "private, max-age=300"})


@router.get("/artists")
async def artists(request: Request, q: str = Query(min_length=2, max_length=100), limit: int = Query(default=10, ge=1, le=12), _rl=Depends(rate_limit("newpipe")), _k=Depends(require_key)):
    return JSONResponse({"results": (await artists_search(request, q.strip()))[:limit]}, headers={"Cache-Control": "private, max-age=3600"})


@router.get("/artist")
async def artist(request: Request, name: str = Query(min_length=2, max_length=100), _rl=Depends(rate_limit("newpipe")), _k=Depends(require_key)):
    return JSONResponse(await artist_info(request, name.strip()), headers={"Cache-Control": "private, max-age=3600"})


@router.get("/suggest")
async def suggest(request: Request, q: str = Query(min_length=1, max_length=100), _rl=Depends(rate_limit("suggest")), _k=Depends(require_key)):
    return JSONResponse({"suggestions": await suggestions(request, q.strip())}, headers={"Cache-Control": "private, max-age=600"})


@router.get("/song/{vid}")
async def song(request: Request, vid: str, _rl=Depends(rate_limit("newpipe")), _k=Depends(require_key)):
    info = await stream_info(request, _id(vid))
    return JSONResponse(_song(info), headers={"Cache-Control": "private, max-age=600"})


@router.post("/prefetch/{vid}")
async def prefetch(request: Request, vid: str, _rl=Depends(rate_limit("newpipe")), _k=Depends(require_key)):
    await stream_info(request, _id(vid))
    return JSONResponse({"ok": True})


async def _open_media(url: str, range_header: str | None) -> httpx.Response:
    host = urlsplit(url).hostname or ""
    if not url.startswith("https://") or not MEDIA_HOST.match(host):
        raise GatewayError(502, "newpipe_failed", "Unexpected media host.")
    client = httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=30.0), follow_redirects=False)
    # YouTube cuts a request without Range off after roughly half the file; an open-ended Range returns all of it.
    headers = {"User-Agent": UA, "Range": range_header or "bytes=0-"}
    try:
        res = await client.send(client.build_request("GET", url, headers=headers), stream=True)
    except httpx.HTTPError:
        await client.aclose()
        raise GatewayError(502, "newpipe_failed", "Could not reach the audio source.") from None
    res.extensions["_client"] = client  # closed together with the response
    return res


async def _close(res: httpx.Response) -> None:
    await res.aclose()
    await res.extensions["_client"].aclose()


async def _serve(request: Request, vid: str, kind: str) -> StreamingResponse:
    """Stream the audio (`audio`) or the silent picture (`video`) of a track through this server, Range supported."""
    vid = _id(vid)
    rng = request.headers.get("range")

    def pick(info: dict) -> dict:
        media = info.get(kind)
        if not media:
            raise GatewayError(404, "not_found", "No video for that track.")
        return media

    info = await stream_info(request, vid)
    res = await _open_media(pick(info)["url"], rng)
    if res.status_code in (403, 404, 410):  # cached URL expired or was revoked: look it up again once
        await _close(res)
        info = await stream_info(request, vid, fresh=True)
        res = await _open_media(pick(info)["url"], rng)
    if res.status_code >= 400 and res.status_code != 416:
        await _close(res)
        raise GatewayError(502, "newpipe_failed", "The media source refused the request.")
    headers = {k: v for k, v in res.headers.items() if k.lower() in PASS_HEADERS}
    status = res.status_code
    if not rng and status == 206:  # the client asked for the whole file: answer 200 with the full length, not a partial
        status = 200
        cr = headers.pop("content-range", "")
        total = cr.rsplit("/", 1)[1] if "/" in cr else ""
        if total.isdigit():
            headers["content-length"] = total
    if not any(k.lower() == "accept-ranges" for k in headers):
        headers["Accept-Ranges"] = "bytes"
    headers["Cache-Control"] = "private, max-age=0"
    fallback = pick(info).get("mime") or ("video/mp4" if kind == "video" else "audio/mp4")
    return StreamingResponse(res.aiter_raw(), status_code=status, headers=headers, media_type=headers.get("content-type", fallback), background=BackgroundTask(_close, res))


@router.get("/stream/{vid}")
async def stream(request: Request, vid: str, _rl=Depends(rate_limit("newpipe")), _k=Depends(require_key)):
    return await _serve(request, vid, "audio")


@router.get("/musicvideo")
async def musicvideo(
    request: Request,
    title: str = Query(min_length=1, max_length=200),
    artist: str = Query(default="", max_length=120),
    duration: int = Query(default=0, ge=0, le=7200),
    _rl=Depends(rate_limit("newpipe")),
    _k=Depends(require_key),
):
    found = await music_video(request, title.strip(), artist.strip(), duration or None)
    if not found:
        raise GatewayError(404, "not_found", "No music video found for that song.")
    return JSONResponse({"id": found["id"], "title": found["title"], "durationSec": found["durationSec"]}, headers={"Cache-Control": "private, max-age=3600"})


@router.get("/video/{vid}")
async def video(request: Request, vid: str, _rl=Depends(rate_limit("newpipe")), _k=Depends(require_key)):
    return await _serve(request, vid, "video")


# ------------------------------------------------------------------ mp3 download

_convert_slots = asyncio.Semaphore(2)  # ffmpeg is CPU heavy: at most two conversions at once


@router.get("/download/{vid}")
async def download(request: Request, vid: str, _rl=Depends(rate_limit("newpipe")), _k=Depends(require_key)):
    vid = _id(vid)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise GatewayError(503, "not_configured", "mp3 conversion needs ffmpeg on the server.", service="ffmpeg")
    info = await stream_info(request, vid)
    res = await _open_media(info["audio"]["url"], None)
    if res.status_code == 403:
        await _close(res)
        res = await _open_media((await stream_info(request, vid, fresh=True))["audio"]["url"], None)
    if res.status_code >= 400:
        await _close(res)
        raise GatewayError(502, "newpipe_failed", "The audio source refused the request.")

    await _convert_slots.acquire()
    proc = await asyncio.create_subprocess_exec(
        ffmpeg, "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-map_metadata", "-1", "-codec:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", "pipe:1",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )

    async def feed():
        try:
            async for chunk in res.aiter_raw():
                proc.stdin.write(chunk)
                await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError, httpx.HTTPError):
            pass
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

    feeder = asyncio.create_task(feed())

    async def body():
        try:
            while chunk := await proc.stdout.read(64 * 1024):
                yield chunk
        finally:
            feeder.cancel()
            if proc.returncode is None:
                proc.kill()
            await proc.wait()
            await _close(res)
            _convert_slots.release()

    name = re.sub(r"[^A-Za-z0-9 _.-]", "", info["title"])[:80].strip() or vid
    return StreamingResponse(body(), media_type="audio/mpeg", headers={"Content-Disposition": f'attachment; filename="{name}.mp3"', "Cache-Control": "private, max-age=0"})


# ------------------------------------------------------------------ lyrics

LRC_LINE = re.compile(r"^\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.*)$")


def lrc_lines(lrc: str) -> list[dict]:
    """'[01:23.45] text' lines -> [{time (s), text}], sorted. Lines with several stamps repeat the text."""
    out: list[dict] = []
    for raw in lrc.splitlines():
        stamps, rest = [], raw.strip()
        while (m := re.match(r"^\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]", rest)):
            frac = m.group(3) or "0"
            stamps.append(int(m.group(1)) * 60 + int(m.group(2)) + int(frac) / (10 ** len(frac)))
            rest = rest[m.end():]
        if stamps:
            out += [{"time": round(t, 2), "text": rest.strip()} for t in stamps]
    return sorted(out, key=lambda x: x["time"])


@router.get("/lyrics/{vid}")
async def lyrics(
    request: Request,
    vid: str,
    title: str = Query(min_length=1, max_length=200),
    artist: str = Query(default="", max_length=200),
    duration: float = Query(default=0, ge=0, le=7200),
    _rl=Depends(rate_limit("lyrics")),
    _k=Depends(require_key),
):
    _id(vid)
    m = await match_lyrics(request, title, artist or title, duration)
    if not m.get("found"):
        raise GatewayError(404, "not_found", "No lyrics found.")
    lines = lrc_lines(m["syncedLyrics"]) if m.get("syncedLyrics") else []
    plain = m.get("plainLyrics") or "\n".join(x["text"] for x in lines)
    return JSONResponse(
        {"synced": bool(lines), "lines": lines, "plain": plain, "instrumental": bool(m.get("instrumental")), "duration": m.get("timedDuration"), "track": m.get("matchedTitle"), "artist": m.get("matchedArtist")},
        headers={"Cache-Control": "private, max-age=3600"},
    )
