import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Button, Chip, Cover, EmptyState, ErrorState, Glass, Icon, IconButton, ListRow, Loading, ProgressBar, Row, Screen, ScreenHeader, SectionHeader, T, Tap, TextField, Toast, useAsync, useDebounced, useRefreshGroup, useRefreshWith } from '../components';
import { formatDuration } from '../lib/catalog';
import {
  ATTRIBUTION,
  BOOK_GENRES,
  bookDetail,
  booksByGenre,
  chapterTrack,
  formatLength,
  loadProgress,
  MAIN_PLAYER_STREAMS_URLS,
  saveProgress,
  searchBooks,
  type Book,
  type BookProgress,
  type Chapter,
} from '../lib/audiobooks';
import { usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

const PAGE = 20;

const openLink = async (url: string | null, onFail: (t: string) => void) => {
  if (!url) return;
  try {
    await WebBrowser.openBrowserAsync(url);
  } catch {
    onFail('Could not open the link.');
  }
};

function Attribution() {
  return (
    <T size={12} color={colors.textSecondary} align="center">
      {ATTRIBUTION} Audiobooks courtesy of librivox.org and archive.org.
    </T>
  );
}

function BookCard({ b }: { b: Book }) {
  return (
    <Tap onPress={() => router.push({ pathname: '/audiobooks', params: { id: b.id } })} accessibilityLabel={`${b.title} by ${b.authors}${b.totalSecs ? `, ${formatLength(b.totalSecs)}` : ''}`} style={{ width: 140 }}>
      <View style={{ gap: 8 }}>
        <Cover uri={b.cover} id={b.id} width={140} height={180} radius={22} />
        <View style={{ gap: 2 }}>
          <T size={14} weight={600} numberOfLines={2}>
            {b.title}
          </T>
          <T size={12} color={colors.textSecondary} numberOfLines={1}>
            {[b.authors, formatLength(b.totalSecs)].filter(Boolean).join(' · ')}
          </T>
        </View>
      </View>
    </Tap>
  );
}

function BookRow({ b, divider }: { b: Book; divider?: boolean }) {
  return (
    <ListRow
      divider={divider}
      leading={<Cover uri={b.cover} id={b.id} width={44} height={56} radius={10} />}
      title={b.title}
      subtitle={[b.authors, formatLength(b.totalSecs)].filter(Boolean).join(' · ')}
      onPress={() => router.push({ pathname: '/audiobooks', params: { id: b.id } })}
    />
  );
}

/* ------------------------------------------------------------------ browse */

function Browse() {
  const [genre, setGenre] = useState(0);
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 400);
  const [extra, setExtra] = useState<Book[]>([]);
  const [more, setMore] = useState<{ busy: boolean; done: boolean; error: string | null; next: number }>({ busy: false, done: false, error: null, next: 0 });
  const [progress, setProgress] = useState<BookProgress[]>([]);

  useEffect(() => {
    void loadProgress().then(setProgress);
  }, []);

  const g = BOOK_GENRES[genre].genre;
  const list = useAsync(async () => {
    setExtra([]);
    const page = await booksByGenre(g, 0, PAGE);
    setMore({ busy: false, done: page.end, error: null, next: page.next });
    return page.books;
  }, [g]);
  const found = useAsync(async () => (q.length >= 2 ? searchBooks(q) : null), [q]);
  useRefreshWith(() => Promise.all([list.refresh(), found.refresh(), loadProgress().then(setProgress)]));

  const loadMore = async () => {
    if (more.busy) return;
    setMore((m) => ({ ...m, busy: true, error: null }));
    try {
      const page = await booksByGenre(g, more.next, PAGE);
      const have = new Set([...(list.data ?? []), ...extra].map((b) => b.id));
      const fresh = page.books.filter((b) => !have.has(b.id));
      setExtra((x) => [...x, ...fresh]);
      setMore({ busy: false, done: page.end, error: null, next: page.next });
    } catch (e) {
      setMore((m) => ({ ...m, busy: false, error: e instanceof Error ? e.message : 'Could not load more books.' }));
    }
  };

  const books = [...(list.data ?? []), ...extra];
  const latest = progress[0];

  return (
    <>
      <View style={{ gap: 4 }}>
        <T variant="displayLight" accessibilityRole="header">
          Audiobooks
        </T>
        <T size={15} color={colors.textSecondary}>
          Free public-domain classics from LibriVox
        </T>
      </View>

      <TextField label="Search audiobooks" icon="search" value={query} onChangeText={setQuery} placeholder="Title or author" returnKeyType="search" autoCapitalize="none" />

      {q.length >= 2 ? (
        found.loading ? (
          <Loading label="Searching LibriVox" />
        ) : found.error ? (
          <ErrorState message={found.error} onRetry={found.reload} />
        ) : !found.data?.length ? (
          <EmptyState icon="search" title="No audiobooks found" body="Search by the start of a title (without “The”) or an author’s surname." />
        ) : (
          <Glass padding={4}>
            {found.data.map((b, i) => (
              <BookRow key={b.id} b={b} divider={i > 0} />
            ))}
          </Glass>
        )
      ) : (
        <>
          {latest ? (
            <Tap onPress={() => router.push({ pathname: '/audiobooks', params: { id: latest.bookId } })} accessibilityLabel={`Continue ${latest.title}, ${latest.chapterTitle}`}>
              <Glass padding={14}>
                <Row gap={14}>
                  <Cover uri={latest.cover} id={latest.bookId} width={64} height={84} radius={14} />
                  <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                    <T variant="overline" color={colors.accentLight}>
                      CONTINUE LISTENING
                    </T>
                    <T size={17} weight={600} numberOfLines={2}>
                      {latest.title}
                    </T>
                    <T size={13} color={colors.textSecondary} numberOfLines={1}>
                      {latest.chapterTitle} · at {formatDuration(latest.position)}
                    </T>
                  </View>
                  <Icon name="play" size={22} color={colors.accentLight} />
                </Row>
              </Glass>
            </Tap>
          ) : null}

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
            {BOOK_GENRES.map((x, i) => (
              <Chip key={x.label} label={x.label} active={i === genre} onPress={() => setGenre(i)} />
            ))}
          </ScrollView>

          {list.loading ? (
            <Loading label="Loading audiobooks" />
          ) : list.error ? (
            <ErrorState message={list.error} onRetry={list.reload} />
          ) : !books.length ? (
            <EmptyState icon="search" title="Nothing here yet" body="LibriVox has no books in this shelf right now." />
          ) : (
            <>
              <SectionHeader title={BOOK_GENRES[genre].label} />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}>
                {books.slice(0, 8).map((b) => (
                  <BookCard key={b.id} b={b} />
                ))}
              </ScrollView>
              {books.length > 8 ? (
                <>
                  <SectionHeader title="More to explore" />
                  <Glass padding={4}>
                    {books.slice(8).map((b, i) => (
                      <BookRow key={b.id} b={b} divider={i > 0} />
                    ))}
                  </Glass>
                </>
              ) : null}
              {more.error ? <Toast icon="info" iconColor={colors.error} message={more.error} /> : null}
              {more.done ? (
                <T size={13} color={colors.textSecondary} align="center">
                  That’s everything on this shelf.
                </T>
              ) : (
                <Button label={more.busy ? 'Loading…' : 'Load more'} variant="glass" onPress={() => void loadMore()} />
              )}
            </>
          )}
        </>
      )}

      <Attribution />
    </>
  );
}

