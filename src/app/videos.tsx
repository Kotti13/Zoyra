import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, useWindowDimensions, View } from 'react-native';

import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  IconButton,
  Loading,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  T,
  Tap,
  TextField,
  Toast,
  useAsync,
  useDebounced,
  useRefreshGroup,
  useRefreshWith,
} from '../components';
import { ServiceNotConfiguredError } from '../lib/concerts';
import { VideoRow, VideoThumb } from '../lib/video-ui';
import {
  compactCount,
  fetchChart,
  fetchLive,
  fetchShorts,
  listSavedVideos,
  searchVideos,
  setVideoSaved,
  videoMeta,
  YOUTUBE_SETUP_MESSAGE,
  youtubeErrorMessage,
  type YouTubePage,
  type YouTubeVideo,
} from '../lib/youtube';
import { useAuth } from '../state/auth';
import { colors, radius } from '../theme/tokens';

/** Hub categories. Each maps to one real YouTube query (charts are cheap; searches are cached). */
const CATEGORIES = ['All', 'Music videos', 'Live now', 'Concerts', 'Lyric videos', 'Shorts'] as const;
type Category = (typeof CATEGORIES)[number];

const CONCERT_QUERY = 'live concert full show';
const LYRIC_QUERY = 'official lyric video';

const openVideo = (v: YouTubeVideo) => router.push({ pathname: '/video-player', params: { id: v.id } });

/** Loads the first page for a category; `null` = this category has no list (All, Shorts). */
function loaderFor(c: Category, q: string): ((token?: string) => Promise<YouTubePage>) | null {
  if (q) return (t) => searchVideos(q, { pageToken: t });
  if (c === 'Music videos') return (t) => fetchChart(t);
  if (c === 'Live now') return (t) => fetchLive(t);
  if (c === 'Concerts') return (t) => searchVideos(CONCERT_QUERY, { pageToken: t, duration: 'long' });
  if (c === 'Lyric videos') return (t) => searchVideos(LYRIC_QUERY, { pageToken: t });
  return null;
}

/**
 * VideoHub. Music videos from the YouTube Data API, played only in YouTube's official embedded player
 * (YouTube API Services Terms): the video stays visible, playback is foreground-only, YouTube serves its ads.
 */
export default function Videos() {
  const { width } = useWindowDimensions();
  const { user } = useAuth();
  const me = user?.id;
  const [draft, setDraft] = useState('');
  const [category, setCategory] = useState<Category>('All');
  const [note, setNote] = useState<string | null>(null);

  // Search costs ~100 quota units: wait for a 700 ms pause and at least 2 characters (or Enter).
  const debounced = useDebounced(draft.trim(), 700);
  const [submitted, setSubmitted] = useState('');
  const live = submitted && submitted === draft.trim() ? submitted : debounced;
  const query = live.length >= 2 ? live : '';

  const saved = useAsync(() => (me ? listSavedVideos(me) : Promise.resolve<YouTubeVideo[]>([])), [me]);
  const savedIds = new Set((saved.data ?? []).map((v) => v.id));

  const toggleSave = async (v: YouTubeVideo) => {
    if (!me) return setNote('Sign in to save videos.');
    try {
      await setVideoSaved(me, v, !savedIds.has(v.id));
      saved.reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not update My list');
    }
  };

  const pickCategory = (c: Category) => {
    if (c === 'Shorts') return router.push('/video-shorts');
    setCategory(c);
  };

  const loader = loaderFor(category, query);

  // Pull to refresh: My list plus whichever tab is showing (charts / shorts / concerts, or the list).
  const group = useRefreshGroup();
  const refresh = () => Promise.all([saved.refresh(), group.run()]);

  return (
    <group.Provider value={group.value}>
      <Screen top={4} gap={18} backdrop={{ pattern: 'lines', mesh: 'coral' }} onRefresh={refresh}>
        <ScreenHeader title="Videos" />

        <TextField
          label="Search music videos"
          hideLabel
          icon="search"
          value={draft}
          onChangeText={setDraft}
          placeholder="Search songs, artists, live sets"
          returnKeyType="search"
          onSubmitEditing={() => setSubmitted(draft.trim())}
        />

        {!query ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16, flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
            {CATEGORIES.map((c) => (
              <Chip key={c} label={c} active={c === category} onPress={() => pickCategory(c)} />
            ))}
          </ScrollView>
        ) : null}

        {note ? <Toast icon="info" iconColor={colors.accentLight} message={note} action="OK" onAction={() => setNote(null)} /> : null}

        {loader ? (
          <VideoList key={`${category}:${query}`} load={loader} title={query ? `Results for “${query}”` : category} savedIds={savedIds} onSave={toggleSave} />
        ) : (
          <AllTab width={width} saved={saved.data ?? []} savedIds={savedIds} onSave={toggleSave} />
        )}

        <T size={11} color={colors.textTertiary} align="center">
          Videos are played by YouTube. Zoyra does not host or download them.
        </T>
      </Screen>
    </group.Provider>
  );
}

