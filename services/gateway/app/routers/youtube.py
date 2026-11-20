"""YouTube Data API v3, for the official embedded player only (no stream extraction).
Port of supabase/functions/youtube: POST { action?, ... } with chart | search | shorts | live | related |
details | comments | uploads. Shared responses are cached (quota is the scarce resource: search costs 100 units)."""

import html
import re
from typing import Any

from fastapi import APIRouter, Depends, Request

from ..auth import User
from ..deps import plain_json, rate_limit
from ..errors import GatewayError

router = APIRouter(prefix="/v1/youtube", tags=["youtube"])

MUSIC_CATEGORY = "10"
SHORT_MAX_SEC = 180
ID = re.compile(r"^[A-Za-z0-9_-]{6,20}$")
CHANNEL_ID = re.compile(r"^UC[A-Za-z0-9_-]{20,24}$")
ISO = re.compile(r"^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$")
HOUR, DAY = 3600, 86400


def _s(v: Any, mx: int = 100) -> str | None:
    return v.strip()[:mx] if isinstance(v, str) and v.strip() else None


def iso_seconds(d: str | None) -> int | None:
    m = ISO.match(d) if d else None
    if not m:
        return None
    n = sum(int(g or 0) * f for g, f in zip(m.groups(), (86400, 3600, 60, 1), strict=True))
    return n or None


def _num(v: Any) -> int | None:
    return int(v) if isinstance(v, str) and v.isdigit() else None


def _thumb(t: dict | None) -> str | None:
    t = t or {}
    return next((t[k]["url"] for k in ("high", "medium", "default") if k in t), None)


def _vid(it: dict) -> str | None:
    i = it.get("id")
    return i if isinstance(i, str) else (i or {}).get("videoId")


def to_video(it: dict) -> dict | None:
    vid, sn = _vid(it), it.get("snippet") or {}
    if not vid or not sn.get("title"):
        return None
    st = it.get("statistics") or {}
    return {
        "id": vid,
        "title": html.unescape(sn["title"]),
        "channel": html.unescape(sn.get("channelTitle") or ""),
        "channelId": sn.get("channelId"),
        "thumbnail": _thumb(sn.get("thumbnails")),
        "publishedAt": sn.get("publishedAt"),
        "live": sn.get("liveBroadcastContent") == "live",
        "views": _num(st.get("viewCount")),
        "likes": _num(st.get("likeCount")),
        "comments": _num(st.get("commentCount")),
        "durationSec": iso_seconds((it.get("contentDetails") or {}).get("duration")),
    }


def to_details(it: dict) -> dict | None:
    v = to_video(it)
    if not v:
        return None
    st = it.get("statistics")
    return {
        **v,
        "description": (it.get("snippet") or {}).get("description") or "",
        "tags": ((it.get("snippet") or {}).get("tags") or [])[:12],
        "commentsHidden": st is not None and "commentCount" not in st,
        "embeddable": (it.get("status") or {}).get("embeddable") is not False,
    }


def map_error(status: int, err: dict | None) -> GatewayError:
    reason = (((err or {}).get("errors") or [{}])[0]).get("reason", "")
    msg = (err or {}).get("message") or f"YouTube request failed ({status})"
    if reason in ("quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded"):
        return GatewayError(429, "quota_exceeded", "YouTube's daily limit has been reached. Try again tomorrow.")
    if reason == "commentsDisabled":
        return GatewayError(403, "comments_disabled", "Comments are turned off for this video.")
    if reason in ("videoNotFound", "channelNotFound", "playlistNotFound") or status == 404:
        return GatewayError(404, "not_found", "That video is no longer available.")
    if reason in ("keyInvalid", "accessNotConfigured"):
        return GatewayError(503, "not_configured", msg, service="youtube")
    if status == 400:
        return GatewayError(400, "bad_request", msg)
    return GatewayError(502, "youtube_failed", msg)


