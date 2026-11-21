from contextlib import contextmanager

import httpx
import respx
from fastapi.testclient import TestClient

from app.auth import User, require_user
from app.config import Settings
from app.main import create_app
from app.routers.newpipe import clean_stream, clean_track

BASE = "http://newpipe.test:8090"


@contextmanager
def client(**kw):
    """Signed-in test client; the `with` runs the app's startup/shutdown (creates the upstream HTTP client)."""
    app = create_app(Settings(env="test", newpipe_base=kw.pop("base", BASE), newpipe_token=kw.pop("token", "secret"), **kw))
    app.dependency_overrides[require_user] = lambda: User(id="u1")
    with TestClient(app) as c:
        yield c


def test_clean_track_drops_junk_and_bad_ids():
    assert clean_track({"id": "../etc", "title": "x"}) is None
    assert clean_track({"id": "dQw4w9WgXcQ"}) is None
    t = clean_track({"id": "dQw4w9WgXcQ", "title": "Song", "artist": "A", "durationSec": 200, "thumbnail": "http://insecure/x.jpg", "extra": 1})
    assert t == {"id": "dQw4w9WgXcQ", "title": "Song", "artist": "A", "durationSec": 200, "views": None, "thumbnail": None}


def test_clean_stream_requires_https_audio_url():
    base = {"id": "dQw4w9WgXcQ", "title": "Song", "artist": "A"}
    assert clean_stream({**base, "audio": {"url": "http://x/a.m4a"}}) is None
    assert clean_stream(base) is None
    out = clean_stream({**base, "audio": {"url": "https://x/a.m4a", "mime": "audio/mp4", "bitrate": 128000}})
    assert out["audio"] == {"url": "https://x/a.m4a", "mime": "audio/mp4", "bitrate": 128000}


def test_not_configured_when_base_empty():
    with client(base="") as c:
        r = c.post("/v1/newpipe", json={"action": "search", "q": "hello"})
    assert r.status_code == 503 and r.json()["error"]["code"] == "not_configured"


@respx.mock
def test_search_proxies_with_token_and_cleans():
    route = respx.get(f"{BASE}/search").mock(return_value=httpx.Response(200, json={"tracks": [{"id": "dQw4w9WgXcQ", "title": "Song", "artist": "A"}, {"id": "bad id", "title": "x"}]}))
    with client() as c:
        r = c.post("/v1/newpipe", json={"action": "search", "q": "hello"})
    assert r.status_code == 200
    assert [t["id"] for t in r.json()["tracks"]] == ["dQw4w9WgXcQ"]
    assert route.calls.last.request.headers["x-internal-token"] == "secret"


def test_search_validates_query():
    with client() as c:
        assert c.post("/v1/newpipe", json={"action": "search", "q": "a"}).status_code == 400


def test_stream_rejects_bad_id_before_calling_sidecar():
    with client() as c:
        assert c.post("/v1/newpipe", json={"action": "stream", "id": "../x"}).status_code == 400


@respx.mock
def test_stream_returns_audio_and_maps_sidecar_400_to_404():
    respx.get(f"{BASE}/stream", params={"id": "dQw4w9WgXcQ"}).mock(return_value=httpx.Response(200, json={"id": "dQw4w9WgXcQ", "title": "Song", "artist": "A", "audio": {"url": "https://x/a.m4a", "mime": "audio/mp4", "bitrate": 128000}}))
    with client() as c:
        r = c.post("/v1/newpipe", json={"action": "stream", "id": "dQw4w9WgXcQ"})
    assert r.status_code == 200 and r.json()["audio"]["url"] == "https://x/a.m4a"

    respx.get(f"{BASE}/stream", params={"id": "aaaaaaaaaaa"}).mock(return_value=httpx.Response(400, json={"error": {"code": "bad_request", "message": "No playable audio stream for that video."}}))
    with client() as c:
        r = c.post("/v1/newpipe", json={"action": "stream", "id": "aaaaaaaaaaa"})
    assert r.status_code == 404


# ------------------------------------------------------------------ app-facing /api routes

