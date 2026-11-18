import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, type RecordingOptions } from 'expo-audio';
import { File } from 'expo-file-system';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, PanResponder, Platform, View } from 'react-native';

import { Button, go, Gradient, Icon, Row, Screen, Sheet, T, Tap, useReduceMotion } from '../components';
import { chatBus, chatError, formatMs, sendMessage, uploadMediaForMessage, VOICE_MAX_MS } from '../lib/chat';
import { routeIfSetupRequired } from '../lib/chat-e2ee';
import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';

const RECORDING: RecordingOptions = { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true };
const BARS = 40;

type Phase = 'starting' | 'recording' | 'paused' | 'stopped' | 'sending' | 'error';

/** Drag distance (px) on the mic that locks (up) or cancels (left). */
const SLIDE = 80;

/** dBFS (-160..0) → 0..1, with -60 dB as silence. */
const level = (db: number | undefined) => (db === undefined ? 0 : Math.max(0, Math.min(1, (db + 60) / 60)));

function downsample(xs: number[], n: number): number[] {
  if (xs.length <= n) return xs.map((x) => Math.round(x * 100) / 100);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * xs.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * xs.length) / n));
    const slice = xs.slice(a, b);
    out.push(Math.round((Math.max(...slice) || 0) * 100) / 100);
  }
  return out;
}

const removeFile = (uri: string | null) => {
  if (!uri) return;
  try {
    new File(uri).delete();
  } catch {
    /* already gone */
  }
};

/**
 * Voice note screen (`/chat-voice?id=<conversation>`). Records with the microphone as soon as it opens
 * (expo-audio, metering on so the bars show real levels), uploads to the private chat-media bucket and
 * posts a voice message. Up to 2 minutes. Mic: tap to pause / resume, slide up to lock, slide left to
 * cancel (holding and letting go pauses). Cancel discards; nothing is kept on the device.
 */
