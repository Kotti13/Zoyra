import { Alert, Platform } from 'react-native';

import type { IconName } from '../components/icons';

/**
 * App-wide in-app dialogs (confirmations and alerts) with the same glass look as Confirm clear /
 * Confirm block. Call `showDialog` / `confirmDialog` / `alertDialog` from anywhere; `<DialogHost />`
 * (src/components/DialogHost.tsx, mounted once in the root layout) renders them one at a time.
 * Dependency-light so libs can import it without cycles.
 */

export type DialogActionStyle = 'destructive' | 'primary' | 'cancel' | 'default';
export type DialogAction = { label: string; style?: DialogActionStyle };
export type DialogTone = 'danger' | 'default' | 'success';
export type DialogFact = { icon: IconName; text: string };

export type DialogOptions = {
  title: string;
  message?: string;
  /** Optional round icon above the title, tinted by `tone`. */
  icon?: IconName;
  tone?: DialogTone;
  /** Optional bulleted facts (icon + sentence), like the Confirm block dialog. */
  facts?: DialogFact[];
  actions: DialogAction[];
};

export type DialogRequest = DialogOptions & { id: number };

type Pending = DialogRequest & { resolve: (value: string | null) => void; settled: boolean };
type Listener = (current: DialogRequest | null) => void;

let queue: Pending[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

const emit = () => {
  const current = queue[0] ?? null;
  listeners.forEach((l) => l(current));
};

/** Used by `<DialogHost />`: receives the dialog to show (or null). Returns an unsubscribe. */
export function subscribeDialogs(l: Listener): () => void {
  listeners.add(l);
  l(queue[0] ?? null);
  return () => {
    listeners.delete(l);
  };
}

/**
 * Used by `<DialogHost />`: resolves a dialog with the pressed action's label (null = dismissed).
 * The promise resolves first and the dialog leaves the queue a tick later, so a follow-up dialog
 * opened by the caller replaces this one without the modal closing in between.
 */
export function settleDialog(id: number, value: string | null) {
  const req = queue.find((r) => r.id === id);
  if (!req || req.settled) return;
  req.settled = true;
  req.resolve(value);
  setTimeout(() => {
    queue = queue.filter((r) => r.id !== id);
    emit();
  }, 0);
}

/** Native fallback when no host is mounted (e.g. very early in startup). */
function fallback(opts: DialogOptions): Promise<string | null> {
  const text = opts.message ? `${opts.title}\n\n${opts.message}` : opts.title;
  if (Platform.OS === 'web') {
    const g = globalThis as { confirm?: (m: string) => boolean; alert?: (m: string) => void };
    const main = opts.actions.find((a) => a.style !== 'cancel');
    const cancel = opts.actions.find((a) => a.style === 'cancel');
    if (!cancel || !g.confirm) {
      g.alert?.(text);
      return Promise.resolve(main?.label ?? opts.actions[0]?.label ?? null);
    }
    return Promise.resolve(g.confirm(text) ? (main?.label ?? null) : cancel.label);
  }
  return new Promise((resolve) =>
    Alert.alert(
      opts.title,
      opts.message,
      opts.actions.map((a) => ({
        text: a.label,
        style: a.style === 'destructive' ? 'destructive' : a.style === 'cancel' ? 'cancel' : 'default',
        onPress: () => resolve(a.label),
      })),
      { cancelable: true, onDismiss: () => resolve(null) },
    ),
  );
}

/** Shows an in-app dialog. Resolves with the pressed action's label, or null when dismissed (backdrop / Android back). */
export function showDialog(opts: DialogOptions): Promise<string | null> {
  if (listeners.size === 0) return fallback(opts);
  return new Promise((resolve) => {
    queue = [...queue, { ...opts, id: nextId++, resolve, settled: false }];
    if (queue.length === 1) emit();
  });
}

/** Cancel + one action. Resolves true only when the action is pressed. */
export async function confirmDialog(title: string, message: string, actionLabel: string, destructive = true): Promise<boolean> {
  const res = await showDialog({
    title,
    message,
    tone: destructive ? 'danger' : 'default',
    actions: [
      { label: 'Cancel', style: 'cancel' },
      { label: actionLabel, style: destructive ? 'destructive' : 'primary' },
    ],
  });
  return res === actionLabel;
}

/** A single-button notice. Resolves when closed. */
export async function alertDialog(title: string, message: string, okLabel = 'OK'): Promise<void> {
  await showDialog({ title, message, actions: [{ label: okLabel, style: 'primary' }] });
}
