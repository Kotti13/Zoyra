/**
 * The last inbox the Messages screen showed, kept in memory so reopening it paints at once while a fresh copy
 * loads. Memory only, tied to one user, cleared at sign-out (see sign-out.ts).
 */
let last: { uid: string; rows: unknown[] } | null = null;

export function getInboxSnapshot<T>(uid: string | undefined): T[] | null {
  return uid && last && last.uid === uid ? (last.rows as T[]) : null;
}

export function setInboxSnapshot<T>(uid: string, rows: T[]): void {
  last = { uid, rows };
}

export function clearInboxSnapshot(): void {
  last = null;
}