export default function ChatVoice() {
  const params = useLocalSearchParams<{ id?: string }>();
  const cid = typeof params.id === 'string' ? params.id : '';
  const { user } = useAuth();
  const me = user?.id;
  const { playing, pause } = usePlayerPick('playing');
  const recorder = useAudioRecorder(RECORDING);
  const [phase, setPhase] = useState<Phase>('starting');
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const [durationMs, setDurationMs] = useState(0);
  const uriRef = useRef<string | null>(null);
  const sentRef = useRef(false);
  const [locked, setLocked] = useState(false);
  const reduce = useReduceMotion();

  const restoreAudio = () => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' }).catch(() => undefined);

  // Async only (no synchronous setState), so it can run from the mount effect.
  const start = useCallback(async () => {
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setError(perm.canAskAgain ? 'Microphone permission is needed to record a voice note.' : 'Microphone access is off. Turn it on in Settings.');
        setPhase('error');
        return;
      }
      if (playing) pause();
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setLevels([]);
      setPhase('recording');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start recording');
      setPhase('error');
    }
    // Only on mount / retry: `playing` changes as we pause.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder]);

  useEffect(() => {
    // Async: state changes after the permission prompt / recorder start.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (cid && me) void start();
  }, [cid, me, start]);

  const stop = useCallback(async () => {
    // A paused recorder isn't `isRecording` but still has to be finalised.
    await recorder.stop().catch(() => undefined);
    uriRef.current = recorder.uri;
    await restoreAudio();
  }, [recorder]);

  // Sample real metering levels and duration while recording; stop at the hard limit.
  useEffect(() => {
    if (phase !== 'recording') return;
    const t = setInterval(() => {
      const st = recorder.getStatus();
      if (!st.isRecording) return;
      setLevels((l) => (l.length > 1200 ? l : [...l, level(st.metering)]));
      setDurationMs(st.durationMillis);
      if (st.durationMillis >= VOICE_MAX_MS) {
        clearInterval(t);
        void stop().then(() => setPhase('stopped'));
      }
    }, 100);
    return () => clearInterval(t);
  }, [phase, recorder, stop]);

  const retry = () => {
    setError(null);
    setPhase('starting');
    void start();
  };

  // Leaving the sheet without sending discards the recording.
  useEffect(
    () => () => {
      // Also finalises a paused recording.
      if (!sentRef.current) void recorder.stop().catch(() => undefined);
      void restoreAudio();
      if (!sentRef.current) removeFile(uriRef.current ?? recorder.uri);
    },
    [recorder],
  );

  const cancel = async () => {
    await stop();
    removeFile(uriRef.current);
    uriRef.current = null;
    go('back');
  };

  const send = async () => {
    if (!cid || !me) return;
    if (phase === 'recording' || phase === 'paused') {
      await stop();
    }
    const uri = uriRef.current;
    const ms = Math.min(VOICE_MAX_MS, durationMs);
    if (!uri) {
      setError('Nothing was recorded.');
      setPhase('error');
      return;
    }
    if (ms < 700) {
      setError('That was too short. Hold on a little longer.');
      removeFile(uri);
      uriRef.current = null;
      setPhase('error');
      return;
    }
    setPhase('sending');
    setError(null);
    try {
      const web = Platform.OS === 'web';
      const mime = web ? 'audio/webm' : 'audio/mp4';
      // Encrypted before upload when the chat is end-to-end encrypted (meta.media {path, key, mime, size, duration_ms}).
      const up = await uploadMediaForMessage(cid, me, uri, mime, web ? 'webm' : 'm4a', 'voice', { duration_ms: Math.round(ms), levels: downsample(levels, BARS) });
      const reply = chatBus.get().replyTo[cid];
      await sendMessage(cid, me, { kind: 'voice', meta: up.meta, reply_to: reply?.id ?? null }, { requireEncrypted: up.requireEncrypted });
      if (reply) chatBus.setReply(cid, undefined);
      sentRef.current = true;
      removeFile(uri);
      uriRef.current = null;
      go('back');
    } catch (e) {
      if (routeIfSetupRequired(e)) {
        setPhase('stopped');
        return;
      }
      setError(chatError(e, 'Voice note not sent'));
      setPhase('stopped');
    }
  };

  /** Tap on the mic: pause / resume (a locked recording keeps going until Send or Cancel). */
  const toggleMic = async () => {
    if (phase === 'recording' && !locked) {
      recorder.pause();
      setPhase('paused');
    } else if (phase === 'paused') {
      recorder.record();
      setPhase('recording');
    }
  };

  // Mic gestures from the design: slide up to lock, slide left to cancel. Holding the mic and letting
  // go without locking pauses; a quick tap toggles pause / resume.
  const [drag] = useState(() => new Animated.ValueXY());
  const gesture = useRef({ at: 0, done: false });
  const handlers = useRef({ cancel, toggleMic, lock: () => setLocked(true), phase, locked });
  useEffect(() => {
    handlers.current = { cancel, toggleMic, lock: () => setLocked(true), phase, locked };
  });
  // The refs below are only read inside the gesture callbacks, never during render.
  // eslint-disable-next-line react-hooks/refs
  const [pan] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        gesture.current = { at: Date.now(), done: false };
      },
      onPanResponderMove: (_e, g) => {
        if (gesture.current.done) return;
        const h = handlers.current;
        drag.setValue({ x: Math.min(0, Math.max(-SLIDE, g.dx)), y: Math.min(0, Math.max(-SLIDE, g.dy)) });
        if (g.dx < -SLIDE && Math.abs(g.dx) > Math.abs(g.dy)) {
          gesture.current.done = true;
          void h.cancel();
        } else if (g.dy < -SLIDE && h.phase === 'recording') {
          gesture.current.done = true;
          h.lock();
        }
      },
      onPanResponderRelease: (_e, g) => {
        const h = handlers.current;
        Animated.spring(drag, { toValue: { x: 0, y: 0 }, useNativeDriver: true }).start();
        if (gesture.current.done) return;
        const moved = Math.abs(g.dx) > 8 || Math.abs(g.dy) > 8;
        const held = Date.now() - gesture.current.at > 350;
        if (!moved && !held) void h.toggleMic();
        else if (h.phase === 'recording' && !h.locked) void h.toggleMic();
      },
      onPanResponderTerminate: () => Animated.spring(drag, { toValue: { x: 0, y: 0 }, useNativeDriver: true }).start(),
    }),
  );

  // Ripple behind the mic while recording (off with Reduce Motion).
  const [ripple] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (phase !== 'recording' || reduce) return;
    const loop = Animated.loop(Animated.timing(ripple, { toValue: 1, duration: 2000, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    ripple.setValue(0);
    loop.start();
    return () => loop.stop();
  }, [phase, reduce, ripple]);
  const glowStyle = Platform.OS === 'ios' ? { shadowColor: colors.accent, shadowOpacity: 0.6, shadowRadius: 24, shadowOffset: { width: 0, height: 0 } } : { elevation: 12 };

  if (!cid || !me) {
    return (
      <Sheet>
        <T variant="section">Voice note</T>
        <T size={14} color={colors.textSecondary}>
          {me ? 'Open a chat first.' : 'Sign in to send voice notes.'}
        </T>
        <Button label="Close" height={44} onPress={() => go('back')} />
      </Sheet>
    );
  }

  const shown = durationMs;
  const live = levels.slice(-BARS);
  const bars = Array.from({ length: BARS }, (_, i) => live[i - (BARS - live.length)] ?? 0);
  const label =
    phase === 'recording'
      ? locked
        ? 'RECORDING · LOCKED'
        : 'RECORDING VOICE NOTE'
      : phase === 'paused'
        ? 'PAUSED'
        : phase === 'sending'
          ? 'SENDING…'
          : phase === 'starting'
            ? 'STARTING MICROPHONE…'
            : phase === 'error'
              ? 'NOT RECORDING'
              : 'READY TO SEND';
  const hint =
    phase === 'recording'
      ? locked
        ? 'Locked · tap Send when you’re done'
        : 'Slide up to lock · slide left to cancel'
      : phase === 'paused'
        ? 'Paused · tap the mic to keep recording'
        : phase === 'stopped'
          ? `Up to ${formatMs(VOICE_MAX_MS)} · tap Send`
          : ' ';
  const canSend = phase === 'recording' || phase === 'paused' || phase === 'stopped';

  return (
    <Screen top={0} gap={0} scroll={false} backdrop={{ pattern: 'none', mesh: 'rose', orbs: true }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 22, paddingTop: 32, paddingBottom: 16 }}>
        <T size={13} tracking={1} color={colors.textSecondary} accessibilityLiveRegion="polite">
          {label}
        </T>
        <T size={72} weight={200} tracking={-2} lineHeight={76} accessibilityLabel={`Duration ${formatMs(shown)}`}>
          {formatMs(shown)}
        </T>
        <Row gap={3} align="center" style={{ height: 70, alignSelf: 'stretch' }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {bars.map((l, i) => (
            <View key={i} style={{ flex: 1, height: Math.max(6, Math.round(l * 70)), borderRadius: 3, backgroundColor: colors.accent, opacity: l > 0 ? 0.9 : 0.35 }} />
          ))}
        </Row>
        <View style={{ width: 130, height: 130, alignItems: 'center', justifyContent: 'center' }}>
          {phase === 'recording' && !reduce ? (
            <Animated.View
              pointerEvents="none"
              style={{
                position: 'absolute',
                width: 130,
                height: 130,
                borderRadius: 65,
                backgroundColor: withAlpha(colors.accent, 0.33),
                opacity: ripple.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
                transform: [{ scale: ripple.interpolate({ inputRange: [0, 1], outputRange: [0.6, 2.6] }) }],
              }}
            />
          ) : null}
          <Animated.View
            {...pan.panHandlers}
            accessible
            accessibilityRole="button"
            accessibilityLabel={phase === 'paused' ? 'Resume recording' : phase === 'recording' ? (locked ? 'Recording, locked' : 'Pause recording') : 'Microphone'}
            accessibilityHint={phase === 'recording' && !locked ? 'Slide up to lock, slide left to cancel' : undefined}
            accessibilityActions={[{ name: 'activate' }, { name: 'magicTap', label: 'Lock' }, { name: 'escape', label: 'Cancel' }]}
            onAccessibilityAction={(e) => {
              if (e.nativeEvent.actionName === 'escape') void cancel();
              else if (e.nativeEvent.actionName === 'magicTap') setLocked(true);
              else void toggleMic();
            }}
            style={[{ width: 96, height: 96, borderRadius: 48, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', transform: [{ translateX: drag.x }, { translateY: drag.y }] }, glowStyle]}
          >
            <Icon name={locked && phase === 'recording' ? 'lock' : 'mic'} size={38} color={colors.white} filled={!locked} />
          </Animated.View>
        </View>
        <T size={13} color={colors.textSecondary} align="center">
          {hint}
        </T>
        {error ? (
          <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite">
            {error}
          </T>
        ) : null}
        <Row gap={14} style={{ alignSelf: 'stretch', marginTop: 6 }}>
          <Tap
            onPress={() => void cancel()}
            accessibilityRole="button"
            accessibilityLabel="Cancel voice note"
            style={{ flex: 1, height: 52, borderRadius: 26, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}
          >
            <Icon name="trash" size={18} color={colors.text} />
            <T size={15} weight={600}>
              Cancel
            </T>
          </Tap>
          {phase === 'error' ? (
            <Tap onPress={retry} accessibilityRole="button" accessibilityLabel="Try again" style={{ flex: 1, height: 52, borderRadius: 26, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.accent }}>
              <Icon name="mic" size={18} color={colors.white} />
              <T size={15} weight={700} color={colors.white}>
                Try again
              </T>
            </Tap>
          ) : (
            <Tap
              onPress={() => void send()}
              disabled={!canSend}
              accessibilityRole="button"
              accessibilityLabel={phase === 'sending' ? 'Sending voice note' : 'Send voice note'}
              accessibilityState={{ disabled: !canSend, busy: phase === 'sending' }}
              style={{ flex: 1, height: 52, borderRadius: 26, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.accent, opacity: canSend ? 1 : 0.6 }}
            >
              <Gradient colors={[withAlpha(colors.white, 0.34), withAlpha(colors.white, 0)]} angle={180} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 29 }} />
              <Icon name="send" size={18} color={colors.white} />
              <T size={15} weight={700} color={colors.white}>
                {phase === 'sending' ? 'Sending…' : 'Send'}
              </T>
            </Tap>
          )}
        </Row>
      </View>
    </Screen>
  );
}