/* ------------------------------------------------------------------ book */

/**
 * Chapter playback. The shared player streams Audius ids only, so (until MAIN_PLAYER_STREAMS_URLS)
 * chapters play in this screen's own player, which pauses the music first and stops when you leave.
 */
function useChapterPlayer(book: Book | undefined, chapters: Chapter[]) {
  const main = usePlayerPick('playing');
  const player = useAudioPlayer(null, { updateInterval: 500 });
  const status = useAudioPlayerStatus(player);
  const [current, setCurrent] = useState<number | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const lastSaved = useRef(0);

  const play = useCallback(
    (i: number, startAt = 0) => {
      const c = chapters[i];
      if (!c || !book) return;
      if (MAIN_PLAYER_STREAMS_URLS) {
        main.playTracks(
          chapters.map((x) => chapterTrack(book, x)),
          i,
          `audiobook:${book.id}`,
        );
        return;
      }
      main.pause();
      setCurrent(i);
      pendingSeek.current = startAt > 5 ? startAt : null;
      player.replace({ uri: c.url });
      player.play();
    },
    [book, chapters, main, player],
  );

  // Seek once the new chapter has loaded (resume).
  useEffect(() => {
    if (status.isLoaded && pendingSeek.current !== null) {
      const at = pendingSeek.current;
      pendingSeek.current = null;
      void player.seekTo(at);
    }
  }, [status.isLoaded, player]);

  // Next chapter when one ends.
  const onEnd = useRef<() => void>(() => {});
  useEffect(() => {
    onEnd.current = () => {
      if (current !== null && current + 1 < chapters.length) play(current + 1);
    };
  }, [current, chapters.length, play]);
  useEffect(() => {
    const sub = player.addListener('playbackStatusUpdate', (s) => {
      if (s.didJustFinish) onEnd.current();
    });
    return () => sub.remove();
  }, [player]);

  // Music started elsewhere: step aside.
  useEffect(() => {
    if (main.playing && status.playing) player.pause();
  }, [main.playing, status.playing, player]);

  // Remember where the listener is (this device), every ~10 s and on pause.
  useEffect(() => {
    if (!book || current === null) return;
    const c = chapters[current];
    const at = Math.floor(status.currentTime);
    if (!c || at < 1) return;
    if (status.playing && Math.abs(at - lastSaved.current) < 10) return;
    lastSaved.current = at;
    void saveProgress({ bookId: book.id, title: book.title, authors: book.authors, cover: book.cover, chapter: current, chapterTitle: c.title, position: at, at: Date.now() });
  }, [book, chapters, current, status.currentTime, status.playing]);

  return {
    current,
    status,
    play,
    toggle: () => {
      if (status.playing) return player.pause();
      main.pause();
      player.play();
    },
    skip: (s: number) => void player.seekTo(Math.max(0, status.currentTime + s)),
  };
}

