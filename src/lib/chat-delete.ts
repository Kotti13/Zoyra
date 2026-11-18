import { chatBus, chatError } from './chat';
import { supabase } from './supabase';

/**
 * Clear chat (for me) and Unsend (delete for everyone).
 * Server side: supabase/migrations/20261115180000_chat_clear_unsend.sql.
 */

export type ClearStats = { messages: number; photos: number; voice: number; pinned: number };

/** Rough numbers for the Clear chat dialog (messages still visible to me, media, pins). */
export async function loadClearStats(cid: string, me: string): Promise<ClearStats> {
  const count = { count: 'exact' as const, head: true };
  const [all, hidden, photos, voice, pinned] = await Promise.all([
    supabase.from('messages').select('id', count).eq('conversation_id', cid),
    supabase.from('message_hidden').select('message_id, messages!inner(conversation_id)', count).eq('user_id', me).eq('messages.conversation_id', cid),
    supabase.from('messages').select('id', count).eq('conversation_id', cid).eq('kind', 'photo'),
    supabase.from('messages').select('id', count).eq('conversation_id', cid).eq('kind', 'voice'),
    supabase.from('message_pins').select('message_id', count).eq('conversation_id', cid),
  ]);
  for (const r of [all, hidden, photos, voice, pinned]) if (r.error) throw new Error(chatError(r.error));
  return {
    messages: Math.max(0, (all.count ?? 0) - (hidden.count ?? 0)),
    photos: photos.count ?? 0,
    voice: voice.count ?? 0,
    pinned: pinned.count ?? 0,
  };
}

/** Hides every current message in `cid` for me. Returns how many were hidden. */
export async function clearChat(cid: string, opts: { keepPinned?: boolean; keepMedia?: boolean } = {}): Promise<number> {
  const { data, error } = await supabase.rpc('clear_chat', { cid, keep_pinned: !!opts.keepPinned, keep_media: !!opts.keepMedia });
  if (error) throw new Error(chatError(error, 'Could not clear this chat'));
  chatBus.touch();
  return typeof data === 'number' ? data : 0;
}

/** Deletes one of my messages for everyone. Media files stay in storage but nothing points at them. */
export async function unsendMessage(mid: string): Promise<void> {
  const { error } = await supabase.rpc('unsend_message', { mid });
  if (error) throw new Error(chatError(error, 'Could not delete this message'));
  chatBus.touch();
}
