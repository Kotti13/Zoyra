import { router } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import { MiniPlayer, TabBar, type TabKey } from '../../components';

const keys: TabKey[] = ['home', 'search', 'library', 'profile'];

/**
 * 'fade' is an opacity-only cross-fade driven by the native animation driver in js-tabs, so it never
 * waits on the JS thread. It replaced 'shift' (opacity + 50 px translateX), which re-rasterized the
 * whole scene every frame and stuttered on the heavier tabs. Revert to 'shift' if you prefer the slide.
 * Options are a module constant so the navigator never sees new screenOptions between renders.
 */
const screenOptions = { headerShown: false, sceneStyle: { backgroundColor: 'transparent' }, animation: 'fade' } as const;

/** Tabs that are mounted in the background once Home has settled, so a first tap shows a ready screen. */
const PRELOAD = ['/search', '/library', '/profile'] as const;

type TabBarProps = { state: { index: number; routes: { key: string }[] }; navigateToTab: (routeKey: string) => void };

/**
 * Floating mini player + pill tab bar. Chrome itself is trivial and re-renders with the navigator; its
 * children are memoized: the tab bar only re-renders when the active tab changes, and the mini player
 * only on track / play / buffering changes (never per position tick).
 */
function Chrome({ index, routes, navigateToTab }: { index: number; routes: { key: string }[]; navigateToTab: (routeKey: string) => void }) {
  // navigateToTab / routes are new objects on every navigator render; read the latest through a ref so
  // onSelect keeps one identity and TabBar's memo holds.
  const latest = useRef({ routes, navigateToTab });
  useLayoutEffect(() => {
    latest.current = { routes, navigateToTab };
  });
  const onSelect = useCallback((k: TabKey) => {
    const { routes: r, navigateToTab: go } = latest.current;
    const key = r[keys.indexOf(k)]?.key;
    if (key) go(key);
  }, []);
  return (
    <View style={styles.chrome} pointerEvents="box-none">
      <MiniPlayer />
      <TabBar active={keys[index] ?? 'home'} onSelect={onSelect} />
    </View>
  );
}

function renderTabBar({ state, navigateToTab }: TabBarProps) {
  return <Chrome index={state.index} routes={state.routes} navigateToTab={navigateToTab} />;
}

/**
 * Warm the other tabs one at a time while the app is idle (after Home's own first load), so the
 * first visit to Search / Library / Profile no longer mounts a whole screen during the tap.
 * Visited tabs stay mounted (js-tabs never unmounts them); hidden tabs pause their decorative loops.
 */
function usePreloadTabs() {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idle: number | undefined;
    const step = (i: number) => {
      if (cancelled || i >= PRELOAD.length) return;
      const run = () => {
        if (cancelled) return;
        try {
          router.prefetch(PRELOAD[i]);
        } catch {
          // navigator not ready (e.g. signed-out redirect in flight): skip, the tab still mounts on tap
        }
        timer = setTimeout(() => step(i + 1), 900);
      };
      if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(run, { timeout: 2000 });
      else run();
    };
    timer = setTimeout(() => step(0), 2500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (idle !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
    };
  }, []);
}

/** Tab roots share a floating mini player + pill tab bar drawn over the content. */
export default function TabsLayout() {
  usePreloadTabs();
  return (
    <Tabs screenOptions={screenOptions} tabBar={renderTabBar}>
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="search" options={{ title: 'Search' }} />
      <Tabs.Screen name="library" options={{ title: 'Library' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  chrome: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
