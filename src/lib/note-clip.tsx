/**
 * "Choose 30 seconds" clip picker for a note's song (Instagram music notes), used in note-compose.
 * A horizontal strip spanning the whole song with a draggable 30-second window (PanResponder + Animated;
 * tap elsewhere on the strip to jump the window there). Start snaps to whole seconds in [0, duration − 30].
 * Play previews exactly that window in the notes preview player (src/lib/note-preview.ts).
 * Look (MsgNoteCompose): accent-outlined window with white drag handles over the bars, bars inside the window
 * bright, and "0:42 to 1:12 · drag to pick" between the song's start and end times.
 * Accessibility: −5s / +5s buttons, and the strip is an `adjustable` control (swipe up / down = ±5s).
 * The waveform is decorative: pseudo-random bars seeded by the track id (no real waveform data).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, View, type AccessibilityActionEvent, type LayoutChangeEvent } from 'react-native';

import { Button, Icon, Row, T, Tap } from '../components';
import { formatDuration } from './catalog';
import { clipKey, clipLenFor, defaultClipStart, maxClipStart, type NotePreview } from './note-preview';
import type { NoteTrack } from './notes';
import { colors, withAlpha } from '../theme/tokens';

const BARS = 56;
const STRIP_H = 64;
const MIN_WINDOW = 44;
const STEP = 5;
/** White pill drag handle on each edge of the window. */
const handle = { position: 'absolute', top: '50%', marginTop: -14, width: 12, height: 28, borderRadius: 10, backgroundColor: colors.white } as const;

/** Stable pseudo-random bar heights (0.2..1) for a track id. */
function barsFor(id: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  let a = h >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: BARS }, (_, i) => {
    const envelope = 0.55 + 0.45 * Math.sin((i / BARS) * Math.PI); // quieter intro / outro
    return Math.max(0.2, Math.min(1, envelope * (0.35 + rnd() * 0.65)));
  });
}

