/**
 * Network status, a real speed test, and "slow / back online" signals.
 *
 * - Connection details come from NetInfo.
 * - The speed test downloads a fixed number of bytes from a real catalogue stream (Audius) with an
 *   HTTP Range request and times it. Ping is the median time-to-response of tiny Range requests to
 *   the same CDN host; jitter is the mean change between consecutive pings. Upload is NOT measured.
 * - Audius serves every stream as a fixed 320 kbps MP3, so the "recommended quality" is only a
 *   verdict on whether that stream will play smoothly; there is no lower bitrate to switch to.
 *
 * The last result is kept in AsyncStorage on this device.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo, { useNetInfo, type NetInfoState } from '@react-native-community/netinfo';
import { router } from 'expo-router';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { catalog } from './catalog';
import { usePref } from './prefs';
import { STREAM_KBPS } from './usage';
import { isOnlineStable, subscribeOnline } from './connectivity';

/* ------------------------------------------------------------------ connection details */

export type ConnectionInfo = {
  /** null while NetInfo has not answered yet. */
  known: boolean;
  online: boolean;
  type: NetInfoState['type'];
  /** "Wi-Fi", "Mobile data · 4G", "Ethernet", "No connection"… */
  label: string;
  /** 0..4 bars when the platform reports signal strength (Android Wi-Fi), else null. */
  bars: number | null;
  /** "Strong signal", "Weak signal", "Internet not reachable"… */
  detail: string;
  generation: '2g' | '3g' | '4g' | '5g' | null;
  carrier: string | null;
  ssid: string | null;
  /** Wi-Fi link speed in Mbps (Android only). */
  linkSpeedMbps: number | null;
  frequencyMhz: number | null;
  ipAddress: string | null;
  expensive: boolean | null;
};

const TYPE_LABEL: Record<NetInfoState['type'], string> = {
  wifi: 'Wi-Fi',
  cellular: 'Mobile data',
  ethernet: 'Ethernet',
  bluetooth: 'Bluetooth',
  wimax: 'WiMAX',
  vpn: 'VPN',
  other: 'Other network',
  none: 'No connection',
  unknown: 'Checking connection',
};

export function describeConnection(s: NetInfoState): ConnectionInfo {
  const known = s.isConnected !== null;
  const online = s.isConnected === true && s.isInternetReachable !== false;
  const base: ConnectionInfo = {
    known,
    online,
    type: s.type,
    label: TYPE_LABEL[s.type],
    bars: null,
    detail: !known ? 'Checking…' : !s.isConnected ? 'Not connected' : s.isInternetReachable === false ? 'Internet not reachable' : 'Connected',
    generation: null,
    carrier: null,
    ssid: null,
    linkSpeedMbps: null,
    frequencyMhz: null,
    ipAddress: null,
    expensive: s.details && 'isConnectionExpensive' in s.details ? s.details.isConnectionExpensive : null,
  };
  if (s.type === 'wifi' && s.details) {
    const d = s.details;
    const strength = d.strength;
    const bars = strength == null ? null : strength >= 75 ? 4 : strength >= 50 ? 3 : strength >= 25 ? 2 : 1;
    return {
      ...base,
      bars,
      detail: online && bars != null ? (bars >= 3 ? 'Strong signal' : bars === 2 ? 'Fair signal' : 'Weak signal') : base.detail,
      ssid: d.ssid,
      linkSpeedMbps: d.linkSpeed ?? d.rxLinkSpeed ?? null,
      frequencyMhz: d.frequency,
      ipAddress: d.ipAddress,
    };
  }
  if (s.type === 'cellular' && s.details) {
    const g = s.details.cellularGeneration;
    return {
      ...base,
      label: g ? `Mobile data · ${g.toUpperCase()}` : 'Mobile data',
      generation: g,
      carrier: s.details.carrier,
      bars: g === '2g' ? 1 : g === '3g' ? 2 : g === '4g' ? 3 : g === '5g' ? 4 : null,
    };
  }
  if (s.type === 'ethernet' && s.details) return { ...base, ipAddress: s.details.ipAddress };
  return base;
}

/** Live connection details (re-renders on every NetInfo change). */
export function useConnection(): ConnectionInfo {
  return describeConnection(useNetInfo());
}

