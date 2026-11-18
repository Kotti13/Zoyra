import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, TextInput, useWindowDimensions, View } from 'react-native';

import { Cover, EmptyState, ErrorState, Icon, IconButton, Loading, Row, Screen, T, Tap, useDebounced } from '../components';
import { PhotoViewer, type ViewerPhoto } from '../components/PhotoViewer';
import type { CatalogTrack } from '../lib/catalog';
import { chatPeerParams, formatMs, useChatMediaUrl } from '../lib/chat';
import { firstUrl, highlightParts, hitChatName, mergeEncryptedHits, searchMyMessages, urlHost, type ChatSearchHit, type ChatSearchKind } from '../lib/chat-search';
import { loadInbox, searchContacts, startChat, type DmAccess, type InboxRow } from '../lib/dm';
import { friendlySocialError } from '../lib/social';
import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import { colors, fonts, withAlpha } from '../theme/tokens';

type Filter = 'all' | 'people' | Exclude<ChatSearchKind, 'all'>;
/** `access` from message_contacts: 'locked' = their privacy settings refuse a new chat from me (follow first). */
type Person = { id: string; display_name: string; avatar_url: string | null; conversation_id: string | null; access?: DmAccess };

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'people', label: 'People' },
  { key: 'songs', label: 'Songs' },
  { key: 'voice', label: 'Voice' },
  { key: 'media', label: 'Media' },
  { key: 'links', label: 'Links' },
  { key: 'polls', label: 'Polls' },
];

const SOFT = '#E5E5E5';
const FIELD_BG = withAlpha(colors.white, 0.06);
const FIELD_BORDER = withAlpha(colors.white, 0.12);
const HIGHLIGHT = withAlpha(colors.accent, 0.45);
const SONG_KINDS = new Set(['track', 'swap', 'lyric']);

/** "9:41" today, weekday this week, else "12 Nov". */
function shortDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

const isGroupRow = (r: InboxRow) => (r as InboxRow & { kind?: string | null }).kind === 'group' || Number(r.member_count) > 2;

/** Track stored in a message → player track (server rows may store `artist` as a plain string). */
function toCatalogTrack(raw: Record<string, unknown> | null | undefined): CatalogTrack | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.title !== 'string') return null;
  const a = raw.artist;
  const artist = typeof a === 'string' ? { id: '', name: a, handle: '', verified: false } : (a as CatalogTrack['artist'] | undefined) ?? { id: '', name: '', handle: '', verified: false };
  const art = raw.artwork;
  const artwork = typeof art === 'string' ? { small: art, medium: art, large: art } : ((art as CatalogTrack['artwork'] | undefined) ?? {});
  return { plays: 0, likes: 0, duration: 0, ...(raw as Partial<CatalogTrack>), artist, artwork } as CatalogTrack;
}

function songOf(h: ChatSearchHit): CatalogTrack | null {
  return toCatalogTrack(h.track ?? (h.kind === 'lyric' ? (h.meta.track as Record<string, unknown> | undefined) : null));
}

/** Opens the chat of a hit; with a query, chat search opens on it. */
function openHit(h: ChatSearchHit, q: string) {
  const search = q.trim() ? { search: q.trim() } : {};
  if (h.is_group) {
    router.push({ pathname: '/group-chat', params: { id: h.conversation_id, ...search } });
    return;
  }
  const peer = h.other_id ? chatPeerParams({ id: h.other_id, display_name: h.other_name, avatar_url: h.other_avatar }) : {};
  router.push({ pathname: '/chat-pro', params: { id: h.conversation_id, ...peer, ...search } });
}

function Initial({ name, size }: { name: string | null | undefined; size: number }) {
  return (
    <T size={Math.round(size / 3)} weight={700} color={colors.white}>
      {(name?.trim()[0] ?? '?').toUpperCase()}
    </T>
  );
}