class YT:
    def __init__(self, request: Request):
        self.s = request.app.state.settings
        self.up = request.app.state.upstream
        self.cache = request.app.state.cache

    async def call(self, path: str, **params: str | None) -> dict:
        q = {k: v for k, v in params.items() if v is not None}
        res = await self.up.request("youtube", "GET", f"{self.s.youtube_base}/{path}", params={**q, "key": self.s.youtube_api_key})
        try:
            data = res.json()
        except ValueError:
            data = {}
        if res.status_code >= 400 or data.get("error"):
            raise map_error(res.status_code, data.get("error"))
        return data

    async def cached(self, key: str, ttl: int, load):
        return (await self.cache.get_or_load(f"yt:{key}", ttl, load)).value

    async def videos_by_id(self, ids: list[str]) -> list[dict]:
        if not ids:
            return []
        data = await self.call("videos", part="snippet,statistics,contentDetails,status", id=",".join(ids[:50]), maxResults="50")
        by = {_vid(it): it for it in data.get("items", [])}
        return [by[i] for i in ids if i in by and (by[i].get("status") or {}).get("embeddable") is not False]

    async def search_videos(self, *, q=None, region, page=None, duration=None, event_type=None, max_results=20) -> dict:
        data = await self.call(
            "search", part="snippet", type="video", maxResults=str(max_results), regionCode=region, videoCategoryId=MUSIC_CATEGORY,
            videoEmbeddable="true", videoSyndicated="true", safeSearch="moderate", q=q, pageToken=page, videoDuration=duration, eventType=event_type,
        )
        ids = [i for it in data.get("items", []) if event_type == "live" or (it.get("snippet") or {}).get("liveBroadcastContent") != "upcoming" if (i := _vid(it))]
        full = await self.videos_by_id(ids)
        out: dict[str, Any] = {"videos": [v for v in map(to_video, full) if v]}
        if data.get("nextPageToken"):
            out["nextPageToken"] = data["nextPageToken"]
        return out