/* ------------------------------------------------------------------ All */

/** Rethrows with a user-facing sentence (incl. "needs YouTube setup"). */
const friendly = <T,>(p: Promise<T>): Promise<T> =>
  p.catch((e: unknown) => {
    throw new Error(youtubeErrorMessage(e));
  });

function AllTab({ width, saved, savedIds, onSave }: { width: number; saved: YouTubeVideo[]; savedIds: Set<string>; onSave: (v: YouTubeVideo) => Promise<void> }) {
  const chart = useAsync(() => friendly(fetchChart()), []);
  const shorts = useAsync(() => friendly(fetchShorts()), []);
  const concerts = useAsync(() => friendly(searchVideos(CONCERT_QUERY, { duration: 'long' })), []);
  useRefreshWith(() => Promise.all([chart.refresh(), shorts.refresh(), concerts.refresh()]));

  if (chart.error && chart.error === YOUTUBE_SETUP_MESSAGE) return <Toast icon="info" iconColor={colors.accentLight} message={YOUTUBE_SETUP_MESSAGE} />;
  const featured = chart.data?.videos[0];
  const trending = chart.data?.videos.slice(1, 13) ?? [];
  const cardW = Math.min(240, Math.round(width * 0.62));

  return (
    <>
      {chart.loading && !chart.data ? (
        <Loading label="Loading trending music videos" />
      ) : chart.error ? (
        <ErrorState message={chart.error} onRetry={chart.reload} />
      ) : featured ? (
        <Featured video={featured} width={width - 32} saved={savedIds.has(featured.id)} onSave={() => void onSave(featured)} />
      ) : (
        <EmptyState icon="search" title="No music videos right now" body="YouTube returned an empty chart for your region." />
      )}

      {trending.length ? (
        <View style={{ gap: 4 }}>
          <SectionHeader title="Trending videos" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}>
            {trending.map((v) => (
              <Tap key={v.id} onPress={() => openVideo(v)} accessibilityLabel={`Play ${v.title} by ${v.channel}`} style={{ width: cardW, gap: 8 }}>
                <VideoThumb video={v} width={cardW} radius={radius.md} />
                <View style={{ gap: 2 }}>
                  <T size={14} weight={600} numberOfLines={2}>
                    {v.title}
                  </T>
                  <T size={12} color={colors.textSecondary} numberOfLines={1}>
                    {[v.channel, v.views !== null ? compactCount(v.views) : null].filter(Boolean).join(' · ')}
                  </T>
                </View>
              </Tap>
            ))}
          </ScrollView>
        </View>
      ) : null}

      <View style={{ gap: 4 }}>
        <SectionHeader title="Shorts" action="Open shorts" href="/video-shorts" />
        {shorts.loading && !shorts.data ? (
          <Loading height={80} />
        ) : shorts.error ? (
          <ErrorState message={shorts.error} onRetry={shorts.reload} />
        ) : !shorts.data?.videos.length ? (
          <T size={14} color={colors.textSecondary}>
            No shorts available right now.
          </T>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 10, paddingHorizontal: 16 }}>
            {shorts.data.videos.slice(0, 10).map((v, i) => (
              <Tap
                key={v.id}
                onPress={() => router.push({ pathname: '/video-shorts', params: { start: v.id, index: String(i) } })}
                accessibilityLabel={`Open short ${v.title}`}
                style={{ width: 120, gap: 6 }}
              >
                <ShortThumb video={v} />
                <T size={12} weight={600} numberOfLines={2}>
                  {v.title}
                </T>
              </Tap>
            ))}
          </ScrollView>
        )}
      </View>

      {saved.length ? (
        <View style={{ gap: 4 }}>
          <SectionHeader title="My list" />
          {saved.slice(0, 6).map((v) => (
            <VideoRow key={v.id} video={v} meta={v.channel} onPress={() => openVideo(v)} />
          ))}
        </View>
      ) : null}

      <View style={{ gap: 4 }}>
        <SectionHeader title="Concerts and live" />
        {concerts.loading && !concerts.data ? (
          <Loading height={80} />
        ) : concerts.error ? (
          <ErrorState message={concerts.error} onRetry={concerts.reload} />
        ) : !concerts.data?.videos.length ? (
          <T size={14} color={colors.textSecondary}>
            No concerts found right now.
          </T>
        ) : (
          <View style={{ gap: 10 }}>
            {concerts.data.videos.slice(0, 6).map((v) => (
              <VideoRow key={v.id} video={v} meta={[v.channel, v.views !== null ? `${compactCount(v.views)} views` : null].filter(Boolean).join(' · ')} onPress={() => openVideo(v)} />
            ))}
          </View>
        )}
      </View>
    </>
  );
}