MEDIA = "https://rr1---sn-test.googlevideo.com/audio"
STREAM = {"id": "dQw4w9WgXcQ", "title": "Song", "artist": "A", "durationSec": 200, "audio": {"url": MEDIA, "mime": "audio/mp4", "bitrate": 128}}


def api_client(**kw):
    app = create_app(Settings(env="test", newpipe_base=kw.pop("base", BASE), zoyra_api_key=kw.pop("key", "k1"), **kw))
    return TestClient(app)


def test_api_not_configured_without_key():
    with api_client(key="") as c:
        assert c.get("/api/search", params={"q": "hello"}).status_code == 503


def test_api_rejects_wrong_key():
    with api_client() as c:
        assert c.get("/api/search", params={"q": "hello", "key": "nope"}).status_code == 401
        assert c.get("/api/health").status_code == 200


@respx.mock
def test_api_search_maps_to_app_contract():
    respx.get(f"{BASE}/search").mock(return_value=httpx.Response(200, json={"tracks": [{"id": "dQw4w9WgXcQ", "title": "Song", "artist": "A", "durationSec": 200}]}))
    with api_client() as c:
        r = c.get("/api/search", params={"q": "hello"}, headers={"X-Zoyra-Key": "k1"})
    assert r.status_code == 200
    s = r.json()["results"][0]
    assert s["id"] == "dQw4w9WgXcQ" and s["duration"] == 200 and s["thumbnail"].startswith("https://i.ytimg.com/")


@respx.mock
def test_api_stream_proxies_audio_with_range():
    respx.get(f"{BASE}/stream").mock(return_value=httpx.Response(200, json=STREAM))
    media = respx.get(MEDIA).mock(return_value=httpx.Response(206, content=b"x" * 10, headers={"content-type": "audio/mp4", "content-range": "bytes 0-9/100", "content-length": "10"}))
    with api_client() as c:
        r = c.get("/api/stream/dQw4w9WgXcQ", params={"key": "k1"}, headers={"Range": "bytes=0-9"})
    assert r.status_code == 206 and r.content == b"x" * 10
    assert r.headers["content-range"] == "bytes 0-9/100"
    assert media.calls.last.request.headers["range"] == "bytes=0-9"


@respx.mock
def test_api_stream_refuses_non_google_media_host():
    respx.get(f"{BASE}/stream").mock(return_value=httpx.Response(200, json={**STREAM, "audio": {"url": "https://evil.example/a", "mime": "audio/mp4"}}))
    with api_client() as c:
        assert c.get("/api/stream/dQw4w9WgXcQ", params={"key": "k1"}).status_code == 502


@respx.mock
def test_api_stream_refreshes_expired_url_once():
    respx.get(f"{BASE}/stream").mock(return_value=httpx.Response(200, json=STREAM))
    respx.get(MEDIA).mock(side_effect=[httpx.Response(403), httpx.Response(200, content=b"ok", headers={"content-type": "audio/mp4"})])
    with api_client() as c:
        r = c.get("/api/stream/dQw4w9WgXcQ", params={"key": "k1"})
    assert r.status_code == 200 and r.content == b"ok"


def test_lrc_lines_parse_and_sort():
    from app.routers.zoyra_compat import lrc_lines

    out = lrc_lines("[ti:x]\n[00:12.50] second\n[00:01.5]first\n[01:00.00][02:00.00] chorus\nnot a line")
    assert [(x["time"], x["text"]) for x in out] == [(1.5, "first"), (12.5, "second"), (60.0, "chorus"), (120.0, "chorus")]


@respx.mock
def test_api_lyrics_maps_to_app_shape():
    respx.get("https://lrclib.net/api/get").mock(return_value=httpx.Response(200, json={"trackName": "Song", "artistName": "A", "duration": 200, "syncedLyrics": "[00:01.00] hello\n[00:05.00] world", "plainLyrics": "hello\nworld"}))
    with api_client() as c:
        r = c.get("/api/lyrics/dQw4w9WgXcQ", params={"title": "Song", "artist": "A", "duration": 200, "key": "k1"})
    j = r.json()
    assert r.status_code == 200 and j["synced"] is True and j["lines"][0] == {"time": 1.0, "text": "hello"} and j["plain"] == "hello\nworld"


