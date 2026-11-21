package app.zoyra.newpipe;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.schabi.newpipe.extractor.Image;
import org.schabi.newpipe.extractor.InfoItem;
import org.schabi.newpipe.extractor.channel.ChannelInfo;
import org.schabi.newpipe.extractor.channel.ChannelInfoItem;
import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.ServiceList;
import org.schabi.newpipe.extractor.StreamingService;
import org.schabi.newpipe.extractor.localization.Localization;
import org.schabi.newpipe.extractor.search.SearchInfo;
import org.schabi.newpipe.extractor.services.youtube.linkHandler.YoutubeSearchQueryHandlerFactory;
import org.schabi.newpipe.extractor.stream.AudioStream;
import org.schabi.newpipe.extractor.stream.StreamInfo;
import org.schabi.newpipe.extractor.stream.StreamInfoItem;
import org.schabi.newpipe.extractor.stream.StreamType;
import org.schabi.newpipe.extractor.stream.VideoStream;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * Tiny internal HTTP service around NewPipeExtractor (YouTube only).
 *
 *   GET /healthz
 *   GET /search?q=<text>            -> { "tracks": [ { id, title, artist, durationSec, thumbnail } ] }
 *   GET /videos?q=<text>            -> { "videos": [ { id, title, artist, durationSec } ] } (music videos, not audio uploads)
 *   GET /artists?q=<text>           -> { "artists": [ { name, image, subscribers, verified } ] }
 *   GET /artist?name=<name>         -> { name, image, banner, description, subscribers, verified } (best match)
 *   GET /suggest?q=<text>           -> { "suggestions": [ "..." ] }
 *   GET /stream?id=<videoId>        -> { id, title, artist, durationSec, thumbnail, audio: { url, mime, bitrate } }
 *
 * Meant to sit on a private network behind the gateway, never on the public internet. If NEWPIPE_TOKEN is set,
 * every request except /healthz must carry the same value in X-Internal-Token.
 */
public final class Main {
    private static final Gson GSON = new Gson();
    private static final Pattern VIDEO_ID = Pattern.compile("^[A-Za-z0-9_-]{6,20}$");
    private static final String TOKEN = System.getenv().getOrDefault("NEWPIPE_TOKEN", "");

    public static void main(final String[] args) throws IOException {
        NewPipe.init(new OkDownloader(), new Localization("en", "IN"));

        final int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8090"));
        final HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.setExecutor(Executors.newFixedThreadPool(8));
        server.createContext("/healthz", ex -> send(ex, 200, Map.of("ok", true)));
        server.createContext("/search", ex -> guarded(ex, Main::search));
        server.createContext("/stream", ex -> guarded(ex, Main::stream));
        server.createContext("/suggest", ex -> guarded(ex, Main::suggest));
        server.createContext("/videos", ex -> guarded(ex, Main::videos));
        server.createContext("/artists", ex -> guarded(ex, Main::artists));
        server.createContext("/artist", ex -> guarded(ex, Main::artist));
        server.start();
        System.out.println("newpipe sidecar listening on :" + port);
    }

    private interface Handler {
        Object handle(Map<String, String> query) throws Exception;
    }

    private static void guarded(final HttpExchange ex, final Handler h) throws IOException {
        try {
            if (!"GET".equals(ex.getRequestMethod())) {
                send(ex, 405, error("method_not_allowed", "Use GET."));
                return;
            }
            if (!TOKEN.isEmpty() && !constantTimeEquals(TOKEN, ex.getRequestHeaders().getFirst("X-Internal-Token"))) {
                send(ex, 401, error("unauthorized", "Missing or wrong internal token."));
                return;
            }
            send(ex, 200, h.handle(query(ex.getRequestURI())));
        } catch (final BadRequest e) {
            send(ex, 400, error("bad_request", e.getMessage()));
        } catch (final Exception e) {
            // Never echo internals; the gateway maps this to a generic 502.
            System.err.println("extractor failed: " + e.getClass().getSimpleName() + ": " + e.getMessage());
            send(ex, 502, error("extractor_failed", "Could not read that from YouTube."));
        }
    }

    private static final int SEARCH_MAX = 50;