function ShortThumb({ video }: { video: YouTubeVideo }) {
  return (
    <View style={{ width: 120, height: 200, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.bgTertiary }}>
      <VideoThumb video={{ ...video, durationSec: null }} width={356} radius={0} style={{ position: 'absolute', left: -118, top: 0, height: 200 }} />
      {video.views !== null ? (
        <View style={{ position: 'absolute', left: 8, bottom: 8, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.shade }}>
          <T size={11} weight={600} color={colors.white}>
            {compactCount(video.views)} views
          </T>
        </View>
      ) : null}
    </View>
  );
}

function Featured({ video, width, saved, onSave }: { video: YouTubeVideo; width: number; saved: boolean; onSave: () => void }) {
  const official = /official/i.test(video.title);
  return (
    <View style={{ gap: 12 }}>
      <Tap onPress={() => openVideo(video)} accessibilityLabel={`Play ${video.title} by ${video.channel}`}>
        <VideoThumb video={video} width={width} radius={radius.xl} />
      </Tap>
      <View style={{ gap: 4 }}>
        {official || video.live ? (
          <T size={12} weight={700} color={colors.accentLight} tracking={1.2}>
            {video.live ? 'LIVE' : 'OFFICIAL VIDEO'}
          </T>
        ) : (
          <T size={12} weight={700} color={colors.accentLight} tracking={1.2}>
            #1 TRENDING MUSIC VIDEO
          </T>
        )}
        <T size={24} weight={300} lineHeight={30} numberOfLines={2}>
          {video.title}
        </T>
        <T size={13} color={colors.textSecondary} numberOfLines={1}>
          {[video.channel, videoMeta(video)].filter(Boolean).join(' · ')}
        </T>
      </View>
      <Row gap={10}>
        <Button label="Watch" icon="play" height={44} onPress={() => openVideo(video)} style={{ flex: 1 }} />
        <Button label={saved ? 'In my list' : 'My list'} icon={saved ? 'check' : 'plus'} variant="glass" height={44} onPress={onSave} style={{ flex: 1 }} />
      </Row>
    </View>
  );
}

/* ------------------------------------------------------------------ one category / search results */

function VideoList({
  load,
  title,
  savedIds,
  onSave,
}: {
  load: (token?: string) => Promise<YouTubePage>;
  title: string;
  savedIds: Set<string>;
  onSave: (v: YouTubeVideo) => Promise<void>;
}) {
  const [more, setMore] = useState<YouTubeVideo[]>([]);
  const [token, setToken] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const res = useAsync<YouTubePage & { notConfigured: boolean }>(async () => {
    try {
      const page = await load();
      setToken(page.nextPageToken);
      setMore([]); // a refresh starts paging over
      return { ...page, notConfigured: false };
    } catch (e) {
      if (e instanceof ServiceNotConfiguredError) return { videos: [], notConfigured: true };
      throw e;
    }
  }, []);

  useRefreshWith(res.refresh);

  const loadMore = useCallback(async () => {
    if (!token || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await load(token);
      setMore((m) => [...m, ...page.videos.filter((v) => !m.some((x) => x.id === v.id))]);
      setToken(page.nextPageToken);
    } catch (e) {
      setMoreError(youtubeErrorMessage(e, 'Could not load more videos'));
    } finally {
      setLoadingMore(false);
    }
  }, [token, loadingMore, load]);

  if (res.data?.notConfigured) return <Toast icon="info" iconColor={colors.accentLight} message={YOUTUBE_SETUP_MESSAGE} />;
  if (res.loading) return <Loading label={`Loading ${title.toLowerCase()}`} />;
  if (res.error) return <ErrorState message={res.error} onRetry={res.reload} />;
  const first = res.data?.videos ?? [];
  const videos = [...first, ...more.filter((v) => !first.some((x) => x.id === v.id))];
  if (!videos.length) return <EmptyState icon="search" title="No videos found" body={title === 'Live now' ? 'No music streams are live right now.' : 'Try another song or artist name.'} />;

  return (
    <View style={{ gap: 10 }}>
      <T variant="caption" color={colors.textSecondary}>
        {title}
      </T>
      {videos.map((v) => (
        <VideoRow
          key={v.id}
          video={v}
          meta={[v.channel, videoMeta(v)].filter(Boolean).join(' · ')}
          onPress={() => openVideo(v)}
          right={
            <IconButton
              icon={savedIds.has(v.id) ? 'check' : 'plus'}
              iconSize={20}
              color={savedIds.has(v.id) ? colors.accentLight : colors.textSecondary}
              label={savedIds.has(v.id) ? `Remove ${v.title} from My list` : `Add ${v.title} to My list`}
              onPress={() => void onSave(v)}
            />
          }
        />
      ))}
      {moreError ? <ErrorState message={moreError} onRetry={() => void loadMore()} /> : null}
      {token ? (
        loadingMore ? (
          <Loading height={60} />
        ) : (
          <Button label="Load more" variant="glass" height={44} onPress={() => void loadMore()} />
        )
      ) : null}
    </View>
  );
}
