/**
 * Run mode: tempo-matched music, on-device run tracking and the `workouts` table.
 *
 * What is measured, and how:
 *   - Time: the session clock (pauses excluded).
 *   - Distance, pace and route: foreground GPS via expo-location (only while Run mode is open; no
 *     background tracking, so locking the phone into another app stops distance updates).
 *   - Steps and cadence: the motion co-processor via expo-sensors' Pedometer.
 *   - No heart rate or calories: there is no wearable integration, so we never show them.
 *
 * Tempo matching uses the BPM Audius reports per track (`bpm`, from its audio analysis). Running
 * cadence is usually 150–185 steps/min, so half-time songs (e.g. 84 BPM for a 168 cadence) count too.
 * Tracks without a BPM are never guessed: the mix falls back to energetic moods / genres and says so.
 */
import { Pedometer } from 'expo-sensors';
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';

import { catalog, type CatalogTrack } from './catalog';
import { supabase } from './supabase';

/* ------------------------------------------------------------------ tempo presets */

export type TempoPreset = { key: string; label: string; bpm: number | null; hint: string };

export const TEMPOS: TempoPreset[] = [
  { key: 'walk', label: 'Walk', bpm: 120, hint: 'Brisk walk · ~120 steps/min' },
  { key: 'jog', label: 'Easy jog', bpm: 150, hint: 'Easy jog · ~150 steps/min' },
  { key: 'run', label: 'Run', bpm: 165, hint: 'Steady run · ~165 steps/min' },
  { key: 'tempo', label: 'Tempo', bpm: 175, hint: 'Tempo run · ~175 steps/min' },
  { key: 'sprint', label: 'Sprint', bpm: 185, hint: 'Intervals · ~185 steps/min' },
  { key: 'any', label: 'Any tempo', bpm: null, hint: 'Play your music as it is' },
];

export const tempoByKey = (key: string | undefined) => TEMPOS.find((t) => t.key === key) ?? TEMPOS[2];

/* ------------------------------------------------------------------ BPM lookup (Audius) */

const AUDIUS = 'https://api.audius.co/v1';
const bpmCache = new Map<string, number | null>();

/** BPM per Audius track id (null = Audius has no BPM for it). Local files are skipped. */
export async function fetchBpms(ids: string[]): Promise<Map<string, number | null>> {
  const want = [...new Set(ids)].filter((id) => !id.startsWith('local:') && !bpmCache.has(id));
  for (let i = 0; i < want.length; i += 40) {
    const chunk = want.slice(i, i + 40);
    const qs = new URLSearchParams({ app_name: 'zoyra' });
    chunk.forEach((id) => qs.append('id', id));
    const res = await fetch(`${AUDIUS}/tracks?${qs.toString()}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Could not read track tempos (${res.status})`);
    const json = (await res.json()) as { data?: { id: string; bpm?: number | null }[] };
    const got = new Map((json.data ?? []).map((t) => [t.id, typeof t.bpm === 'number' && t.bpm > 0 ? t.bpm : null]));
    chunk.forEach((id) => bpmCache.set(id, got.get(id) ?? null));
  }
  const out = new Map<string, number | null>();
  ids.forEach((id) => out.set(id, bpmCache.get(id) ?? null));
  return out;
}

/** The track's BPM, or its half/double time, whichever is closest to the target cadence. */
export function effectiveBpm(bpm: number, target: number) {
  return [bpm, bpm * 2, bpm / 2].reduce((best, b) => (Math.abs(b - target) < Math.abs(best - target) ? b : best));
}

export type TempoQueue = {
  tracks: CatalogTrack[];
  bpms: Map<string, number | null>;
  /** 'bpm' = matched on real BPM; 'energy' = no BPM match, picked energetic moods / genres; 'order' = no tempo, kept as is. */
  matchedBy: 'bpm' | 'energy' | 'order';
  /** Tracks within ±TOLERANCE of the target. */
  matched: number;
};

const TOLERANCE = 7;
const ENERGY_MOODS = new Set(['Energizing', 'Upbeat', 'Excited', 'Empowering', 'Aggressive', 'Rowdy', 'Fiery', 'Stirring']);
const ENERGY_GENRES = ['Electronic', 'House', 'Hip-Hop/Rap', 'Techno', 'Drum & Bass', 'Pop'];

const dedupe = (list: CatalogTrack[]) => {
  const seen = new Set<string>();
  return list.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
};