/* ------------------------------------------------------------------ speed test */

export type SpeedResult = {
  /** Download throughput in Mbit/s. */
  mbps: number;
  pingMs: number;
  jitterMs: number;
  /** Bytes actually received in the timed download. */
  bytes: number;
  /** ISO time the test finished. */
  at: string;
  /** Connection type during the test. */
  connection: NetInfoState['type'];
};

export type SpeedPhase = 'idle' | 'preparing' | 'ping' | 'download' | 'done' | 'error';
export type SpeedSnapshot = {
  ready: boolean;
  phase: SpeedPhase;
  /** 0..1 during the download phase. */
  progress: number;
  /** Mbps measured so far (live gauge). */
  liveMbps: number | null;
  last: SpeedResult | null;
  error: string | null;
};

const SPEED_KEY = 'zoyra.speedtest.v1';
const SMALL_BYTES = 512 * 1024;
const LARGE_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const PINGS = 5;

let speed: SpeedSnapshot = { ready: false, phase: 'idle', progress: 0, liveMbps: null, last: null, error: null };
const speedListeners = new Set<() => void>();
let speedInit: Promise<void> | null = null;
let running: AbortController | null = null;

function setSpeed(patch: Partial<SpeedSnapshot>) {
  speed = { ...speed, ...patch };
  speedListeners.forEach((l) => l());
}