    private static Map<String, Object> trackJson(final StreamInfoItem s) {
        final String id = videoId(s.getUrl());
        if (id == null) {
            return null;
        }
        final Map<String, Object> t = new HashMap<>();
        t.put("id", id);
        t.put("title", s.getName());
        t.put("artist", s.getUploaderName());
        t.put("durationSec", s.getDuration() > 0 ? s.getDuration() : null);
        t.put("views", s.getViewCount() >= 0 ? s.getViewCount() : null);
        t.put("thumbnail", s.getThumbnails().isEmpty() ? null : s.getThumbnails().get(0).getUrl());
        return t;
    }

    private static Object search(final Map<String, String> q) throws Exception {
        final String text = q.getOrDefault("q", "").trim();
        if (text.length() < 2 || text.length() > 100) {
            throw new BadRequest("q must be 2 to 100 characters.");
        }
        int limit = 25;
        try {
            limit = Math.max(1, Math.min(SEARCH_MAX, Integer.parseInt(q.getOrDefault("limit", "25"))));
        } catch (final NumberFormatException ignored) {
            // keep the default
        }
        final StreamingService yt = ServiceList.YouTube;
        final var handler = yt.getSearchQHFactory().fromQuery(text, List.of(YoutubeSearchQueryHandlerFactory.MUSIC_SONGS), "");
        final SearchInfo info = SearchInfo.getInfo(yt, handler);

        // One result page holds about 20 songs: read further pages until there are enough (a failed later page just ends the list).
        final List<Map<String, Object>> tracks = new ArrayList<>();
        final java.util.Set<String> seen = new java.util.HashSet<>();
        List<InfoItem> items = new ArrayList<>(info.getRelatedItems());
        org.schabi.newpipe.extractor.Page next = info.getNextPage();
        for (int pages = 0; pages < 4; pages++) {
            for (final InfoItem item : items) {
                if (item instanceof StreamInfoItem s) {
                    final Map<String, Object> t = trackJson(s);
                    if (t != null && seen.add((String) t.get("id"))) {
                        tracks.add(t);
                        if (tracks.size() >= limit) {
                            return Map.of("tracks", tracks);
                        }
                    }
                }
            }
            if (!org.schabi.newpipe.extractor.Page.isValid(next)) {
                break;
            }
            try {
                final var more = SearchInfo.getMoreItems(yt, handler, next);
                items = new ArrayList<>(more.getItems());
                next = more.getNextPage();
            } catch (final Exception e) {
                System.err.println("search page failed: " + e.getClass().getSimpleName());
                break;
            }
        }
        return Map.of("tracks", tracks);
    }

    /** Largest of a set of images (by width when known, else the last one listed). */
    private static String bestImage(final List<Image> images) {
        if (images == null || images.isEmpty()) {
            return null;
        }
        Image best = images.get(images.size() - 1);
        for (final Image i : images) {
            if (i.getWidth() > best.getWidth()) {
                best = i;
            }
        }
        return best.getUrl();
    }

    private static List<ChannelInfoItem> findChannels(final String text) throws Exception {
        final StreamingService yt = ServiceList.YouTube;
        for (final String filter : List.of(YoutubeSearchQueryHandlerFactory.MUSIC_ARTISTS, YoutubeSearchQueryHandlerFactory.CHANNELS)) {
            final List<ChannelInfoItem> out = new ArrayList<>();
            try {
                final SearchInfo info = SearchInfo.getInfo(yt, yt.getSearchQHFactory().fromQuery(text, List.of(filter), ""));
                for (final InfoItem item : info.getRelatedItems()) {
                    if (item instanceof ChannelInfoItem c) {
                        out.add(c);
                    }
                }
            } catch (final Exception e) {
                System.err.println("channel search (" + filter + ") failed: " + e.getClass().getSimpleName());
            }
            if (!out.isEmpty()) {
                return out;
            }
        }
        return new ArrayList<>();
    }

    private static Map<String, Object> channelJson(final ChannelInfoItem c) {
        final Map<String, Object> m = new HashMap<>();
        m.put("name", c.getName());
        m.put("image", bestImage(c.getThumbnails()));
        m.put("subscribers", c.getSubscriberCount() >= 0 ? c.getSubscriberCount() : null);
        m.put("verified", c.isVerified());
        m.put("url", c.getUrl());
        return m;
    }