function Face({ id, name, uri, size, r }: { id?: string | null; name?: string | null; uri?: string | null; size: number; r: number }) {
  return (
    <Cover uri={uri} id={id ?? name ?? undefined} size={size} radius={r} style={{ alignItems: 'center', justifyContent: 'center' }}>
      {uri ? null : <Initial name={name} size={size} />}
    </Cover>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <T size={12} weight={600} tracking={1.2} color={colors.textSecondary} accessibilityRole="header" style={{ paddingHorizontal: 4 }}>
      {children}
    </T>
  );
}

function Pill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Tap onPress={onPress} accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={label} style={{ height: 44, justifyContent: 'center' }}>
      <View
        style={[
          { height: 36, paddingHorizontal: 16, borderRadius: 18, justifyContent: 'center' },
          active ? { backgroundColor: colors.text } : { backgroundColor: FIELD_BG, borderWidth: 1, borderColor: FIELD_BORDER },
        ]}
      >
        <T size={13} weight={600} color={active ? colors.playerBg : colors.text}>
          {label}
        </T>
      </View>
    </Tap>
  );
}

function Highlighted({ text, q }: { text: string; q: string }) {
  return (
    <T size={14} color={SOFT} lineHeight={19} numberOfLines={2}>
      {highlightParts(text, q).map((p, i) =>
        p.hit ? (
          <T key={i} size={14} color={colors.white} style={{ backgroundColor: HIGHLIGHT }}>
            {p.text}
          </T>
        ) : (
          p.text
        ),
      )}
    </T>
  );
}

function MessageRow({ h, q }: { h: ChatSearchHit; q: string }) {
  const name = hitChatName(h);
  const avatar = h.is_group ? h.conversation_avatar : h.other_avatar;
  const text = h.is_group && h.sender_name ? `${h.sender_name.split(' ')[0]}: ${h.snippet}` : h.snippet;
  return (
    <Tap onPress={() => openHit(h, q)} pressScale={0.98} accessibilityLabel={`${name}, ${shortDate(h.created_at)}: ${text}. Open in chat`}>
      <Row gap={12} style={{ paddingVertical: 10, paddingHorizontal: 4 }}>
        <Face id={h.is_group ? h.conversation_id : h.other_id} name={name} uri={avatar} size={44} r={22} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Row gap={8} style={{ justifyContent: 'space-between' }}>
            <T size={15} weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>
              {name}
            </T>
            <T size={12} color={colors.textSecondary}>
              {shortDate(h.created_at)}
            </T>
          </Row>
          <Highlighted text={text} q={q} />
        </View>
      </Row>
    </Tap>
  );
}

function SongRow({ h, q }: { h: ChatSearchHit; q: string }) {
  const { playTrack } = usePlayerPick();
  const t = songOf(h);
  const { user } = useAuth();
  const from = h.sender_id === user?.id ? 'you' : (h.sender_name?.split(' ')[0] ?? 'a friend');
  const title = t?.title ?? h.snippet;
  const sub = `Sent by ${from}${t?.artist.name ? ` · ${t.artist.name}` : ''}`;
  return (
    <Tap
      onPress={() => {
        if (!t) return openHit(h, q);
        playTrack(t, `Shared by ${from}`);
        router.push('/player');
      }}
      onLongPress={() => openHit(h, q)}
      pressScale={0.98}
      accessibilityLabel={`${title}. ${sub}. Play`}
      accessibilityHint="Long press to open the chat"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, borderRadius: 22, backgroundColor: FIELD_BG, borderWidth: 1, borderColor: FIELD_BORDER }}
    >
      <Cover artwork={t?.artwork} id={t?.id ?? h.id} size={48} radius={22} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T size={14} weight={600} numberOfLines={1}>
          {title}
        </T>
        <T size={12} color={colors.textSecondary} numberOfLines={1}>
          {sub}
        </T>
      </View>
      <View style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="play" size={18} color={colors.white} filled />
      </View>
    </Tap>
  );
}

