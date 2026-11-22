/**
 * Last line of defence against the app closing on an error nothing caught (a failed request inside a button
 * handler, a promise nobody awaited, a throw in a callback). In release builds React Native treats these as
 * fatal and the app quits. Here they are logged and shown as a short message instead, so a backend or network
 * failure never takes the app down.
 *
 * Errors while a screen is drawing are handled by the route error screen (`ErrorBoundary` in app/_layout.tsx),
 * and native crashes (outside JavaScript) are not covered by this.
 * In development the normal red box is kept so real bugs stay visible.
 */
import { reportError } from './crash-reporting';
import { flash } from './flash';

type GlobalWithHandlers = {
  ErrorUtils?: {
    getGlobalHandler?: () => ((e: unknown, isFatal?: boolean) => void) | undefined;
    setGlobalHandler?: (h: (e: unknown, isFatal?: boolean) => void) => void;
  };
  HermesInternal?: {
    enablePromiseRejectionTracker?: (opts: { allRejections: boolean; onUnhandled?: (id: number, error: unknown) => void }) => void;
  };
};

const NETWORK = /network|fetch|timeout|timed out|abort|unreachable|Zoyra API|failed to connect|ECONN|ENOTFOUND/i;

function friendly(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return NETWORK.test(msg) ? 'Can’t reach the service. Check your connection and try again.' : 'Something went wrong. Please try again.';
}

let lastShown = 0;
function report(error: unknown) {
  const now = Date.now();
  if (now - lastShown < 4000) return; // one message at a time, not a flood
  lastShown = now;
  try {
    flash(friendly(error));
  } catch {
    // Showing the message must never throw.
  }
}

let installed = false;
export function installErrorGuard() {
  if (installed || __DEV__) return;
  installed = true;
  const g = globalThis as unknown as GlobalWithHandlers;
  try {
    g.ErrorUtils?.setGlobalHandler?.((error, isFatal) => {
      console.error('[error-guard]', isFatal ? 'fatal' : 'error', error);
      reportError(error, isFatal ? 'fatal' : 'uncaught');
      report(error);
    });
  } catch {
    // Keep the default handler if it can't be replaced.
  }
  try {
    g.HermesInternal?.enablePromiseRejectionTracker?.({
      allRejections: true,
      onUnhandled: (_id, error) => {
        console.warn('[error-guard] unhandled promise rejection', error);
        reportError(error, 'unhandled-rejection');
        report(error);
      },
    });
  } catch {
    // Not available on this engine.
  }
}
