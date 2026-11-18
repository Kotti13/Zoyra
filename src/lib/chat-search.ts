/**
 * Chat search (Chat search design): wrapper over `search_my_messages` from
 * supabase/migrations/20261115240000_chat_search.sql — keep names and shapes in sync.
 */
import { decryptChatRows, MSG_SELECT, type ChatMessage } from './chat';
import { decryptErrorOf } from './chat-e2ee';
import { searchDecrypted } from './e2ee';
import { supabase } from './supabase';

/** Server-side filters. 'people' is answered client side (contacts + inbox), never sent to the RPC. */
export type ChatSearchKind = 'all' | 'songs' | 'voice' | 'media' | 'links' | 'polls';

export type ChatSearchHit = {
  id: string;
  conversation_id: string;
  kind: string;
  /** Text around the first match (text messages) or a one-line preview (songs, polls, voice…). */
  snippet: string;
  track: Record<string, unknown> | null;
  meta: Record<string, unknown>;
  created_at: string;
  sender_id: string;
  sender_name: string | null;
  sender_avatar: string | null;
  /** Group chats: their title / picture when the group chats migration is applied. */
  conversation_title: string | null;
  conversation_avatar: string | null;
  /** 1:1 chats: the other person (null for groups). */
  other_id: string | null;
  other_name: string | null;
  other_avatar: string | null;
  is_group: boolean;
  member_count: number;
};

export async function searchMyMessages(q: string, kind: ChatSearchKind = 'all', lim = 50): Promise<ChatSearchHit[]> {
  const { data, error } = await supabase.rpc('search_my_messages', { q: q.trim(), kind_filter: kind, lim });
  if (error) throw error;
  return (data ?? []) as ChatSearchHit[];
}

/** Splits `text` into plain / matched parts (case-insensitive, literal `q`) for highlighting. */
export function highlightParts(text: string, q: string): { text: string; hit: boolean }[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [{ text, hit: false }];
  const hay = text.toLowerCase();
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  while (at < text.length) {
    const i = hay.indexOf(needle, at);
    if (i < 0) break;
    if (i > at) out.push({ text: text.slice(at, i), hit: false });
    out.push({ text: text.slice(i, i + needle.length), hit: true });
    at = i + needle.length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"']+)/i;

/** First URL in a message body (null when none). */
export function firstUrl(body: string | null | undefined): string | null {
  const m = body ? URL_RE.exec(body) : null;
  if (!m) return null;
  return m[1].replace(/[.,;:!?)\]]+$/, '');
}

