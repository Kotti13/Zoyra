package app.zoyra.newpipe;

import okhttp3.OkHttpClient;
import okhttp3.RequestBody;
import okhttp3.ResponseBody;
import org.schabi.newpipe.extractor.downloader.Downloader;
import org.schabi.newpipe.extractor.downloader.Request;
import org.schabi.newpipe.extractor.downloader.Response;
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/** NewPipeExtractor needs a Downloader; this one runs its requests through OkHttp. */
final class OkDownloader extends Downloader {
    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";
    private final OkHttpClient client = new OkHttpClient.Builder()
            .readTimeout(30, TimeUnit.SECONDS)
            .connectTimeout(10, TimeUnit.SECONDS)
            .build();

    @Override
    public Response execute(final Request request) throws IOException, ReCaptchaException {
        final byte[] data = request.dataToSend();
        RequestBody body = null;
        if (data != null) {
            body = RequestBody.create(data);
        } else if ("POST".equals(request.httpMethod()) || "PUT".equals(request.httpMethod())) {
            body = RequestBody.create(new byte[0]);
        }

        final okhttp3.Request.Builder builder = new okhttp3.Request.Builder()
                .method(request.httpMethod(), body)
                .url(request.url())
                .addHeader("User-Agent", USER_AGENT);

        for (final Map.Entry<String, List<String>> e : request.headers().entrySet()) {
            builder.removeHeader(e.getKey());
            for (final String v : e.getValue()) {
                builder.addHeader(e.getKey(), v);
            }
        }

        try (okhttp3.Response res = client.newCall(builder.build()).execute()) {
            if (res.code() == 429) {
                throw new ReCaptchaException("YouTube asked for a captcha (HTTP 429)", request.url());
            }
            final ResponseBody rb = res.body();
            final String text = rb == null ? null : rb.string();
            return new Response(res.code(), res.message(), res.headers().toMultimap(), text, res.request().url().toString());
        }
    }
}