function IconRow({ h, q, icon, title, sub }: { h: ChatSearchHit; q: string; icon: 'mic' | 'link' | 'chart'; title: string; sub: string }) {
  return (
    <Tap onPress={() => openHit(h, q)} pressScale={0.98} accessibilityLabel={`${title}. ${sub}. Open in chat`}>
      <Row gap={12} style={{ paddingVertical: 10, paddingHorizontal: 4 }}>
        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: withAlpha(colors.accent, 0.16), alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={icon} size={20} color={colors.accentLight} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          {icon === 'mic' ? (
            <T size={15} weight={600} numberOfLines={1}>
              {title}
            </T>
          ) : (
            <Highlighted text={title} q={q} />
          )}
          <T size={12} color={colors.textSecondary} numberOfLines={1}>
            {sub}
          </T>
        </View>
      </Row>
    </Tap>
  );
}

/** Photo of a hit: plaintext meta.path, or the encrypted file in meta.media ({path, key, mime}). */
function photoOf(h: ChatSearchHit): { path: string; key?: string; mime?: string; width?: number; height?: number } | null {
  const media = h.meta.media && typeof h.meta.media === 'object' ? (h.meta.media as Record<string, unknown>) : null;
  const src = media ?? h.meta;
  if (typeof src.path !== 'string') return null;
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const n = (v: unknown) => (typeof v === 'number' ? v : undefined);
  return { path: src.path, key: media ? s(media.key) : undefined, mime: s(src.mime), width: n(src.width), height: n(src.height) };
}

function PhotoTile({ h, size, onOpen }: { h: ChatSearchHit; size: number; onOpen: () => void }) {
  const ph = photoOf(h);
  const { url, error } = useChatMediaUrl(ph?.path ?? null, ph?.key, ph?.mime);
  return (
    <Tap onPress={onOpen} pressScale={0.97} accessibilityLabel={`Photo from ${h.sender_name ?? 'a friend'} in ${hitChatName(h)}, ${shortDate(h.created_at)}. Open full screen`}>
      <View style={{ width: size, height: size, borderRadius: 14, overflow: 'hidden', backgroundColor: colors.bgTertiary, alignItems: 'center', justifyContent: 'center' }}>
        {url ? (
          <Image source={{ uri: url }} style={{ position: 'absolute', inset: 0 }} contentFit="cover" transition={150} accessibilityIgnoresInvertColors />
        ) : (
          <Icon name="image" size={22} color={error ? colors.textTertiary : colors.textSecondary} />
        )}
      </View>
    </Tap>
  );
}