/** Catalogue mix for a cadence: trending tracks whose real BPM (or half/double) is within ±7 of the target. */
export async function buildTempoMix(target: number | null, limit = 40): Promise<TempoQueue> {
  const lists = await Promise.all([
    catalog.trending({ time: 'week', limit: 100 }),
    catalog.trending({ time: 'month', limit: 100 }),
    catalog.trending({ time: 'allTime', limit: 100 }).catch(() => [] as CatalogTrack[]),
    catalog.underground(100).catch(() => [] as CatalogTrack[]),
  ]);
  const pool = dedupe(lists.flat());
  if (target === null) {
    const tracks = pool.filter((t) => t.mood && ENERGY_MOODS.has(t.mood)).slice(0, limit);
    return { tracks: tracks.length ? tracks : pool.slice(0, limit), bpms: new Map(), matchedBy: 'order', matched: 0 };
  }
  const bpms = await fetchBpms(pool.map((t) => t.id));
  const scored = pool
    .map((t) => {
      const b = bpms.get(t.id);
      return { t, d: b ? Math.abs(effectiveBpm(b, target) - target) : Infinity };
    })
    .filter((x) => x.d <= TOLERANCE)
    .sort((a, b) => a.d - b.d || b.t.plays - a.t.plays);
  if (scored.length >= 8) {
    return { tracks: scored.slice(0, limit).map((x) => x.t), bpms, matchedBy: 'bpm', matched: Math.min(scored.length, limit) };
  }
  // Not enough real BPM matches: fall back to energetic moods and genres, and say so in the UI.
  const byGenre = await Promise.all(ENERGY_GENRES.map((genre) => catalog.trending({ genre, time: 'month', limit: 30 }).catch(() => [] as CatalogTrack[])));
  const energetic = dedupe([...scored.map((x) => x.t), ...pool.filter((t) => t.mood && ENERGY_MOODS.has(t.mood)), ...byGenre.flat()]);
  return { tracks: energetic.slice(0, limit), bpms, matchedBy: 'energy', matched: scored.length };
}

/** Reorder the user's own tracks so the closest-tempo songs play first; tracks without a BPM go last, in their order. */
export async function orderByTempo(tracks: CatalogTrack[], target: number | null): Promise<TempoQueue> {
  if (target === null || !tracks.length) return { tracks, bpms: new Map(), matchedBy: 'order', matched: 0 };
  const bpms = await fetchBpms(tracks.map((t) => t.id)).catch(() => new Map<string, number | null>());
  const known: { t: CatalogTrack; d: number }[] = [];
  const unknown: CatalogTrack[] = [];
  for (const t of tracks) {
    const b = bpms.get(t.id);
    if (b) known.push({ t, d: Math.abs(effectiveBpm(b, target) - target) });
    else unknown.push(t);
  }
  known.sort((a, b) => a.d - b.d);
  const matched = known.filter((x) => x.d <= TOLERANCE).length;
  return { tracks: [...known.map((x) => x.t), ...unknown], bpms, matchedBy: known.length ? 'bpm' : 'energy', matched };
}

/** Tracks of one of the user's playlists (RLS limits this to playlists they can read). */
export async function playlistTracks(playlistId: string): Promise<CatalogTrack[]> {
  const { data, error } = await supabase.from('playlist_tracks').select('track').eq('playlist_id', playlistId).order('position', { ascending: true }).limit(300);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.track as CatalogTrack);
}

/* ------------------------------------------------------------------ geometry and formatting */

export type LatLng = [number, number];

export function haversine(a: LatLng, b: LatLng) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLng = (b[1] - a[1]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Keep at most `max` points (always keeps the first and last). */
export function downsample<T>(points: T[], max = 500): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
}

export const formatClock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

export const formatKm = (m: number) => (m / 1000).toFixed(m >= 100_000 ? 0 : 2);

/** Seconds per km → `5'12"`; `--` when unknown. */
export const formatPace = (secPerKm: number | null) => {
  if (!secPerKm || !Number.isFinite(secPerKm) || secPerKm > 3600) return '--';
  const m = Math.floor(secPerKm / 60);
  return `${m}'${String(Math.round(secPerKm % 60)).padStart(2, '0')}"`;
};

export const avgPace = (seconds: number, meters: number) => (meters >= 50 ? seconds / (meters / 1000) : null);

/* ------------------------------------------------------------------ workouts table */

export type Workout = {
  id: string;
  user_id: string;
  kind: 'run' | 'walk';
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  distance_m: number;
  steps: number | null;
  avg_cadence: number | null;
  target_bpm: number | null;
  tempo_label: string | null;
  playlist_id: string | null;
  playlist_title: string | null;
  route: LatLng[];
  tracks: CatalogTrack[];
  created_at: string;
};

export type NewWorkout = Omit<Workout, 'id' | 'user_id' | 'created_at'>;