export function ClipPicker({
  track,
  preview,
  onChange,
  onDone,
}: {
  track: NoteTrack;
  preview: NotePreview;
  /** Every settled change (whole seconds). */
  onChange: (start: number, len: number) => void;
  /** Shows a Done button (collapsible pickers). */
  onDone?: () => void;
}) {
  // Song length: the catalog's, else the loaded file's once the preview has played it.
  const previewingThis = !!preview.activeKey?.startsWith(`${track.id}@`);
  const duration = track.duration && track.duration > 0 ? track.duration : previewingThis ? preview.duration : 0;
  const len = clipLenFor(duration);
  const maxStart = maxClipStart(duration);
  const [rawStart, setStart] = useState(() => track.clip_start ?? defaultClipStart(duration));
  const start = Math.min(rawStart, maxStart);
  const [width, setWidth] = useState(0);
  const bars = useMemo(() => barsFor(track.id), [track.id]);

  const winW = duration > 0 ? Math.min(width, Math.max(MIN_WINDOW, (len / duration) * width)) : width;
  const travel = Math.max(0, width - winW);
  const xOf = (s: number) => (maxStart > 0 ? (s / maxStart) * travel : 0);

  const [x] = useState(() => new Animated.Value(0));
  /** Latest geometry / callbacks for the PanResponder (created once). */
  const live = useRef({ travel, maxStart, winW, start, len, dragging: false, grantX: 0, lastX: 0, commit: (_s: number) => {}, scrub: setStart });

  const active = preview.activeKey === clipKey(track.id, start);
  const playing = active && preview.playing;

  const commit = (s: number) => {
    const next = Math.max(0, Math.min(maxStart, Math.round(s)));
    setStart(next);
    onChange(next, len);
    // Moving the window while it plays restarts the preview at the new spot.
    if (previewingThis && preview.playing) preview.start(track, next, len);
  };

  useEffect(() => {
    live.current.travel = travel;
    live.current.maxStart = maxStart;
    live.current.winW = winW;
    live.current.start = start;
    live.current.len = len;
    live.current.commit = commit;
    if (!live.current.dragging) x.setValue(xOf(start));
  });

  // The ref is only read inside the gesture callbacks (never while rendering); the compiler rule can't tell.
  // eslint-disable-next-line react-hooks/refs
  const [pan] = useState(() => {
    const toStart = (px: number) => {
      const g = live.current;
      return g.travel > 0 ? (px / g.travel) * g.maxStart : 0;
    };
    const clampX = (px: number) => Math.max(0, Math.min(live.current.travel, px));
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        const g = live.current;
        g.dragging = true;
        const cur = g.maxStart > 0 ? (g.start / g.maxStart) * g.travel : 0;
        const tx = e.nativeEvent.locationX;
        // Touch on the window: drag it. Elsewhere: centre the window on the touch.
        g.grantX = tx >= cur && tx <= cur + g.winW ? cur : clampX(tx - g.winW / 2);
        g.lastX = g.grantX;
        x.setValue(g.grantX);
        g.scrub(Math.round(toStart(g.grantX)));
      },
      onPanResponderMove: (_e, gs) => {
        const g = live.current;
        const nx = clampX(g.grantX + gs.dx);
        g.lastX = nx;
        x.setValue(nx);
        const s = Math.round(toStart(nx));
        if (s !== g.start) g.scrub(s);
      },
      onPanResponderRelease: () => {
        const g = live.current;
        g.dragging = false;
        g.commit(toStart(g.lastX));
      },
      onPanResponderTerminate: () => {
        const g = live.current;
        g.dragging = false;
        g.commit(toStart(g.lastX));
      },
    });
  });

  const end = duration > 0 ? Math.min(duration, start + len) : start + len;
  const range = `${formatDuration(start)} – ${formatDuration(end)}`;
  const nudge = (d: number) => commit(start + d);
  const onA11y = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'increment') nudge(STEP);
    else if (e.nativeEvent.actionName === 'decrement') nudge(-STEP);
  };

  if (duration <= 0) {
    return (
      <View style={{ gap: 12 }}>
        <T size={15} weight={600} accessibilityRole="header">
          Choose 30 seconds
        </T>
        <T size={13} color={colors.textSecondary}>
          This song’s length isn’t known yet. Play it once to choose a part, or keep the first 30 seconds.
        </T>
        <Row gap={8}>
          <Tap
            onPress={() => preview.toggle(track, start, len)}
            accessibilityLabel={playing ? 'Stop preview' : 'Play the clip'}
            style={{ minHeight: 44, paddingHorizontal: 16, borderRadius: 22, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.text }}
          >
            <Icon name={playing ? 'pause' : 'play'} size={16} color={colors.onLight} filled />
            <T size={14} weight={700} color={colors.onLight}>
              {playing ? 'Stop' : 'Play'}
            </T>
          </Tap>
          <View style={{ flex: 1 }} />
          {onDone ? <Button label="Done" height={44} onPress={onDone} /> : null}
        </Row>
      </View>
    );
  }

  // Bars inside the window are drawn bright (approximation from the settled start).
  const inWin = (i: number) => {
    const t = ((i + 0.5) / BARS) * duration;
    return t >= start && t <= end;
  };

  return (
    <View style={{ gap: 10 }}>

      <View
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        {...(maxStart > 0 ? pan.panHandlers : null)}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Clip position"
        accessibilityHint={maxStart > 0 ? 'Swipe up or down to move the clip 5 seconds' : undefined}
        accessibilityValue={{ min: 0, max: maxStart, now: start, text: `${formatDuration(start)} to ${formatDuration(end)} of ${formatDuration(duration)}` }}
        accessibilityActions={maxStart > 0 ? [{ name: 'increment', label: 'Later' }, { name: 'decrement', label: 'Earlier' }] : []}
        onAccessibilityAction={onA11y}
        style={{ height: STRIP_H, justifyContent: 'center', borderRadius: 18, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: colors.glassBorder }}
      >
        <View pointerEvents="none" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: STRIP_H - 20, paddingHorizontal: 10 }}>
          {bars.map((h, i) => (
            <View key={i} style={{ width: 2.5, height: `${Math.round(h * 100)}%`, borderRadius: 2, backgroundColor: withAlpha(colors.white, inWin(i) ? 0.9 : 0.3) }} />
          ))}
        </View>
        {width > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: winW,
              borderRadius: 18,
              borderWidth: 2,
              borderColor: colors.accent,
              backgroundColor: withAlpha(colors.accent, 0.14),
              transform: [{ translateX: x }],
            }}
          >
            {active ? <View style={{ position: 'absolute', top: 2, bottom: 2, left: `${Math.round(preview.progress * 1000) / 10}%`, width: 2, backgroundColor: colors.white }} /> : null}
            <View style={[handle, { left: -7 }]} />
            <View style={[handle, { right: -7 }]} />
          </Animated.View>
        ) : null}
      </View>

      <Row gap={8} style={{ justifyContent: 'space-between' }}>
        <T size={12} color={colors.textSecondary} style={{ fontVariant: ['tabular-nums'] }} accessibilityElementsHidden importantForAccessibility="no">
          0:00
        </T>
        <T size={12} weight={600} color={colors.text} numberOfLines={1} style={{ flexShrink: 1, fontVariant: ['tabular-nums'] }} accessibilityLabel={`Clip ${formatDuration(start)} to ${formatDuration(end)}`}>
          {len < 30 ? `Whole song · ${formatDuration(start)} to ${formatDuration(end)}` : `${formatDuration(start)} to ${formatDuration(end)}${maxStart > 0 ? ' · drag to pick' : ''}`}
        </T>
        <T size={12} color={colors.textSecondary} style={{ fontVariant: ['tabular-nums'] }} accessibilityElementsHidden importantForAccessibility="no">
          {formatDuration(duration)}
        </T>
      </Row>

      <Row gap={8}>
        <Tap
          onPress={() => nudge(-STEP)}
          disabled={start <= 0}
          accessibilityLabel="5 seconds earlier"
          style={{ minWidth: 56, minHeight: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: withAlpha(colors.white, 0.1), opacity: start <= 0 ? 0.4 : 1 }}
        >
          <T size={13} weight={600}>
            −5s
          </T>
        </Tap>
        <Tap
          onPress={() => preview.toggle(track, start, len)}
          accessibilityLabel={playing ? 'Stop preview' : `Play ${range}`}
          accessibilityState={{ busy: active && preview.loading }}
          style={{ minHeight: 44, paddingHorizontal: 16, borderRadius: 22, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.text }}
        >
          <Icon name={playing ? 'pause' : 'play'} size={16} color={colors.onLight} filled />
          <T size={14} weight={700} color={colors.onLight}>
            {active ? (preview.loading ? '…' : `${preview.remaining}s`) : 'Play'}
          </T>
        </Tap>
        <Tap
          onPress={() => nudge(STEP)}
          disabled={start >= maxStart}
          accessibilityLabel="5 seconds later"
          style={{ minWidth: 56, minHeight: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: withAlpha(colors.white, 0.1), opacity: start >= maxStart ? 0.4 : 1 }}
        >
          <T size={13} weight={600}>
            +5s
          </T>
        </Tap>
        <View style={{ flex: 1 }} />
        {onDone ? <Button label="Done" height={44} onPress={onDone} /> : null}
      </Row>

      {preview.error ? (
        <T size={13} color={colors.error} accessibilityLiveRegion="polite">
          {preview.error}
        </T>
      ) : null}
    </View>
  );
}