function PersonTile({ p, onOpen }: { p: Person; onOpen: (p: Person) => void }) {
  const locked = !p.conversation_id && p.access === 'locked';
  return (
    <Tap
      onPress={() => onOpen(p)}
      accessibilityLabel={locked ? `${p.display_name}. Follow to message` : `${p.display_name}. Open chat`}
      accessibilityHint={locked ? 'Opens their profile. They only accept messages from people they follow.' : undefined}
      style={{ width: 60, alignItems: 'center', gap: 4 }}
    >
      <View>
        <Face id={p.id} name={p.display_name} uri={p.avatar_url} size={50} r={17} />
        {locked ? (
          <View style={{ position: 'absolute', right: -3, bottom: -3, width: 20, height: 20, borderRadius: 10, backgroundColor: colors.surface3, borderWidth: 2, borderColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="lock" size={11} color={colors.text} />
          </View>
        ) : null}
      </View>
      <T size={12} color={SOFT} numberOfLines={1}>
        {p.display_name.split(' ')[0]}
      </T>
    </Tap>
  );
}

type Result = { key: string; filter: Filter; hits: ChatSearchHit[]; people: Person[]; error: string | null };

export default function ChatSearch() {
  const { user } = useAuth();
  const me = user?.id;
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [focused, setFocused] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [inbox, setInbox] = useState<InboxRow[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [retry, setRetry] = useState(0);
  const [viewing, setViewing] = useState<number | null>(null);
  const q = useDebounced(query.trim(), 250);
  const key = `${filter}|${q}|${retry}`;

  // Chats for the PEOPLE row (recent 1:1 partners) and name matching.
  useEffect(() => {
    if (!me) return;
    let alive = true;
    loadInbox()
      .then((rows) => alive && setInbox(rows))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [me]);

  const recentPeople = useMemo(() => {
    const seen = new Set<string>();
    const out: Person[] = [];
    for (const r of inbox) {
      if (isGroupRow(r) || !r.other_id || r.blocked || r.request_state === 'outgoing' || seen.has(r.other_id)) continue;
      seen.add(r.other_id);
      out.push({ id: r.other_id, display_name: r.other_name ?? 'Listener', avatar_url: r.other_avatar, conversation_id: r.conversation_id });
    }
    return out;
  }, [inbox]);

  useEffect(() => {
    if (!me) return;
    let alive = true;
    const wantPeople = (filter === 'all' || filter === 'people') && !!q;
    const wantHits = filter !== 'people' && (!!q || filter !== 'all');
    const kind: ChatSearchKind = filter === 'people' ? 'all' : filter;
    void (async () => {
      try {
        const lim = filter === 'media' ? 60 : 50;
        const [serverHits, contacts] = await Promise.all([
          wantHits ? searchMyMessages(q, kind, lim) : Promise.resolve([]),
          wantPeople ? searchContacts(q).catch(() => []) : Promise.resolve([]),
        ]);
        // Server search can't read end-to-end encrypted messages: decrypt its e2ee hits and add matches
        // from this phone's decrypted cache.
        const known = inbox.map((r) => {
          const x = r as InboxRow & { kind?: string | null; title?: string | null; avatar_url?: string | null };
          return { id: r.conversation_id, kind: x.kind ?? (isGroupRow(r) ? 'group' : 'direct'), title: x.title ?? null, avatar_url: x.avatar_url ?? null, member_count: Number(r.member_count) || undefined, other_id: r.other_id, other_name: r.other_name, other_avatar: r.other_avatar };
        });
        const hits = wantHits ? await mergeEncryptedHits(q, kind, serverHits, me, known, lim) : serverHits;
        if (!alive) return;
        const lc = q.toLowerCase();
        const seen = new Set<string>();
        const people: Person[] = [];
        for (const p of recentPeople) {
          if (!lc || !p.display_name.toLowerCase().includes(lc) || seen.has(p.id)) continue;
          seen.add(p.id);
          people.push(p);
        }
        for (const c of contacts) {
          if (seen.has(c.id) || c.access === 'blocked') continue;
          seen.add(c.id);
          people.push({ id: c.id, display_name: c.display_name, avatar_url: c.avatar_url, conversation_id: c.conversation_id, access: c.access });
        }
        setResult({ key, filter, hits, people, error: null });
      } catch (e) {
        if (alive) setResult({ key, filter, hits: [], people: [], error: friendlySocialError(e, 'Could not search your chats') });
      }
    })();
    return () => {
      alive = false;
    };
  }, [me, key, filter, q, recentPeople, inbox]);

  // Locked (their settings only accept people they follow / mutual friends): don't throw an error — open
  // their profile, which offers "Follow to message" (MessagingFlow design: Locked → follow first).
  const openProfile = (p: Person) => router.push({ pathname: '/public-profile', params: { id: p.id } });
  const openPerson = async (p: Person) => {
    setNote(null);
    if (!p.conversation_id && p.access === 'locked') {
      openProfile(p);
      return;
    }
    try {
      const res = p.conversation_id ? { id: p.conversation_id, request: false } : await startChat(p.id);
      router.push({ pathname: '/chat-pro', params: { id: res.id, ...chatPeerParams(p) } });
      if (res.request) setNote(`Sent as a request. ${p.display_name.split(' ')[0]} can accept or decline.`);
    } catch (e) {
      if ((e as { hint?: string })?.hint === 'locked') {
        openProfile(p);
        return;
      }
      setNote(friendlySocialError(e, `Could not open a chat with ${p.display_name}`));
    }
  };

  // While a new search runs, the previous results for the same filter stay on screen.
  const current = result && result.key === key && query.trim() === q ? result : null;
  const display = result && result.filter === filter ? result : null;
  const loading = !!me && !current;
  const hits = display?.hits ?? [];
  const people = display?.people ?? [];
  const songs = filter === 'songs' ? hits : filter === 'all' ? hits.filter((h) => SONG_KINDS.has(h.kind) || !!h.track) : [];
  const messages = filter === 'all' ? hits.filter((h) => !songs.includes(h)) : [];
  const tile = Math.floor((width - 32 - 12) / 3);
  const photoHits = filter === 'media' ? hits.filter((h) => !!photoOf(h)) : [];
  const viewerPhotos: ViewerPhoto[] = photoHits.map((h) => {
    const ph = photoOf(h) as NonNullable<ReturnType<typeof photoOf>>;
    return { id: h.id, ...ph, senderName: h.sender_id === me ? 'You' : (h.sender_name ?? 'Someone'), at: h.created_at };
  });

  const idle = !q && (filter === 'all' || filter === 'people');
  const nothing =
    !!current &&
    !current.error &&
    !idle &&
    (filter === 'people' ? people.length === 0 : filter === 'all' ? people.length === 0 && hits.length === 0 : hits.length === 0);

  const emptyCopy: Record<Filter, string> = {
    all: 'No people, messages or songs match',
    people: 'No people match',
    songs: q ? 'No shared songs match' : 'No songs shared in your chats yet',
    voice: q ? 'No voice messages match' : 'No voice messages in your chats yet',
    media: q ? 'No photos match' : 'No photos in your chats yet',
    links: q ? 'No links match' : 'No links shared in your chats yet',
    polls: q ? 'No polls match' : 'No polls in your chats yet',
  };

  return (
    <Screen top={8} gap={14} bottom={28} backdrop={{ pattern: 'none', mesh: 'coral' }} stagger={false}>
      <Row gap={10}>
        <IconButton icon="back" label="Back" size={44} iconSize={20} bg={withAlpha(colors.white, 0.1)} href="back" />
        <Row
          gap={10}
          style={{
            flex: 1,
            height: 52,
            borderRadius: 26,
            paddingLeft: 18,
            paddingRight: 6,
            backgroundColor: FIELD_BG,
            borderWidth: 1.5,
            borderColor: focused ? colors.accent : FIELD_BORDER,
          }}
        >
          <Icon name="search" size={20} color={colors.text} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            autoFocus
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Search people and messages"
            placeholderTextColor={colors.textSecondary}
            selectionColor={colors.accent}
            cursorColor={colors.accent}
            accessibilityLabel="Search people and messages"
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            style={{ flex: 1, height: 48, color: colors.text, fontFamily: fonts.regular, fontSize: 16 }}
          />
          {query ? <IconButton icon="close" label="Clear search" size={40} iconSize={18} color={colors.textSecondary} onPress={() => setQuery('')} /> : null}
        </Row>
      </Row>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        accessibilityRole="tablist"
        accessibilityLabel="Search filters"
        style={{ marginHorizontal: -16, flexGrow: 0 }}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
      >
        {FILTERS.map((f) => (
          <Pill key={f.key} label={f.label} active={filter === f.key} onPress={() => setFilter(f.key)} />
        ))}
      </ScrollView>

      {note ? (
        <Tap onPress={() => setNote(null)} accessibilityLabel={`${note}. Dismiss`}>
          <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite">
            {note}
          </T>
        </Tap>
      ) : null}

      {idle ? (
        <>
          {recentPeople.length ? (
            <>
              <SectionLabel>RECENT</SectionLabel>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ marginHorizontal: -16, flexGrow: 0 }} contentContainerStyle={{ gap: 14, paddingHorizontal: 16 }}>
                {recentPeople.slice(0, 12).map((p) => (
                  <PersonTile key={p.id} p={p} onOpen={(x) => void openPerson(x)} />
                ))}
              </ScrollView>
            </>
          ) : null}
          <EmptyState
            icon="search"
            title={filter === 'people' ? 'Find someone to chat with' : 'Search your chats'}
            body={filter === 'people' ? 'Search by name or @username.' : 'Find people, messages, shared songs, voice notes, photos, links and polls.'}
          />
        </>
      ) : current?.error ? (
        <ErrorState message={current.error} onRetry={() => setRetry((n) => n + 1)} />
      ) : loading && (!display || display.error) ? (
        <Loading label="Searching" />
      ) : nothing ? (
        <EmptyState icon="search" title={emptyCopy[filter]} body={q ? `Nothing found for “${q}”.` : undefined} />
      ) : (
        <>
          {people.length ? (
            <>
              <SectionLabel>PEOPLE</SectionLabel>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ marginHorizontal: -16, flexGrow: 0 }} contentContainerStyle={{ gap: 14, paddingHorizontal: 16 }}>
                {people.map((p) => (
                  <PersonTile key={p.id} p={p} onOpen={(x) => void openPerson(x)} />
                ))}
              </ScrollView>
            </>
          ) : null}

          {messages.length ? (
            <>
              <SectionLabel>MESSAGES</SectionLabel>
              <View>
                {messages.map((h) => (
                  <MessageRow key={h.id} h={h} q={q} />
                ))}
              </View>
            </>
          ) : null}

          {songs.length ? (
            <>
              <SectionLabel>SHARED SONGS</SectionLabel>
              <View style={{ gap: 8 }}>
                {songs.map((h) => (
                  <SongRow key={h.id} h={h} q={q} />
                ))}
              </View>
            </>
          ) : null}

          {filter === 'voice' && hits.length ? (
            <>
              <SectionLabel>VOICE MESSAGES</SectionLabel>
              <View>
                {hits.map((h) => {
                  const media = h.meta.media && typeof h.meta.media === 'object' ? (h.meta.media as Record<string, unknown>) : null;
                  const ms = typeof h.meta.duration_ms === 'number' ? h.meta.duration_ms : typeof media?.duration_ms === 'number' ? media.duration_ms : 0;
                  const from = h.sender_id === me ? 'You' : (h.sender_name ?? 'Someone');
                  return <IconRow key={h.id} h={h} q={q} icon="mic" title={`Voice message · ${formatMs(ms)}`} sub={`${from}${h.is_group ? ` in ${hitChatName(h)}` : ''} · ${shortDate(h.created_at)}`} />;
                })}
              </View>
            </>
          ) : null}

          {filter === 'media' && hits.length ? (
            <>
              <SectionLabel>PHOTOS</SectionLabel>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {photoHits.map((h, i) => (
                  <PhotoTile key={h.id} h={h} size={tile} onOpen={() => setViewing(i)} />
                ))}
              </View>
            </>
          ) : null}

          {filter === 'links' && hits.length ? (
            <>
              <SectionLabel>LINKS</SectionLabel>
              <View>
                {hits.map((h) => {
                  const url = firstUrl(h.snippet);
                  return <IconRow key={h.id} h={h} q={q} icon="link" title={h.snippet} sub={`${url ? `${urlHost(url)} · ` : ''}${hitChatName(h)} · ${shortDate(h.created_at)}`} />;
                })}
              </View>
            </>
          ) : null}

          {filter === 'polls' && hits.length ? (
            <>
              <SectionLabel>POLLS</SectionLabel>
              <View>
                {hits.map((h) => {
                  const question = typeof h.meta.question === 'string' && h.meta.question ? h.meta.question : h.snippet;
                  const opts = Array.isArray(h.meta.options) ? h.meta.options.length : 0;
                  return <IconRow key={h.id} h={h} q={q} icon="chart" title={question} sub={`${opts ? `${opts} options · ` : ''}${hitChatName(h)} · ${shortDate(h.created_at)}`} />;
                })}
              </View>
            </>
          ) : null}
        </>
      )}
      <PhotoViewer
        photos={viewerPhotos}
        index={viewing}
        onClose={() => setViewing(null)}
        onIndexChange={setViewing}
        onReply={(p) => {
          const h = photoHits.find((x) => x.id === p.id);
          if (h) openHit(h, '');
        }}
      />
    </Screen>
  );
}
