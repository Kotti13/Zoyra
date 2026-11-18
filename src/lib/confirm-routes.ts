import type { Href } from 'expo-router';

/**
 * Hrefs for the confirm dialogs. Register `confirm-block`, `confirm-clear` and `confirm-unsend` as
 * transparentModal overlays; `blocked-done` is a regular full screen.
 */

type Person = { id: string; display_name?: string | null; avatar_url?: string | null };

/** `/confirm-block?uid=&name=&avatar=&cid=`: block (and optionally report) someone. */
export function confirmBlockHref(person: Person, cid?: string | null): Href {
  const params: Record<string, string> = { uid: person.id };
  if (person.display_name) params.name = person.display_name;
  if (person.avatar_url) params.avatar = person.avatar_url;
  if (cid) params.cid = cid;
  return { pathname: '/confirm-block', params };
}

/** `/confirm-clear?cid=&name=[&group=1]`: clear a chat for me (`name` = the other person, or the group title). */
export function confirmClearHref(cid: string, name?: string | null, opts?: { group?: boolean }): Href {
  const params: Record<string, string> = { cid };
  if (name) params.name = name;
  if (opts?.group) params.group = '1';
  return { pathname: '/confirm-clear', params };
}

/** `/confirm-unsend?mid=&cid=[&group=1]`: delete one of my messages for everyone (or for me). */
export function confirmUnsendHref(mid: string, cid: string, opts?: { group?: boolean }): Href {
  return { pathname: '/confirm-unsend', params: opts?.group ? { mid, cid, group: '1' } : { mid, cid } };
}

/** `/blocked-done?uid=&name=`: shown after a block. */
export function blockedDoneHref(uid: string, name?: string | null, extra?: { avatar?: string | null; reportFailed?: boolean }): Href {
  const params: Record<string, string> = { uid };
  if (name) params.name = name;
  if (extra?.avatar) params.avatar = extra.avatar;
  if (extra?.reportFailed) params.report = 'failed';
  return { pathname: '/blocked-done', params };
}