export async function saveWorkout(userId: string, w: NewWorkout): Promise<string> {
  const row = {
    ...w,
    user_id: userId,
    route: downsample(w.route, 500).map(([lat, lng]) => [Number(lat.toFixed(6)), Number(lng.toFixed(6))]),
    tracks: w.tracks.filter((t) => !t.id.startsWith('local:')).slice(0, 100),
    tempo_label: w.tempo_label?.slice(0, 40) ?? null,
    playlist_title: w.playlist_title?.slice(0, 100) ?? null,
  };
  const { data, error } = await supabase.from('workouts').insert(row).select('id').single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

/** Recent runs without the heavy route / tracks columns. */
export type WorkoutSummaryRow = Pick<Workout, 'id' | 'kind' | 'started_at' | 'duration_seconds' | 'distance_m' | 'steps' | 'avg_cadence' | 'target_bpm' | 'tempo_label' | 'playlist_title'>;

export async function listWorkouts(userId: string, limit = 30): Promise<WorkoutSummaryRow[]> {
  const { data, error } = await supabase
    .from('workouts')
    .select('id, kind, started_at, duration_seconds, distance_m, steps, avg_cadence, target_bpm, tempo_label, playlist_title')
    .eq('user_id', userId)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as WorkoutSummaryRow[];
}

export async function getWorkout(id: string): Promise<Workout> {
  const { data, error } = await supabase.from('workouts').select('*').eq('id', id).single();
  if (error) throw new Error(error.message);
  return data as Workout;
}

export async function deleteWorkout(id: string) {
  const { error } = await supabase.from('workouts').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/** Totals for runs started in the last 7 days, and the current daily streak (consecutive days with a run, ending today or yesterday). */
export function weeklyStats(rows: WorkoutSummaryRow[], now = new Date()) {
  const since = now.getTime() - 7 * 864e5;
  const week = rows.filter((r) => new Date(r.started_at).getTime() >= since);
  const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const days = new Set(rows.map((r) => dayKey(new Date(r.started_at))));
  let streak = 0;
  const cursor = new Date(now);
  if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(dayKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return {
    runs: week.length,
    meters: week.reduce((s, r) => s + r.distance_m, 0),
    seconds: week.reduce((s, r) => s + r.duration_seconds, 0),
    streak,
  };
}

/* ------------------------------------------------------------------ live tracker */

export type SensorState = 'pending' | 'on' | 'denied' | 'unavailable';

export type RunStats = {
  elapsed: number;
  meters: number;
  steps: number;
  /** Steps per minute over the last 30 s (null until there is enough data). */
  cadence: number | null;
  /** Seconds per km over the last ~60 s of movement. */
  pace: number | null;
};

export type RunSnapshot = RunStats & { startedAt: Date; endedAt: Date; route: LatLng[]; avgCadence: number | null };

const ZERO: RunStats = { elapsed: 0, meters: 0, steps: 0, cadence: null, pace: null };

/** GPS fixes worse than this (metres) are ignored; jumps faster than 12 m/s are treated as glitches. */
const MAX_ACCURACY = 25;
const MAX_SPEED = 12;

/**
 * Foreground run tracker: session clock, GPS distance / pace / route, pedometer steps / cadence.
 * Call `start()` once; `pause()` / `resume()`; `finish()` stops every sensor and returns the totals.
 */
export function useRunTracker() {
  const [status, setStatus] = useState<'idle' | 'running' | 'paused' | 'finished'>('idle');
  const [gps, setGps] = useState<SensorState>('pending');
  const [pedometer, setPedometer] = useState<SensorState>('pending');
  const [stats, setStats] = useState<RunStats>(ZERO);

  const r = useRef({
    running: false,
    startedAt: null as Date | null,
    activeMs: 0,
    resumedAt: 0,
    meters: 0,
    route: [] as LatLng[],
    last: null as { p: LatLng; t: number } | null,
    distSamples: [] as { t: number; m: number }[],
    stepBase: 0,
    stepLive: 0,
    stepSamples: [] as { t: number; s: number }[],
    locSub: null as Location.LocationSubscription | null,
    pedoSub: null as { remove: () => void } | null,
  });

  const elapsedMs = useCallback(() => {
    const s = r.current;
    return s.activeMs + (s.running ? Date.now() - s.resumedAt : 0);
  }, []);

  const compute = useCallback((): RunStats => {
    const s = r.current;
    const now = Date.now();
    const steps = s.stepBase + s.stepLive;
    const stepWin = s.stepSamples.filter((x) => now - x.t <= 30_000);
    let cadence: number | null = null;
    if (stepWin.length >= 2) {
      const span = (stepWin[stepWin.length - 1].t - stepWin[0].t) / 60_000;
      if (span >= 10 / 60) cadence = Math.round((stepWin[stepWin.length - 1].s - stepWin[0].s) / span);
    }
    const distWin = s.distSamples.filter((x) => now - x.t <= 60_000);
    let pace: number | null = null;
    if (distWin.length >= 2) {
      const dm = distWin[distWin.length - 1].m - distWin[0].m;
      const dt = (distWin[distWin.length - 1].t - distWin[0].t) / 1000;
      if (dm >= 20 && dt > 0) pace = dt / (dm / 1000);
    }
    return { elapsed: elapsedMs() / 1000, meters: s.meters, steps, cadence, pace };
  }, [elapsedMs]);

  const subscribePedometer = useCallback(() => {
    const s = r.current;
    s.stepLive = 0;
    s.pedoSub = Pedometer.watchStepCount(({ steps }) => {
      s.stepLive = steps;
      s.stepSamples.push({ t: Date.now(), s: s.stepBase + steps });
      if (s.stepSamples.length > 200) s.stepSamples.splice(0, s.stepSamples.length - 200);
    });
  }, []);

  const onFix = useCallback((loc: Location.LocationObject) => {
    const s = r.current;
    if (!s.running) return;
    const { latitude, longitude, accuracy } = loc.coords;
    if (accuracy !== null && accuracy > MAX_ACCURACY) return;
    const p: LatLng = [latitude, longitude];
    const t = loc.timestamp || Date.now();
    if (s.last) {
      const d = haversine(s.last.p, p);
      const dt = Math.max(0.5, (t - s.last.t) / 1000);
      if (d / dt > MAX_SPEED) return; // GPS jump
      s.meters += d;
    }
    s.last = { p, t };
    s.route.push(p);
    s.distSamples.push({ t: Date.now(), m: s.meters });
    if (s.distSamples.length > 200) s.distSamples.splice(0, s.distSamples.length - 200);
  }, []);

  /** Ask for permissions, start the sensors and the clock. Never throws: a missing sensor just reports its state. */
  const start = useCallback(async () => {
    const s = r.current;
    if (s.startedAt) return;
    s.startedAt = new Date();
    s.resumedAt = Date.now();
    s.running = true;
    setStatus('running');

    // Pedometer (steps / cadence).
    try {
      if (!(await Pedometer.isAvailableAsync())) setPedometer('unavailable');
      else {
        const perm = await Pedometer.requestPermissionsAsync();
        if (!perm.granted) setPedometer('denied');
        else {
          if (s.running) subscribePedometer();
          setPedometer('on');
        }
      }
    } catch {
      setPedometer('unavailable');
    }

    // Foreground GPS (distance / pace / route).
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) setGps('denied');
      else if (!(await Location.hasServicesEnabledAsync())) setGps('unavailable');
      else {
        s.locSub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 2000, distanceInterval: 5 },
          onFix,
          () => setGps('unavailable'),
        );
        setGps('on');
      }
    } catch {
      setGps('unavailable');
    }
  }, [onFix, subscribePedometer]);

  const pause = useCallback(() => {
    const s = r.current;
    if (!s.running) return;
    s.activeMs += Date.now() - s.resumedAt;
    s.running = false;
    s.last = null; // don't count the distance covered while paused
    s.stepBase += s.stepLive;
    s.stepLive = 0;
    s.pedoSub?.remove();
    s.pedoSub = null;
    s.stepSamples = [];
    s.distSamples = [];
    setStats(compute());
    setStatus('paused');
  }, [compute]);

  const resume = useCallback(() => {
    const s = r.current;
    if (s.running || !s.startedAt) return;
    s.running = true;
    s.resumedAt = Date.now();
    if (pedometer === 'on') subscribePedometer();
    setStatus('running');
  }, [pedometer, subscribePedometer]);

  const stopSensors = useCallback(() => {
    const s = r.current;
    s.pedoSub?.remove();
    s.pedoSub = null;
    s.locSub?.remove();
    s.locSub = null;
  }, []);

  const finish = useCallback((): RunSnapshot => {
    const s = r.current;
    if (s.running) {
      s.activeMs += Date.now() - s.resumedAt;
      s.running = false;
    }
    s.stepBase += s.stepLive;
    s.stepLive = 0;
    stopSensors();
    const totals = compute();
    setStats(totals);
    setStatus('finished');
    const minutes = totals.elapsed / 60;
    return {
      ...totals,
      startedAt: s.startedAt ?? new Date(),
      endedAt: new Date(),
      route: [...s.route],
      avgCadence: s.stepBase > 0 && minutes >= 1 ? Math.round(s.stepBase / minutes) : null,
    };
  }, [compute, stopSensors]);

  // 1 s UI tick while running.
  useEffect(() => {
    if (status !== 'running') return;
    const id = setInterval(() => setStats(compute()), 1000);
    return () => clearInterval(id);
  }, [status, compute]);

  // Release sensors if the screen unmounts mid-run.
  useEffect(() => stopSensors, [stopSensors]);

  return { status, gps, pedometer, stats, start, pause, resume, finish };
}