/** Display host of a URL ("example.com"). */
export function urlHost(url: string): string {
  const m = /^(?:https?:\/\/)?([^/?#]+)/i.exec(url);
  return (m?.[1] ?? url).replace(/^www\./i, '');
}

/** Chat name for a hit: group title, else the other person, else the sender. */
export function hitChatName(h: ChatSearchHit): string {
  if (h.is_group) return h.conversation_title ?? 'Group chat';
  return h.other_name ?? h.sender_name ?? 'Listener';
}

/* ------------------------------------------------------------------ end-to-end encrypted messages */

type ConvInfo = { id: string; kind: string | null; title: string | null; avatar_url: string | null; member_count?: number; other_id?: string | null; other_name?: string | null; other_avatar?: string | null };
type Row = { id: string; conversation_id: string; sender_id: string; kind: string; body: string; track: Record<string, unknown> | null; meta: Record<string, unknown>; created_at: string };

/** Text around the first match (≈ 110 characters). */
function snippetOf(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.trim().toLowerCase());
  if (i < 0 || text.length <= 110) return text.slice(0, 110);
  const start = Math.max(0, i - 40);
  return `${start > 0 ? '…' : ''}${text.slice(start, start + 110)}${start + 110 < text.length ? '…' : ''}`;
}

function wantsKind(kind: ChatSearchKind, r: Row): boolean {
  switch (kind) {
    case 'songs':
      return r.kind === 'track' || r.kind === 'lyric' || (r.kind === 'text' && !!r.track);
    case 'voice':
      return r.kind === 'voice';
    case 'media':
      return r.kind === 'photo';
    case 'links':
      return !!firstUrl(r.body);
    case 'polls':
      return r.kind === 'poll';
    default:
      return true;
  }
}

function previewOf(r: Row, q: string): string {
  if (r.body) return snippetOf(r.body, q);
  if (r.kind === 'poll' && typeof r.meta.question === 'string') return r.meta.question;
  const t = r.track as { title?: unknown; artist?: unknown } | null;
  if (t && typeof t.title === 'string') return t.title;
  if (r.kind === 'voice') return 'Voice message';
  if (r.kind === 'photo') return 'Photo';
  return 'Message';
}

/**
 * Merges end-to-end encrypted messages into server search results. The server can't read e2ee rows: its
 * hits for them (media / voice / polls / songs filters) carry no text, and text matches are missing
 * entirely. So (1) server hits that are e2ee rows are decrypted and filled in, and (2) matches from this
 * phone's decrypted cache (`searchDecrypted`) are added, deduped by message id. Hidden / cleared / unsent
 * messages are dropped. Never throws (returns the server hits on any failure).
 */
export async function mergeEncryptedHits(q: string, kind: ChatSearchKind, serverHits: ChatSearchHit[], me: string, known: ConvInfo[] = [], lim = 50): Promise<ChatSearchHit[]> {
  try {
    const encryptedServer = serverHits.filter((h) => h.meta && 'e2ee' in h.meta);
    const local = q.trim() ? await searchDecrypted(q, { limit: 200 }).catch(() => []) : [];
    const have = new Set(serverHits.map((h) => h.id));
    const localIds = local.map((l) => l.id).filter((id) => !have.has(id));
    const ids = [...new Set([...encryptedServer.map((h) => h.id), ...localIds])];
    if (!ids.length) return serverHits;

    const rows: Row[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await supabase.from('messages').select(MSG_SELECT).in('id', ids.slice(i, i + 100));
      if (error) throw error;
      rows.push(...(await decryptChatRows((data ?? []) as unknown as ChatMessage[])).map((m) => m as unknown as Row));
    }
    const hidden = new Set<string>();
    {
      const { data } = await supabase.from('message_hidden').select('message_id').eq('user_id', me).in('message_id', ids);
      for (const h of (data ?? []) as { message_id: string }[]) hidden.add(h.message_id);
    }
    const byId = new Map(rows.filter((r) => !hidden.has(r.id) && !decryptErrorOf(r)).map((r) => [r.id, r]));

    // (1) fill in server hits for e2ee rows.
    const filled: ChatSearchHit[] = [];
    for (const h of serverHits) {
      if (!(h.meta && 'e2ee' in h.meta)) {
        filled.push(h);
        continue;
      }
      const r = byId.get(h.id);
      if (!r) continue;
      filled.push({ ...h, snippet: previewOf(r, q), track: r.track, meta: r.meta });
    }

    // (2) local matches not in the server results.
    const extra = localIds.map((id) => byId.get(id)).filter((r): r is Row => !!r && wantsKind(kind, r));
    if (extra.length) {
      const convIds = [...new Set(extra.map((r) => r.conversation_id))];
      const conv = new Map(known.map((c) => [c.id, c]));
      const missing = convIds.filter((c) => !conv.has(c));
      if (missing.length) {
        const { data } = await supabase.from('conversations').select('id, kind, title, avatar_url').in('id', missing);
        for (const c of (data ?? []) as ConvInfo[]) conv.set(c.id, c);
      }
      // 1:1 partners not in the inbox, and every sender name.
      const people = new Map<string, { display_name: string | null; avatar_url: string | null }>();
      const needOther = convIds.filter((c) => conv.get(c)?.kind !== 'group' && !conv.get(c)?.other_id);
      if (needOther.length) {
        const { data } = await supabase.from('conversation_members').select('conversation_id, user_id').in('conversation_id', needOther).neq('user_id', me);
        for (const m of (data ?? []) as { conversation_id: string; user_id: string }[]) {
          const c = conv.get(m.conversation_id);
          if (c) conv.set(c.id, { ...c, other_id: m.user_id });
        }
      }
      const personIds = [...new Set([...extra.map((r) => r.sender_id), ...convIds.map((c) => conv.get(c)?.other_id).filter((x): x is string => !!x)])];
      if (personIds.length) {
        const { data } = await supabase.from('profiles').select('id, display_name, avatar_url').in('id', personIds);
        for (const p of (data ?? []) as { id: string; display_name: string | null; avatar_url: string | null }[]) people.set(p.id, p);
      }
      for (const r of extra) {
        const c = conv.get(r.conversation_id);
        const isGroup = c?.kind === 'group';
        const other = c?.other_id ?? null;
        const sender = people.get(r.sender_id);
        filled.push({
          id: r.id,
          conversation_id: r.conversation_id,
          kind: r.kind,
          snippet: previewOf(r, q),
          track: r.track,
          meta: r.meta,
          created_at: r.created_at,
          sender_id: r.sender_id,
          sender_name: sender?.display_name ?? null,
          sender_avatar: sender?.avatar_url ?? null,
          conversation_title: c?.title ?? null,
          conversation_avatar: c?.avatar_url ?? null,
          other_id: isGroup ? null : other,
          other_name: isGroup ? null : (c?.other_name ?? (other ? (people.get(other)?.display_name ?? null) : null)),
          other_avatar: isGroup ? null : (c?.other_avatar ?? (other ? (people.get(other)?.avatar_url ?? null) : null)),
          is_group: isGroup,
          member_count: c?.member_count ?? (isGroup ? 3 : 2),
        });
      }
    }
    return filled.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, Math.max(lim, serverHits.length));
  } catch {
    return serverHits;
  }
}
