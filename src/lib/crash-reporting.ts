/**
 * Crash reporting (Sentry), off until a DSN is set: put the project's DSN in EXPO_PUBLIC_SENTRY_DSN. With no DSN
 * nothing is loaded and nothing is sent, and in development nothing is sent either.
 *
 * Privacy: no user identity, IP, screenshots or performance data are attached, and the query string of every
 * recorded web request (where the app's key travels) is removed before an event leaves the phone.
 * Native crashes and readable stack traces need the Sentry Expo plugin plus an auth token at build time (see
 * https://docs.sentry.io/platforms/react-native/manual-setup/expo/); JavaScript errors are reported without it.
 */
const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN ?? '';

type SentryModule = {
  init: (options: Record<string, unknown>) => void;
  captureException: (error: unknown, hint?: Record<string, unknown>) => string;
};
let sentry: SentryModule | null = null;

type Crumb = { category?: string; data?: Record<string, unknown> };
/** Drop the query string from a recorded request URL (`?key=…` carries the backend key). */
const cleanUrl = (u: unknown) => (typeof u === 'string' ? u.split('?')[0] : u);

export function initCrashReporting() {
  if (!DSN || sentry) return;
  try {
    // Loaded only when a DSN is set, so a build without one never touches the native module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const S = require('@sentry/react-native') as SentryModule;
    S.init({
      dsn: DSN,
      enabled: !__DEV__,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      attachScreenshot: false,
      beforeSend: (event: { user?: unknown; request?: { url?: unknown; headers?: unknown; cookies?: unknown } }) => {
        delete event.user;
        if (event.request) {
          event.request.url = cleanUrl(event.request.url);
          delete event.request.headers;
          delete event.request.cookies;
        }
        return event;
      },
      beforeBreadcrumb: (crumb: Crumb) => {
        if (crumb.data && typeof crumb.data.url === 'string') crumb.data = { ...crumb.data, url: cleanUrl(crumb.data.url) };
        return crumb;
      },
    });
    sentry = S;
  } catch (e) {
    console.warn('[crash-reporting] could not start', e);
  }
}

/** Send an error to the crash reporter (no-op when it is off). Never throws. */
export function reportError(error: unknown, where?: string) {
  if (!sentry) return;
  try {
    sentry.captureException(error, where ? { tags: { where } } : undefined);
  } catch {
    // Reporting must never cause a second failure.
  }
}