@respx.mock
def test_api_download_converts_to_mp3_when_ffmpeg_present():
    import shutil
    import subprocess

    import pytest

    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not installed")
    wav = subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-f", "wav", "pipe:1"], capture_output=True, check=True).stdout
    respx.get(f"{BASE}/stream").mock(return_value=httpx.Response(200, json=STREAM))
    respx.get(MEDIA).mock(return_value=httpx.Response(200, content=wav, headers={"content-type": "audio/wav"}))
    with api_client() as c:
        r = c.get("/api/download/dQw4w9WgXcQ", params={"key": "k1"})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg"
    assert r.content[:3] == b"ID3" or r.content[:2] == b"\xff\xfb"
    assert 'filename="Song.mp3"' in r.headers["content-disposition"]


@respx.mock
def test_api_suggest_cleans_and_caches():
    route = respx.get(f"{BASE}/suggest").mock(return_value=httpx.Response(200, json={"suggestions": ["arijit singh", "  arijit singh songs  ", 5, ""]}))
    with api_client() as c:
        a = c.get("/api/suggest", params={"q": "arij", "key": "k1"})
        b = c.get("/api/suggest", params={"q": "arij", "key": "k1"})
    assert a.json() == {"suggestions": ["arijit singh", "arijit singh songs"]} and b.json() == a.json()
    assert route.call_count == 1


def test_art_url_upscales_album_art_only():
    from app.routers.newpipe import art_url

    assert art_url("https://yt3.googleusercontent.com/abc=w60-h60-l90-rj") == "https://yt3.googleusercontent.com/abc=w544-h544-l90-rj"
    assert art_url("https://yt3.googleusercontent.com/a=s160-c-k-c0x00ffffff-no-rj") == "https://yt3.googleusercontent.com/a=s544-c-k-c0x00ffffff-no-rj"
    assert art_url("https://i.ytimg.com/vi/x/hq720.jpg") == "https://i.ytimg.com/vi/x/hq720.jpg"
    assert art_url("http://yt3.googleusercontent.com/abc=w60-h60") is None


@respx.mock
def test_api_artist_and_search_clean_and_hide_subscribers():
    respx.get(f"{BASE}/artists").mock(return_value=httpx.Response(200, json={"artists": [{"name": "Arijit Singh", "image": "https://yt3.googleusercontent.com/a=w120-h120-p-l90-rj", "subscribers": 665000000, "verified": True}, {"name": ""}]}))
    respx.get(f"{BASE}/artist").mock(return_value=httpx.Response(200, json={"name": "Arijit Singh", "image": "https://yt3.googleusercontent.com/a=s160-c", "banner": "https://yt3.googleusercontent.com/b=w2560", "description": "Singer.", "subscribers": 5, "verified": True}))
    with api_client() as c:
        a = c.get("/api/artists", params={"q": "arijit", "key": "k1"}).json()["results"]
        b = c.get("/api/artist", params={"name": "Arijit Singh", "key": "k1"}).json()
    assert [x["name"] for x in a] == ["Arijit Singh"] and a[0]["image"].endswith("=w544-h544-p-l90-rj") and "subscribers" not in a[0]
    assert b["banner"].startswith("https://") and b["description"] == "Singer." and b["image"].endswith("=s544-c")


def test_clean_track_drops_topic_suffix_from_artist():
    assert clean_track({"id": "dQw4w9WgXcQ", "title": "S", "artist": "Daft Punk - Topic"})["artist"] == "Daft Punk"


def test_extract_links_classifies_orders_and_filters():
    from app.routers.newpipe import extract_links

    text = "Official: https://example.com/music. IG https://www.instagram.com/arijitsingh. Tip https://www.patreon.com/x! http://insecure.com/a https://youtube.com/redirect?q=1 https://www.instagram.com/arijitsingh"
    out = extract_links(text, "https://www.youtube.com/channel/UC123")
    assert [(x["key"], x["url"]) for x in out] == [
        ("tip", "https://www.patreon.com/x"),
        ("site", "https://example.com/music"),
        ("ig", "https://www.instagram.com/arijitsingh"),
        ("yt", "https://www.youtube.com/channel/UC123"),
    ]
    assert extract_links(None, None) == []