    private static Object videos(final Map<String, String> q) throws Exception {
        final String text = q.getOrDefault("q", "").trim();
        if (text.length() < 2 || text.length() > 120) {
            throw new BadRequest("q must be 2 to 120 characters.");
        }
        final StreamingService yt = ServiceList.YouTube;
        final SearchInfo info = SearchInfo.getInfo(
                yt, yt.getSearchQHFactory().fromQuery(text, List.of(YoutubeSearchQueryHandlerFactory.MUSIC_VIDEOS), ""));
        final List<Map<String, Object>> out = new ArrayList<>();
        for (final InfoItem item : info.getRelatedItems()) {
            if (!(item instanceof StreamInfoItem s)) {
                continue;
            }
            final String id = videoId(s.getUrl());
            if (id == null) {
                continue;
            }
            final Map<String, Object> v = new HashMap<>();
            v.put("id", id);
            v.put("title", s.getName());
            v.put("artist", s.getUploaderName());
            v.put("durationSec", s.getDuration() > 0 ? s.getDuration() : null);
            out.add(v);
            if (out.size() >= 10) {
                break;
            }
        }
        return Map.of("videos", out);
    }

    private static Object artists(final Map<String, String> q) throws Exception {
        final String text = q.getOrDefault("q", "").trim();
        if (text.length() < 2 || text.length() > 100) {
            throw new BadRequest("q must be 2 to 100 characters.");
        }
        final List<Map<String, Object>> out = new ArrayList<>();
        for (final ChannelInfoItem c : findChannels(text)) {
            final Map<String, Object> m = channelJson(c);
            m.remove("url");
            out.add(m);
            if (out.size() >= 12) {
                break;
            }
        }
        return Map.of("artists", out);
    }

    private static Object artist(final Map<String, String> q) throws Exception {
        final String name = q.getOrDefault("name", "").trim();
        if (name.length() < 2 || name.length() > 100) {
            throw new BadRequest("name must be 2 to 100 characters.");
        }
        final List<ChannelInfoItem> found = findChannels(name);
        if (found.isEmpty()) {
            throw new BadRequest("No artist found for that name.");
        }
        ChannelInfoItem pick = found.get(0);
        for (final ChannelInfoItem c : found) {
            if (c.getName() != null && c.getName().equalsIgnoreCase(name)) {
                pick = c;
                break;
            }
        }
        final Map<String, Object> out = channelJson(pick);
        out.put("channelUrl", pick.getUrl());
        out.remove("url");
        out.put("banner", null);
        out.put("description", null);
        try {
            // The channel page has the banner and the about text; the search hit only has the avatar.
            final ChannelInfo ci = ChannelInfo.getInfo(ServiceList.YouTube, pick.getUrl());
            out.put("banner", bestImage(ci.getBanners()));
            final String d = ci.getDescription();
            out.put("description", d == null || d.isBlank() ? null : d.length() > 4000 ? d.substring(0, 4000) : d);
            final String avatar = bestImage(ci.getAvatars());
            if (avatar != null) {
                out.put("image", avatar);
            }
            if (ci.getSubscriberCount() >= 0) {
                out.put("subscribers", ci.getSubscriberCount());
            }
        } catch (final Exception e) {
            System.err.println("channel info failed: " + e.getClass().getSimpleName());
        }
        return out;
    }

    private static Object suggest(final Map<String, String> q) throws Exception {
        final String text = q.getOrDefault("q", "").trim();
        if (text.isEmpty() || text.length() > 100) {
            throw new BadRequest("q must be 1 to 100 characters.");
        }
        final List<String> out = new ArrayList<>();
        for (final String s : ServiceList.YouTube.getSuggestionExtractor().suggestionList(text)) {
            if (s != null && !s.isBlank() && out.size() < 10) {
                out.add(s.trim());
            }
        }
        return Map.of("suggestions", out);
    }