function BookView({ id }: { id: string }) {
  const res = useAsync(() => bookDetail(id), [id]);
  const progress = useAsync(async () => (await loadProgress()).find((p) => p.bookId === id) ?? null, [id]);
  useRefreshWith(() => Promise.all([res.refresh(), progress.refresh()]));
  const book = res.data?.book;
  const chapters = res.data?.chapters ?? [];
  const cp = useChapterPlayer(book, chapters);
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (res.loading) return <Loading label="Loading audiobook" />;
  if (res.error || !book) return <ErrorState message={res.error ?? 'Could not load this audiobook.'} onRetry={res.reload} />;

  const resume = progress.data && progress.data.chapter < chapters.length ? progress.data : null;
  const playing = cp.current !== null ? chapters[cp.current] : null;
  const readers = [...new Set(chapters.flatMap((c) => c.readers.split(', ').filter(Boolean)))];

  return (
    <>
      <Row gap={16} align="flex-end">
        <Cover uri={book.cover} id={book.id} width={128} height={168} radius={22} />
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <T size={26} weight={300} tracking={-0.6} lineHeight={30} numberOfLines={4} accessibilityRole="header">
            {book.title}
          </T>
          <T size={14} color={colors.textSecondary} numberOfLines={2}>
            {book.authors}
          </T>
          <T mono size={12} color={colors.textSecondary}>
            {[formatLength(book.totalSecs), `${chapters.length} ${chapters.length === 1 ? 'section' : 'sections'}`, book.language].filter(Boolean).join(' · ')}
          </T>
        </View>
      </Row>

      {chapters.length ? (
        <Button
          label={resume ? `Resume ${resume.chapterTitle}` : 'Play from the start'}
          icon="play"
          onPress={() => (resume ? cp.play(resume.chapter, resume.position) : cp.play(0))}
        />
      ) : (
        <Toast icon="info" iconColor={colors.accentLight} message="LibriVox lists no playable sections for this book yet." />
      )}

      {playing ? (
        <Glass padding={14}>
          <View style={{ gap: 10 }}>
            <Row>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <T variant="overline" color={colors.accentLight}>
                  {cp.status.isBuffering && !cp.status.playing ? 'LOADING' : cp.status.playing ? 'NOW PLAYING' : 'PAUSED'}
                </T>
                <T size={15} weight={600} numberOfLines={1}>
                  {playing.title}
                </T>
              </View>
              <IconButton icon="prev" label="Back 30 seconds" onPress={() => cp.skip(-30)} />
              <IconButton icon={cp.status.playing ? 'pause' : 'play'} label={cp.status.playing ? 'Pause' : 'Play'} bg={colors.accent} onPress={cp.toggle} />
              <IconButton icon="next" label="Forward 30 seconds" onPress={() => cp.skip(30)} />
            </Row>
            <ProgressBar value={cp.status.duration > 0 ? Math.min(1, cp.status.currentTime / cp.status.duration) : 0} />
            <Row style={{ justifyContent: 'space-between' }}>
              <T mono size={12} color={colors.textSecondary}>
                {formatDuration(cp.status.currentTime)}
              </T>
              <T mono size={12} color={colors.textSecondary}>
                {cp.status.duration > 0 ? formatDuration(cp.status.duration) : '–:––'}
              </T>
            </Row>
            <T size={12} color={colors.textSecondary}>
              Plays while this page is open. Leaving it stops the chapter; your place is saved.
            </T>
          </View>
        </Glass>
      ) : null}

      {book.description ? (
        <Tap onPress={() => setExpanded((x) => !x)} accessibilityLabel={expanded ? 'Show less' : 'Show the full description'}>
          <T size={14} color={colors.textSecondary} lineHeight={21} numberOfLines={expanded ? undefined : 4}>
            {book.description}
          </T>
        </Tap>
      ) : null}

      {chapters.length ? (
        <>
          <SectionHeader title="Chapters" />
          <Glass padding={4}>
            {chapters.map((c, i) => (
              <ListRow
                key={c.id}
                divider={i > 0}
                minHeight={60}
                leading={
                  <T mono size={13} color={cp.current === i ? colors.accentLight : colors.textSecondary} align="center" style={{ width: 28 }}>
                    {c.n}
                  </T>
                }
                title={c.title}
                titleColor={cp.current === i ? colors.accentLight : colors.text}
                subtitle={[c.secs ? formatDuration(c.secs) : null, c.readers ? `Read by ${c.readers}` : null].filter(Boolean).join(' · ')}
                onPress={() => cp.play(i)}
                right={<Icon name={cp.current === i && cp.status.playing ? 'speaker' : 'play'} size={18} color={colors.accentLight} />}
              />
            ))}
          </Glass>
        </>
      ) : null}

      <SectionHeader title="Credits" />
      <Glass padding={4}>
        <ListRow icon="user" title="Author" subtitle={book.authors} right={false} />
        {readers.length ? <ListRow divider icon="mic" title={readers.length === 1 ? 'Reader' : 'Readers'} subtitle={readers.slice(0, 12).join(', ') + (readers.length > 12 ? ` and ${readers.length - 12} more` : '')} right={false} /> : null}
        {book.copyrightYear ? <ListRow divider icon="clock" title="First published" subtitle={book.copyrightYear} right={false} /> : null}
        {book.librivoxUrl ? <ListRow divider icon="globe" title="LibriVox page" subtitle="Recording details and volunteers" onPress={() => void openLink(book.librivoxUrl, setNote)} /> : null}
        {book.textUrl ? <ListRow divider icon="file" title="Read the text" subtitle="Online source text" onPress={() => void openLink(book.textUrl, setNote)} /> : null}
      </Glass>
      {note ? <Toast icon="info" iconColor={colors.error} message={note} /> : null}

      <Attribution />
    </>
  );
}

export default function Audiobooks() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  // Pull to refresh reloads whichever view is showing (the browse lists or the book detail).
  const group = useRefreshGroup();
  return (
    <group.Provider value={group.value}>
      <Screen top={4} gap={18} backdrop={{ pattern: 'none' }} onRefresh={group.run}>
        <ScreenHeader title={id ? 'Audiobook' : ''} />
        {id ? <BookView key={id} id={id} /> : <Browse />}
      </Screen>
    </group.Provider>
  );
}
