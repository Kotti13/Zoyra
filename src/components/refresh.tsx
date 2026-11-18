import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Platform, RefreshControl, type RefreshControlProps } from 'react-native';

import { colors } from '../theme/tokens';

/** Keep the spinner up at least this long so a fast reload doesn't flash it. */
const MIN_SPIN_MS = 400;
/** Never leave the spinner up longer than this (a reload that never settles, or an unmounted loader). */
const MAX_SPIN_MS = 15000;

/**
 * Pull-to-refresh state. `fn` starts the screen's reloads (return a promise — e.g.
 * `Promise.all([a.reload(), b.reload()])` — and the spinner stays until it settles, min 400 ms).
 * A `void` return just shows the spinner for the minimum time.
 */
export function useRefresh(fn: () => Promise<unknown> | void) {
  const [refreshing, setRefreshing] = useState(false);
  const fnRef = useRef(fn);
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    fnRef.current = fn;
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const onRefresh = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    setRefreshing(true);
    const started = Date.now();
    let work: Promise<unknown>;
    try {
      work = Promise.resolve(fnRef.current());
    } catch {
      work = Promise.resolve();
    }
    const cap = new Promise((resolve) => setTimeout(resolve, MAX_SPIN_MS));
    void Promise.race([work.catch(() => undefined), cap]).then(() => {
      const wait = Math.max(0, MIN_SPIN_MS - (Date.now() - started));
      setTimeout(() => {
        busy.current = false;
        if (alive.current) setRefreshing(false);
      }, wait);
    });
  }, []);

  return { refreshing, onRefresh };
}

/** RefreshControl in the app theme (accent spinner on a dark disc). Pass to `refreshControl` of any ScrollView / FlatList / SectionList. */
export function ThemedRefreshControl(props: RefreshControlProps) {
  return (
    <RefreshControl
      tintColor={colors.accent}
      colors={[colors.accent]}
      progressBackgroundColor={colors.bgTertiary}
      {...(Platform.OS === 'ios' && props.title ? { titleColor: colors.textSecondary } : null)}
      {...props}
    />
  );
}

/* ------------------------------------------------------------------ refresh group */

type RefreshFn = () => Promise<unknown> | void;
type RefreshRegistry = { register: (fn: RefreshFn) => () => void; run: () => Promise<unknown> };

const RefreshGroupContext = createContext<RefreshRegistry | null>(null);

/**
 * For screens whose data lives in child components: the screen creates a group, passes `group.run`
 * to `Screen onRefresh` and wraps its body in `<group.Provider>`; each child calls
 * `useRefreshWith(() => x.refresh())`. A pull then runs every registered child refresh in parallel.
 */
export function useRefreshGroup() {
  const [registry] = useState<RefreshRegistry>(() => {
    const fns = new Set<RefreshFn>();
    return {
      register: (fn) => {
        fns.add(fn);
        return () => {
          fns.delete(fn);
        };
      },
      run: () => Promise.all([...fns].map((fn) => fn())),
    };
  });
  return { run: registry.run, value: registry, Provider: RefreshGroupContext.Provider };
}

/** Register this component's reload with the nearest refresh group (no-op outside one). */
export function useRefreshWith(fn: RefreshFn) {
  const group = useContext(RefreshGroupContext);
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => group?.register(() => ref.current()), [group]);
}