@router.post("")
async def youtube(request: Request, body: dict[str, Any], _user: User = Depends(rate_limit("youtube", auth=True))):
    s = request.app.state.settings
    if not s.youtube_api_key:
        raise GatewayError(503, "not_configured", "YouTube is not configured.", service="youtube")
    yt = YT(request)
    q = _s(body.get("q"))
    region = str(body["region"]).upper() if re.fullmatch(r"[A-Za-z]{2}", str(body.get("region", ""))) else "IN"
    token = _s(body.get("pageToken"), 200)
    page = token or ""
    action = _s(body.get("action"), 20) or ("search" if q else "chart")

    async def respond(key: str, ttl: int, load):
        return plain_json(await yt.cached(key, ttl, load), ttl, public=False)

    if action == "chart":
        async def load():
            data = await yt.call("videos", part="snippet,statistics,contentDetails,status", chart="mostPopular", videoCategoryId=MUSIC_CATEGORY, regionCode=region, maxResults="25", pageToken=token)
            vids = [v for it in data.get("items", []) if (it.get("status") or {}).get("embeddable") is not False if (v := to_video(it))]
            return {"videos": vids, **({"nextPageToken": data["nextPageToken"]} if data.get("nextPageToken") else {})}

        return await respond(f"chart:{region}:{page}", HOUR, load)

    if action == "search":
        if not q or len(q) < 2:
            raise GatewayError(400, "bad_request", "Type at least 2 characters.")
        dur = body.get("duration") if body.get("duration") in ("short", "medium", "long") else None
        return await respond(f"search:{region}:{dur or ''}:{q.lower()}:{page}", 6 * HOUR, lambda: yt.search_videos(q=q, region=region, page=token, duration=dur))

    if action == "shorts":
        query = q or "music #shorts"

        async def load():
            r = await yt.search_videos(q=query, region=region, page=token, duration="short", max_results=25)
            return {**r, "videos": [v for v in r["videos"] if v["durationSec"] is not None and v["durationSec"] <= SHORT_MAX_SEC]}

        return await respond(f"shorts:{region}:{query.lower()}:{page}", 3 * HOUR, load)

    if action == "live":
        query = q or "music live"
        return await respond(f"live:{region}:{query.lower()}:{page}", 900, lambda: yt.search_videos(q=query, region=region, page=token, event_type="live"))

    if action == "related":
        if not q:
            raise GatewayError(400, "bad_request", "related needs q (title or channel).")
        vid = _s(body.get("videoId"), 20)
        out = await yt.cached(f"related:{region}:{q.lower()}", 12 * HOUR, lambda: yt.search_videos(q=q, region=region, max_results=15))
        return plain_json({"videos": [v for v in out["videos"] if v["id"] != vid]}, 12 * HOUR, public=False)

    if action == "details":
        raw = body.get("ids") if isinstance(body.get("ids"), list) else [body.get("id")]
        ids = [x for x in raw if isinstance(x, str) and ID.match(x)][:50]
        if not ids:
            raise GatewayError(400, "bad_request", "details needs ids.")

        async def load():
            data = await yt.call("videos", part="snippet,statistics,contentDetails,status", id=",".join(ids), maxResults="50")
            vids = [v for v in map(to_details, data.get("items", [])) if v]
            channel = None
            cid = vids[0]["channelId"] if len(ids) == 1 and vids else None
            if cid:
                ch = await yt.call("channels", part="snippet,statistics", id=cid)
                it = (ch.get("items") or [None])[0]
                if it and (it.get("snippet") or {}).get("title"):
                    st = it.get("statistics") or {}
                    channel = {"id": cid, "title": html.unescape(it["snippet"]["title"]), "thumbnail": _thumb(it["snippet"].get("thumbnails")), "subscribers": None if st.get("hiddenSubscriberCount") else _num(st.get("subscriberCount"))}
            return {"videos": vids, "channel": channel}

        out = await yt.cached(f"details:{','.join(ids)}", 600, load)
        if len(ids) == 1 and not out["videos"]:
            raise GatewayError(404, "not_found", "That video is no longer available.")
        return plain_json(out, 600, public=False)

    if action == "comments":
        vid = _s(body.get("videoId"), 20)
        if not vid or not ID.match(vid):
            raise GatewayError(400, "bad_request", "comments needs videoId.")
        order = "time" if body.get("order") == "time" else "relevance"

        async def load():
            data = await yt.call("commentThreads", part="snippet", videoId=vid, order=order, maxResults="25", textFormat="plainText", pageToken=token)
            comments = []
            for t in data.get("items", []):
                c = (t.get("snippet") or {}).get("topLevelComment") or {}
                sn = c.get("snippet") or {}
                text = sn.get("textOriginal") or sn.get("textDisplay")
                if not c.get("id") or not text:
                    continue
                comments.append({"id": c["id"], "author": sn.get("authorDisplayName") or "", "authorAvatar": sn.get("authorProfileImageUrl"), "text": text[:2000], "likes": sn.get("likeCount") or 0, "publishedAt": sn.get("publishedAt"), "replies": (t.get("snippet") or {}).get("totalReplyCount") or 0})
            return {"comments": comments, **({"nextPageToken": data["nextPageToken"]} if data.get("nextPageToken") else {})}

        return await respond(f"comments:{vid}:{order}:{page}", 300 if order == "time" else 1800, load)

    if action == "uploads":
        raw = body.get("channelIds") if isinstance(body.get("channelIds"), list) else []
        cids = [x for x in raw if isinstance(x, str) and CHANNEL_ID.match(x)][:10]
        if not cids:
            return plain_json({"videos": []}, 60, public=False)
        shorts_only = body.get("shortsOnly") is True

        async def load():
            ch = await yt.call("channels", part="contentDetails", id=",".join(cids), maxResults="50")
            lists = [((it.get("contentDetails") or {}).get("relatedPlaylists") or {}).get("uploads") for it in ch.get("items", [])]
            ids: list[str] = []
            for pl in filter(None, lists):
                try:
                    d = await yt.call("playlistItems", part="contentDetails", playlistId=pl, maxResults="15")
                except GatewayError:
                    continue
                ids += [v for it in d.get("items", []) if (v := (it.get("contentDetails") or {}).get("videoId")) and ID.match(v)]
            full: list[dict] = []
            for i in range(0, len(ids), 50):
                full += await yt.videos_by_id(ids[i : i + 50])
            vids = [v for v in map(to_video, full) if v and not v["live"] and (not shorts_only or (v["durationSec"] is not None and v["durationSec"] <= SHORT_MAX_SEC))]
            return {"videos": sorted(vids, key=lambda v: v["publishedAt"] or "", reverse=True)}

        return await respond(f"uploads:{'s' if shorts_only else 'a'}:{','.join(sorted(cids))}", 3 * HOUR, load)

    raise GatewayError(400, "bad_request", f'Unknown action "{action}".')