    private static Object stream(final Map<String, String> q) throws Exception {
        final String id = q.getOrDefault("id", "");
        if (!VIDEO_ID.matcher(id).matches()) {
            throw new BadRequest("id must be a YouTube video id.");
        }
        final StreamInfo si = StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=" + id);
        if (si.getStreamType() != StreamType.VIDEO_STREAM && si.getStreamType() != StreamType.AUDIO_STREAM) {
            throw new BadRequest("Live streams are not supported.");
        }

        // Prefer a plain progressive URL (what an audio player can open).
        final AudioStream best = si.getAudioStreams().stream()
                .filter(a -> a.isUrl() && a.getContent() != null && !a.getContent().isEmpty())
                .filter(a -> a.getDeliveryMethod() == org.schabi.newpipe.extractor.stream.DeliveryMethod.PROGRESSIVE_HTTP)
                // M4A/AAC first: iOS cannot play WebM/Opus. Within a format, the highest bitrate wins.
                .max(Comparator.<AudioStream>comparingInt(a -> a.getFormat() == org.schabi.newpipe.extractor.MediaFormat.M4A ? 1 : 0)
                        .thenComparingInt(AudioStream::getAverageBitrate))
                .orElse(null);
        if (best == null) {
            throw new BadRequest("No playable audio stream for that video.");
        }

        final Map<String, Object> audio = new HashMap<>();
        audio.put("url", best.getContent());
        audio.put("mime", best.getFormat() == null ? null : best.getFormat().getMimeType());
        audio.put("bitrate", best.getAverageBitrate() > 0 ? best.getAverageBitrate() : null);

        // Picture for the in-app video view: plain MP4 (what iOS and Android WebViews play), closest to 480p. The
        // sound always comes from the audio stream above, so a video-only stream is the best fit (and the smallest).
        final VideoStream bestVideo = java.util.stream.Stream.concat(si.getVideoOnlyStreams().stream(), si.getVideoStreams().stream())
                .filter(v -> v.isUrl() && v.getContent() != null && !v.getContent().isEmpty())
                .filter(v -> v.getDeliveryMethod() == org.schabi.newpipe.extractor.stream.DeliveryMethod.PROGRESSIVE_HTTP)
                .filter(v -> v.getFormat() == org.schabi.newpipe.extractor.MediaFormat.MPEG_4)
                .min(Comparator.comparingInt((VideoStream v) -> Math.abs(v.getHeight() - 480)).thenComparing(VideoStream::isVideoOnly, Comparator.reverseOrder()))
                .orElse(null);

        final Map<String, Object> out = new HashMap<>();
        if (bestVideo != null) {
            final Map<String, Object> video = new HashMap<>();
            video.put("url", bestVideo.getContent());
            video.put("mime", "video/mp4");
            video.put("height", bestVideo.getHeight() > 0 ? bestVideo.getHeight() : null);
            out.put("video", video);
        }
        out.put("id", id);
        out.put("title", si.getName());
        out.put("artist", si.getUploaderName());
        out.put("durationSec", si.getDuration() > 0 ? si.getDuration() : null);
        out.put("views", si.getViewCount() >= 0 ? si.getViewCount() : null);
        out.put("thumbnail", si.getThumbnails().isEmpty() ? null : si.getThumbnails().get(0).getUrl());
        out.put("audio", audio);
        return out;
    }

    /* ------------------------------------------------------------------ helpers */

    private static String videoId(final String url) {
        if (url == null) {
            return null;
        }
        final int i = url.indexOf("v=");
        if (i < 0) {
            return null;
        }
        final String rest = url.substring(i + 2);
        final int amp = rest.indexOf('&');
        final String id = amp < 0 ? rest : rest.substring(0, amp);
        return VIDEO_ID.matcher(id).matches() ? id : null;
    }

    private static Map<String, String> query(final URI uri) {
        final Map<String, String> out = new HashMap<>();
        final String raw = uri.getRawQuery();
        if (raw == null) {
            return out;
        }
        for (final String pair : raw.split("&")) {
            final int eq = pair.indexOf('=');
            final String k = URLDecoder.decode(eq < 0 ? pair : pair.substring(0, eq), StandardCharsets.UTF_8);
            final String v = eq < 0 ? "" : URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
            out.put(k, v);
        }
        return out;
    }

    private static boolean constantTimeEquals(final String a, final String b) {
        return b != null && MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    private static Map<String, Object> error(final String code, final String message) {
        return Map.of("error", Map.of("code", code, "message", message));
    }

    private static void send(final HttpExchange ex, final int status, final Object body) throws IOException {
        final byte[] bytes = GSON.toJson(body).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(status, bytes.length);
        try (var os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    private static final class BadRequest extends Exception {
        BadRequest(final String message) {
            super(message);
        }
    }

    private Main() {
    }
}