@respx.mock
def test_api_video_streams_silent_mp4_and_404_without_one():
    vurl = "https://rr2---sn-test.googlevideo.com/video"
    respx.get(f"{BASE}/stream", params={"id": "dQw4w9WgXcQ"}).mock(return_value=httpx.Response(200, json={**STREAM, "video": {"url": vurl, "mime": "video/mp4", "height": 480}}))
    media = respx.get(vurl).mock(return_value=httpx.Response(206, content=b"v" * 8, headers={"content-type": "video/mp4", "content-range": "bytes 0-7/80", "content-length": "8"}))
    respx.get(f"{BASE}/stream", params={"id": "aaaaaaaaaaa"}).mock(return_value=httpx.Response(200, json={**STREAM, "id": "aaaaaaaaaaa"}))
    with api_client() as c:
        r = c.get("/api/video/dQw4w9WgXcQ", params={"key": "k1"}, headers={"Range": "bytes=0-7"})
        none = c.get("/api/video/aaaaaaaaaaa", params={"key": "k1"})
    assert r.status_code == 206 and r.content == b"v" * 8 and r.headers["content-type"] == "video/mp4"
    assert media.calls.last.request.headers["range"] == "bytes=0-7"
    assert none.status_code == 404


def test_pick_music_video_matches_title_and_length():
    from app.routers.newpipe import pick_music_video

    items = [
        {"id": "AAAAAAAAAAA", "title": "Get Lucky (10 Hour Loop)", "artist": "Loops", "durationSec": 36000},
        {"id": "BBBBBBBBBBB", "title": "Daft Punk - Get Lucky (Official Video) ft. Pharrell Williams", "artist": "Daft Punk", "durationSec": 248},
        {"id": "CCCCCCCCCCC", "title": "Random Access Memories", "artist": "Daft Punk", "durationSec": 249},
    ]
    assert pick_music_video(items, "Get Lucky (feat. Pharrell Williams and Nile Rodgers)", "Daft Punk", 249)["id"] == "BBBBBBBBBBB"
    assert pick_music_video(items, "Get Lucky", "Daft Punk", 600) is None  # nothing close to that length
    assert pick_music_video([], "x y", "z", 100) is None


@respx.mock
def test_api_musicvideo_returns_best_match_or_404():
    respx.get(f"{BASE}/videos").mock(return_value=httpx.Response(200, json={"videos": [{"id": "dQw4w9WgXcQ", "title": "Artist - Great Song (Official Video)", "artist": "Artist", "durationSec": 200}]}))
    with api_client() as c:
        ok = c.get("/api/musicvideo", params={"title": "Great Song", "artist": "Artist", "duration": 201, "key": "k1"})
        no = c.get("/api/musicvideo", params={"title": "Something Else Entirely", "artist": "Artist", "duration": 201, "key": "k1"})
    assert ok.status_code == 200 and ok.json()["id"] == "dQw4w9WgXcQ"
    assert no.status_code == 404


def test_pick_music_video_skips_karaoke_covers_and_loops():
    from app.routers.newpipe import pick_music_video

    items = [
        {"id": "KKKKKKKKKKK", "title": "Agar Tum Saath Ho Karaoke with Lyrics", "artist": "Karaoke Hub", "durationSec": 342},
        {"id": "CCCCCCCCCCC", "title": "Agar Tum Saath Ho (Cover)", "artist": "Someone", "durationSec": 343},
        {"id": "OOOOOOOOOOO", "title": "Agar Tum Saath Ho | Full Video | Tamasha", "artist": "T-Series", "durationSec": 341},
    ]
    assert pick_music_video(items, "AGAR TUM SAATH HO", "Arijit Singh", 342)["id"] == "OOOOOOOOOOO"
    # ...but when the song itself is the karaoke / live version, those are fine
    assert pick_music_video(items[:1], "Agar Tum Saath Ho (Karaoke)", "x", 342)["id"] == "KKKKKKKKKKK"
