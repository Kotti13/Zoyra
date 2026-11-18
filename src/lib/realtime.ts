/**
 * Private (RLS-authorised) Realtime channels.
 *
 * `privateChannel(topic, opts)` = `supabase.channel(topic, { config: { private: true, ...opts } })`, plus:
 *   - the socket carries the signed-in user's access token before the channel joins (Realtime evaluates the
 *     `realtime.messages` policies with it), and again after every token refresh;
 *   - `subscribe()` waits for that token, and is skipped if the channel was removed meanwhile.
 *
 * Topics and who may use them (policies: supabase/migrations/20261115280000_security_hardening.sql):
 *   chatpro:<conversation id>   1:1 chat typing / in-chat presence      members, and not blocked (direct chats)
 *   group:<conversation id>     group chat typing / presence             members of the group
 *   call-listen:<call id>       listening together during a call        caller + callee
 *   presence:<user id>          that user's online status                read: the user, or anyone the user is in
 *                                                                        presence_allowed() for (both sides with
 *                                                                        Online status on); track: only the user
 *   room:<room id>              listening room presence / broadcast      room members + host
 * postgres_changes subscriptions keep using table RLS; they don't need a topic policy.
 *
 * Broadcast payloads are still client-authored: receivers must not trust ids inside them. Prefer the presence
 * key (server-checked on private channels: only the topic owner may track on presence:<uid>) or re-read rows.
 */
import type { RealtimeChannel, RealtimeChannelOptions } from '@supabase/supabase-js';

import { supabase } from './supabase';

type ChannelConfig = RealtimeChannelOptions['config'];

let authed: Promise<void> | null = null;
let lastToken: string | null = null;

async function applyToken(token: string | null | undefined): Promise<void> {
  const t = token ?? null;
  if (t === lastToken) return;
  lastToken = t;
  try {
    await supabase.realtime.setAuth(t);
  } catch {
    // offline: the next refresh / join retries
  }
}

/** Resolves once Realtime holds the current session's access token (and keeps it updated afterwards). */
export function realtimeAuthReady(): Promise<void> {
  if (!authed) {
    supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') void applyToken(null);
      else if (session?.access_token) void applyToken(session.access_token);
    });
    authed = supabase.auth
      .getSession()
      .then(({ data }) => applyToken(data.session?.access_token))
      .catch(() => undefined);
  }
  return authed;
}

/**
 * A private channel on `topic`. Use it exactly like `supabase.channel()` (bind `.on(...)`, then
 * `.subscribe()`, remove with `supabase.removeChannel()`).
 */
export function privateChannel(topic: string, opts: Omit<ChannelConfig, 'private'> = {}): RealtimeChannel {
  const ch = supabase.channel(topic, { config: { ...opts, private: true } });
  const subscribe = ch.subscribe.bind(ch);
  ch.subscribe = ((...args: Parameters<RealtimeChannel['subscribe']>) => {
    void realtimeAuthReady().then(() => {
      // Removed before the token was ready: don't resurrect it.
      if (!supabase.getChannels().includes(ch)) return;
      subscribe(...args);
    });
    return ch;
  }) as RealtimeChannel['subscribe'];
  return ch;
}

/**
 * One live channel per topic across screen instances.
 *
 * supabase.channel(topic) returns the existing channel when one with that topic is open, and a subscribed
 * channel can't take new `.on()` callbacks ("cannot add `postgres_changes` callbacks … after `subscribe()`").
 * When the same screen is opened twice (e.g. chat → Forever → "Say hello" → the same chat, or a push tap while
 * that chat is open), the newer instance claims the topic: the older one releases its channel first and gets it
 * back (resume) when the newer one closes. Private topics can't be suffixed (topic RLS), so this hand-over is how
 * both instances stay safe.
 */
export type TopicHolder = { release: () => Promise<unknown>; resume: () => void };
const topicHolders = new Map<string, TopicHolder[]>();
const topicSettling = new Map<string, Promise<unknown>>();

/** Take `topic` for `holder`; resolves once any previous holder's channel is fully removed. */
export async function claimTopic(topic: string, holder: TopicHolder): Promise<void> {
  const stack = topicHolders.get(topic) ?? [];
  const prev = stack[stack.length - 1];
  stack.push(holder);
  topicHolders.set(topic, stack);
  if (prev) await prev.release().catch(() => undefined);
  await topicSettling.get(topic)?.catch(() => undefined);
  if (prev) purgeTopic(topic);
}

/** A leave that timed out can leave the old channel in the client's list; drop it so channel() makes a new one. */
function purgeTopic(topic: string): void {
  const rt = supabase.realtime as unknown as { _remove?: (c: RealtimeChannel) => void };
  for (const c of supabase.getChannels()) {
    if (c.topic !== `realtime:${topic}`) continue;
    c.teardown();
    rt._remove?.(c);
  }
}

/** Give `topic` up. `removal` = this holder's own removeChannel; the holder below resumes once it settles. */
export function dropTopic(topic: string, holder: TopicHolder, removal: Promise<unknown>): void {
  const stack = topicHolders.get(topic) ?? [];
  const i = stack.indexOf(holder);
  const wasTop = i >= 0 && i === stack.length - 1;
  if (i >= 0) stack.splice(i, 1);
  if (!stack.length) topicHolders.delete(topic);
  const settled = removal.catch(() => undefined);
  topicSettling.set(topic, settled);
  if (wasTop && stack.length)
    void settled.then(() => {
      purgeTopic(topic);
      stack[stack.length - 1]?.resume();
    });
}