function loadSpeed() {
  if (!speedInit)
    speedInit = AsyncStorage.getItem(SPEED_KEY)
      .then((raw) => setSpeed({ ready: true, last: raw ? (JSON.parse(raw) as SpeedResult) : speed.last }))
      .catch(() => setSpeed({ ready: true }));
  return speedInit;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * One timed GET with a Range header. `readBody: false` (pings) stops right after the headers, so a
 * server that ignores Range can't make a ping download a whole file.
 */
async function timed(url: string, range: string, signal: AbortSignal, readBody = true) {
  const local = new AbortController();
  const forward = () => local.abort();
  signal.addEventListener('abort', forward);
  try {
    const t0 = now();
    const res = await fetch(url, { headers: { Range: range }, signal: local.signal });
    if (!res.ok) throw new Error(`The test server answered ${res.status}`);
    const t1 = now();
    if (!readBody) {
      local.abort();
      return { res, ttfb: t1 - t0, total: t1 - t0, bytes: 0 };
    }
    const body = await res.arrayBuffer();
    return { res, ttfb: t1 - t0, total: now() - t0, bytes: body.byteLength };
  } finally {
    signal.removeEventListener('abort', forward);
  }
}

/** Picks a long, streamable track so the Range never runs past the end of the file. */
async function testUrl() {
  const tracks = await catalog.trending({ limit: 10 });
  // 320 kbps → 40 KB per second; need LARGE_BYTES + margin.
  const t = tracks.find((x) => x.duration >= LARGE_BYTES / 40_000 + 30) ?? tracks[0];
  if (!t) throw new Error('No test file is available right now');
  return catalog.streamUrl(t.id);
}

export const speedTest = {
  subscribe(l: () => void) {
    void loadSpeed();
    speedListeners.add(l);
    return () => {
      speedListeners.delete(l);
    };
  },
  getSnapshot: (): SpeedSnapshot => speed,

  cancel() {
    running?.abort();
  },

  /** Runs ping + download. Resolves with the result (also stored as `last`). */
  async run(): Promise<SpeedResult> {
    await loadSpeed();
    running?.abort();
    const ctrl = new AbortController();
    running = ctrl;
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    setSpeed({ phase: 'preparing', progress: 0, liveMbps: null, error: null });
    try {
      const net = await NetInfo.fetch();
      if (net.isConnected === false || net.isInternetReachable === false) throw new Error('You are offline');

      // Resolve the redirect to the CDN once, so pings and the download hit the same host.
      const first = await timed(await testUrl(), 'bytes=0-0', ctrl.signal, false);
      const cdn = first.res.url || (await testUrl());

      setSpeed({ phase: 'ping' });
      const pings: number[] = [];
      for (let i = 0; i < PINGS; i++) pings.push((await timed(cdn, 'bytes=0-0', ctrl.signal, false)).ttfb);
      const sorted = [...pings].sort((a, b) => a - b);
      const pingMs = sorted[Math.floor(sorted.length / 2)];
      const jitterMs = pings.slice(1).reduce((n, p, i) => n + Math.abs(p - pings[i]), 0) / Math.max(1, pings.length - 1);

      setSpeed({ phase: 'download', progress: 0.1 });
      // Small probe first; if it was quick, time a larger file for a steadier number.
      const probe = await timed(cdn, `bytes=0-${SMALL_BYTES - 1}`, ctrl.signal);
      const probeMbps = (probe.bytes * 8) / (Math.max(1, probe.total) / 1000) / 1e6;
      setSpeed({ progress: 0.35, liveMbps: probeMbps });
      let best = { bytes: probe.bytes, ms: probe.total };
      if (probe.total < 1500) {
        const big = await timed(cdn, `bytes=${SMALL_BYTES}-${SMALL_BYTES + LARGE_BYTES - 1}`, ctrl.signal);
        best = { bytes: big.bytes, ms: big.total };
      }
      const mbps = (best.bytes * 8) / (Math.max(1, best.ms) / 1000) / 1e6;
      const result: SpeedResult = {
        mbps: Math.round(mbps * 10) / 10,
        pingMs: Math.round(pingMs),
        jitterMs: Math.round(jitterMs),
        bytes: best.bytes,
        at: new Date().toISOString(),
        connection: net.type,
      };
      setSpeed({ phase: 'done', progress: 1, liveMbps: result.mbps, last: result });
      AsyncStorage.setItem(SPEED_KEY, JSON.stringify(result)).catch(() => undefined);
      return result;
    } catch (e) {
      const message = ctrl.signal.aborted ? 'The test timed out or was cancelled' : e instanceof Error ? e.message : 'Speed test failed';
      setSpeed({ phase: 'error', error: message, progress: 0 });
      throw new Error(message);
    } finally {
      clearTimeout(timer);
      if (running === ctrl) running = null;
    }
  },
};

export function useSpeedTest(): SpeedSnapshot {
  return useSyncExternalStore(speedTest.subscribe, speedTest.getSnapshot, speedTest.getSnapshot);
}

/* ------------------------------------------------------------------ what the speed supports */

export type QualityTier = { key: 'low' | 'normal' | 'high' | 'lossless'; label: string; kbps: number; detail: string };

/** Nominal tiers for the "what your speed supports" list. Only `high` (the 320 kbps stream) exists in the catalogue. */
export const TIERS: QualityTier[] = [
  { key: 'low', label: 'Low', kbps: 96, detail: '96 kbps' },
  { key: 'normal', label: 'Normal', kbps: 160, detail: '160 kbps' },
  { key: 'high', label: 'High', kbps: STREAM_KBPS, detail: `${STREAM_KBPS} kbps` },
  { key: 'lossless', label: 'Lossless', kbps: 1411, detail: 'FLAC / ALAC' },
];

/** A tier plays smoothly when throughput is at least 2× its bitrate (headroom for buffering). */
export const supports = (mbps: number, kbps: number) => mbps * 1000 >= kbps * 2;

/** Honest verdict for the catalogue's fixed 320 kbps stream. */
export function streamVerdict(r: Pick<SpeedResult, 'mbps' | 'pingMs'>): { ok: boolean; text: string } {
  if (supports(r.mbps, STREAM_KBPS) && r.pingMs < 600) return { ok: true, text: `Fast enough for the ${STREAM_KBPS} kbps stream every song uses.` };
  if (r.mbps * 1000 >= STREAM_KBPS) return { ok: false, text: `Just enough for ${STREAM_KBPS} kbps. Songs may pause to buffer; downloads play without data.` };
  return { ok: false, text: `Slower than the ${STREAM_KBPS} kbps stream needs. Expect buffering; play downloads instead.` };
}

/* ------------------------------------------------------------------ slow / back online signals */

/** A speed test older than this, or from another connection type, no longer counts. */
const RESULT_TTL_MS = 30 * 60_000;
const SLOW_PING_MS = 600;

export type Slowness = { slow: boolean; reason: string | null };

/** Slow = a 2G/3G cellular generation, or a recent speed test on this connection type with high RTT or too little throughput. */
export function slowness(s: NetInfoState, last: SpeedResult | null): Slowness {
  if (s.isConnected !== true) return { slow: false, reason: null };
  if (s.type === 'cellular' && s.details && (s.details.cellularGeneration === '2g' || s.details.cellularGeneration === '3g'))
    return { slow: true, reason: `${s.details.cellularGeneration.toUpperCase()} network` };
  if (last && last.connection === s.type && Date.now() - Date.parse(last.at) < RESULT_TTL_MS) {
    if (last.pingMs >= SLOW_PING_MS) return { slow: true, reason: `High latency (${last.pingMs} ms)` };
    if (!supports(last.mbps, STREAM_KBPS)) return { slow: true, reason: `Low speed (${last.mbps} Mbps)` };
  }
  return { slow: false, reason: null };
}

/** Live "is this connection slow?" (NetInfo + last speed test). */
export function useSlowness(): Slowness {
  const net = useNetInfo();
  const { last } = useSpeedTest();
  return slowness(net, last);
}

/** When the device last went offline / came back (module memory, this app session only). */
let offlineSince: number | null = null;
let lastOutage: { from: number; to: number } | null = null;
export const lastOutageInfo = () => lastOutage;

export type NetworkEvent = 'slow' | 'backOnline';

/**
 * Calls `onEvent` when the connection turns slow (once per slow spell) or comes back after being
 * offline. Mount once near the root (inside the router).
 */
export function useNetworkEvents(onEvent: (e: NetworkEvent) => void) {
  const cb = useRef(onEvent);
  useEffect(() => {
    cb.current = onEvent;
  }, [onEvent]);
  useEffect(() => {
    let wasOnline: boolean | null = null;
    let wasSlow = false;
    const check = (s: NetInfoState) => {
      if (s.isConnected === null) return;
      // Debounced online status (see connectivity.ts) so a failed reachability probe isn't an outage.
      const online = isOnlineStable();
      if (wasOnline === true && !online) offlineSince = Date.now();
      if (wasOnline === false && online) {
        lastOutage = { from: offlineSince ?? Date.now(), to: Date.now() };
        offlineSince = null;
        cb.current('backOnline');
      }
      wasOnline = online;
      const slow = online && slowness(s, speed.last).slow;
      if (slow && !wasSlow) cb.current('slow');
      wasSlow = slow;
    };
    const unsub = NetInfo.addEventListener(check);
    // Re-evaluate when the stable status flips (it can lag NetInfo by the confirm delay).
    const unsubStable = subscribeOnline(() => {
      NetInfo.fetch().then(check).catch(() => undefined);
    });
    return () => {
      unsub();
      unsubStable();
    };
  }, []);
}

/** Device pref (shown on Connection and data) that turns the slow / back-online screens on or off. */
export const NETWORK_ALERTS_PREF = 'networkAlerts';

/**
 * Ready-made routing: slow → /slow-net sheet, back online → /back-online.
 * Honours the "Connection alerts" toggle (on by default). Pass `enabled = false` while signed out.
 */
const lastShown: Partial<Record<NetworkEvent, number>> = {};

export function useNetworkRouting(enabled = true) {
  useNetworkEvents((e) => {
    if (!enabled) return;
    AsyncStorage.getItem(`zoyra.pref.${NETWORK_ALERTS_PREF}`)
      .then((raw) => raw !== 'false')
      .catch(() => true)
      .then((on) => {
        if (!on) return;
        // At most one alert of each kind per 10 minutes, so a wobbly connection can't keep popping sheets.
        const now = Date.now();
        if (now - (lastShown[e] ?? 0) < 10 * 60 * 1000) return;
        lastShown[e] = now;
        router.push(e === 'slow' ? '/slow-net' : '/back-online');
      });
  });
}

/* ------------------------------------------------------------------ device prefs */

/**
 * Device-only preference under `zoyra.pref.<key>` (same keys as Data and storage). Backed by the
 * shared `prefs.ts` store, so a change on one screen shows up live everywhere.
 */
export function useDevicePref<V>(key: string, fallback: V) {
  return usePref<V>(key, fallback);
}

/* ------------------------------------------------------------------ formatting */

export const formatMbps = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

export function formatAgo(iso: string | number) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}
