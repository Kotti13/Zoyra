import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, BackHandler, Easing, PanResponder, ScrollView, StyleSheet, useWindowDimensions, Vibration, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { Cover, Icon, Sheet, SongPicker, T, Tap, useReduceMotion } from '../components';
import type { IconName } from '../components/icons';
import { loadAgora } from '../lib/agora';
import { shareSong, toggleSharedPause, useCallListen } from '../lib/call-listen';
import {
  closeCallSession,
  flipCamera,
  setBackgroundBlur,
  setBeauty,
  setVoiceEffect,
  VOICE_EFFECTS,
  getCallEnding,
  getCallSession,
  hangUp,
  openCallSession,
  setCamera,
  setMinimized,
  syncCall,
  toggleMute,
  toggleSpeaker,
  useCallSession,
  type CallSession,
} from '../lib/call-session';
import { CALL_GREEN, CALL_RED, peerName, useCallPeer } from '../lib/call-ui';
import { answerCall, CallError, isLiveCall, loadCallRating, loadCallTracks, rateCall, startCall, uniqueCallTracks, useCall, type Call, type CallKind } from '../lib/calls';
import { ringtoneFor } from '../lib/forever';
import { consumeAutoAnswer, dismissNativeCall, isShownNatively, nativeCallActive, scheduleCallBackReminder, setCallShowWhenLocked, startTone, stopTone } from '../lib/native-call';
import type { CatalogTrack } from '../lib/catalog';
import { ChatAvatar } from '../lib/chat-ui';
import { formatDuration, sendMessage, type ChatPerson } from '../lib/chat';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { usePlaybackProgress, usePlayerPick } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';

const ON_GREEN = '#05140D';
const MINT = '#7EF2C2';
const LINK_RED = '#FF6B73';
const PIP_W = 108;
const PIP_H = 156;
/** Where the picture-in-picture rests (kept across minimize / return; one call at a time). */
const pipRest = { x: -1, y: -1 };
function restPip(x: number, y: number) {
  pipRest.x = x;
  pipRest.y = y;
}

/**
 * Call (`/call?id=<callId>`): full-screen 1:1 voice / video call over Agora.
 * States: outgoing ringing ("Calling…" + ringback tone), incoming ringing (CallKitRinging / CallKitVideo design:
 * ringtone, Message / Remind me, Decline, swipe up to Answer; `answer=1` = answered from the banner or the
 * native call UI, so it accepts at once; `ring=1` = opened from the Android call notification, which rings),
 * connecting, in call (voice: avatar, speaking bars, timer, control grid; video: remote full screen,
 * draggable local picture-in-picture, control bar) and ended (Call again / Message / quality stars).
 * Media lives in src/lib/call-session.ts, so minimizing (chevron, Chat, Android back) keeps the call
 * going behind a "Return to call" pill (CallHost). Leaving the screen any other way hangs up.
 */
export default function CallScreen() {
  const { id: rawId, answer: answerParam, ring: ringParam } = useLocalSearchParams<{ id?: string; answer?: string; ring?: string }>();
  const callId = typeof rawId === 'string' && rawId ? rawId.toLowerCase() : undefined;
  const { user } = useAuth();
  const me = user?.id;
  const { call, loading, reload } = useCall(callId);
  const live = useCallSession();
  const s = live && live.callId === callId ? live : null;
  const iAmCaller = !!call && call.caller_id === me;
  const peer = useCallPeer(call ? (iAmCaller ? call.callee_id : call.caller_id) : null);
  const name = peerName(peer);
  const supported = loadAgora() !== null;
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Track the call on this device; the caller is asked for mic / camera right away, the callee on Accept.
  const status = call?.status;
  useEffect(() => {
    if (!call || !me || !isLiveCall(call)) return;
    openCallSession(call, me, { prompt: call.caller_id === me || call.status === 'accepted' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call?.id, status, me]);
  useEffect(() => {
    syncCall(call);
  }, [call]);

  // Back on screen = not minimized. Leaving without minimizing (replaced, signed out…) hangs up.
  useEffect(() => {
    if (!callId) return;
    setMinimized(callId, false);
    return () => {
      const cur = getCallSession();
      if (cur && cur.callId === callId && !cur.minimized) void hangUp(callId);
    };
  }, [callId]);

  const close = () => {
    if (router.canGoBack()) router.back();
    else if (call) router.replace({ pathname: '/chat-pro', params: { id: call.conversation_id } });
    else router.replace('/');
  };
  const minimize = () => {
    if (callId) setMinimized(callId, true);
    close();
  };
  const toQueue = () => {
    minimize();
    router.push('/queue');
  };
  const toChat = () => {
    if (!call) return;
    if (callId) setMinimized(callId, true);
    router.dismissTo({ pathname: '/chat-pro', params: { id: call.conversation_id } });
  };

  const final = !!call && !isLiveCall(call);
  const ending = callId ? getCallEnding(callId) : null;

  // Android back: minimize a live call, close a finished one.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (final || !call) close();
      else minimize();
      return true;
    });
    return () => sub.remove();
  });

  // A call I cancelled / declined before it connected closes itself after 1.5 s.
  const autoClose = final && !!ending?.byMe && ending.connectedMs === null;
  useEffect(() => {
    if (!autoClose) return;
    const t = setTimeout(close, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoClose]);

  // Incoming: ringtone (follows the ringer / silent switch) + vibration, unless the phone's own call UI is
  // already ringing for it. Outgoing: ringback while "Calling…". Every tone stops on answer / decline /
  // cancel / timeout (status leaves 'ringing') and when the screen unmounts.
  const ringingIn = status === 'ringing' && !iAmCaller;
  const ringingOut = status === 'ringing' && iAmCaller;
  const nativeRing = ringParam === '1' || (!!callId && isShownNatively(callId));
  useEffect(() => {
    if (!ringingIn && !ringingOut) return;
    if (ringingOut) void startTone('ringback');
    else if (!nativeRing) {
      void startTone('ring', ringtoneFor(call?.caller_id)); // gold chime for Forever friends
      Vibration.vibrate([0, 700, 1300], true);
    }
    return () => {
      stopTone();
      Vibration.cancel();
    };
  }, [ringingIn, ringingOut, nativeRing, call?.caller_id]);

  // Android: stay visible over the lock screen while the call rings / is live (opened from the call notification).
  const liveCall = !!call && isLiveCall(call);
  useEffect(() => {
    if (!liveCall) return;
    setCallShowWhenLocked(true);
    return () => setCallShowWhenLocked(false);
  }, [liveCall]);

  const accept = async () => {
    if (!callId || busy) return;
    setBusy('accept');
    stopTone();
    Vibration.cancel();
    try {
      const c = await answerCall(callId, true);
      if (c.status === 'accepted' && me) {
        nativeCallActive(c.id);
        openCallSession(c, me, { prompt: true });
        syncCall(c);
      }
      await reload();
    } catch (e) {
      setNote(e instanceof CallError ? e.message : 'Couldn’t answer. Try again.');
    } finally {
      setBusy(null);
    }
  };

  // Answered from the banner / CallKit / the notification's Answer: accept right away (once). The URL param
  // alone is not enough (anyone can craft zoyra://call?id=…&answer=1): consumeAutoAnswer() checks the one-shot
  // grant set by the app's own answer paths (native-call.ts / call-ui.tsx).
  const autoAnswered = useRef(false);
  useEffect(() => {
    if (answerParam !== '1' || autoAnswered.current || !ringingIn || !supported || !callId) return;
    autoAnswered.current = true;
    void consumeAutoAnswer(callId).then((ok) => {
      if (ok) void accept();
    });
  });

  /** Decline; optionally send a quick reply, open the chat, or schedule "Call <name> back" in 1 hour. */
  const decline = async (reply?: string, openChat?: boolean, remind?: boolean) => {
    if (!callId || !call || busy) return;
    setBusy(reply ? `r:${reply}` : remind ? 'remind' : openChat ? 'message' : 'decline');
    stopTone();
    Vibration.cancel();
    dismissNativeCall(callId);
    try {
      await answerCall(callId, false);
    } catch {
      // already over
    }
    closeCallSession(callId, true);
    // Quick reply: end-to-end encrypted like any chat message (sendMessage). Without keys on this phone the
    // chat opens and asks for PIN setup / restore first.
    if (reply && me) await sendMessage(call.conversation_id, me, { body: reply }).catch(() => undefined);
    if (remind) await scheduleCallBackReminder(name, call.conversation_id);
    setBusy(null);
    if (reply || openChat) router.dismissTo({ pathname: '/chat-pro', params: { id: call.conversation_id } });
    else if (remind) close();
    else void reload();
  };

  const end = async () => {
    if (!callId) return;
    setBusy('end');
    await hangUp(callId, true);
    setBusy(null);
    void reload();
  };

  const callAgain = async (kind: CallKind) => {
    if (!call || busy) return;
    setBusy('again');
    setNote(null);
    try {
      const next = await startCall(call.conversation_id, kind);
      if (next.status === 'busy') setNote("They're on another call. We'll let them know you called.");
      else router.replace({ pathname: '/call', params: { id: next.id } });
    } catch (e) {
      setNote(e instanceof CallError ? e.message : 'Couldn’t start the call. Try again.');
    } finally {
      setBusy(null);
    }
  };

  /* ------------------------------------------------------------------ states */

  let body: ReactNode;
  if (!callId || (!loading && !call)) {
    body = <Message title="Call not available" text="This call is no longer available." onClose={close} />;
  } else if (!call || !me) {
    body = (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.text} />
      </View>
    );
  } else if (final) {
    body = <Ended call={call} me={me} iAmCaller={iAmCaller} peer={peer} name={name} busy={busy === 'again'} note={note} onClose={close} onCallAgain={callAgain} onMessage={toChat} />;
  } else if (!supported) {
    body = (
      <Message
        title="Calls need the latest app build"
        text={`Update Zoyra to ${iAmCaller ? 'make' : 'answer'} voice and video calls.`}
        actionLabel={iAmCaller ? 'End call' : 'Decline'}
        onAction={() => void (iAmCaller ? end() : decline())}
        onClose={close}
      />
    );
  } else if (call.status === 'ringing' && !iAmCaller) {
    body = <Incoming call={call} s={s} peer={peer} name={name} busy={busy} note={note ?? s?.error ?? null} onAccept={accept} onDecline={decline} />;
  } else if (s && (s.video || s.remoteVideo)) {
    body = <VideoCall call={call} s={s} peer={peer} name={name} outgoing={call.status === 'ringing'} note={note ?? s.error} onMinimize={minimize} onEnd={end} onQueue={toQueue} />;
  } else {
    body = <VoiceCall call={call} s={s} peer={peer} name={name} outgoing={call.status === 'ringing'} note={note ?? s?.error ?? null} onMinimize={minimize} onEnd={end} onChat={toChat} />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <LinearGradient colors={['#2A0B18', '#050505']} locations={[0, 0.75]} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      <View pointerEvents="none" style={{ position: 'absolute', top: -120, alignSelf: 'center', width: 520, height: 520, borderRadius: 260, backgroundColor: withAlpha('#FF6B81', 0.12) }} />
      {body}
    </View>
  );
}

/* ================================================================== pieces */

function useTimer(from: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (from === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [from]);
  if (from === null) return null;
  const s = Math.max(0, Math.floor((now - from) / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const statusLine = (call: Call, s: CallSession | null, outgoing: boolean) =>
  outgoing ? 'Calling…' : s?.phase === 'preparing' || s?.phase === 'ready' || s?.phase === 'joining' || (s && !s.remoteJoined) || call.status !== 'accepted' ? 'Connecting…' : '';

/** Avatar with the three expanding ring pulses (static under Reduce Motion). */
function PulseAvatar({ peer, size, rings }: { peer: ChatPerson | null; size: number; rings: boolean }) {
  const reduce = useReduceMotion();
  const [anims] = useState(() => [0, 1, 2].map(() => new Animated.Value(0)));
  const animate = rings && !reduce;
  useEffect(() => {
    if (!animate) return;
    const loops = anims.map((a, i) =>
      Animated.loop(Animated.sequence([Animated.delay(i * 800), Animated.timing(a, { toValue: 1, duration: 2400, easing: Easing.out(Easing.quad), useNativeDriver: true }), Animated.timing(a, { toValue: 0, duration: 0, useNativeDriver: true })])),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [animate, anims]);
  return (
    <View style={{ width: size, height: size }}>
      {animate
        ? anims.map((a, i) => (
            <Animated.View
              key={i}
              pointerEvents="none"
              style={{
                position: 'absolute',
                width: size,
                height: size,
                borderRadius: size / 2,
                borderWidth: 2,
                borderColor: withAlpha(colors.white, 0.35),
                opacity: a.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
                transform: [{ scale: a.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] }) }],
              }}
            />
          ))
        : null}
      <View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 3, borderColor: withAlpha(colors.white, 0.18), overflow: 'hidden', shadowColor: '#FF6B81', shadowOpacity: 0.35, shadowRadius: 30, shadowOffset: { width: 0, height: 20 } }}>
        <ChatAvatar person={peer} size={size - 6} />
      </View>
    </View>
  );
}

/** Nine green bars that bounce while the other person is speaking. */
function SpeakingBars({ active }: { active: boolean }) {
  const reduce = useReduceMotion();
  const [anims] = useState(() => Array.from({ length: 9 }, () => new Animated.Value(0.3)));
  const animate = active && !reduce;
  useEffect(() => {
    if (!animate) {
      anims.forEach((a) => a.setValue(active ? 0.8 : 0.3));
      return;
    }
    const loops = anims.map((a, i) => {
      const d = [700, 850, 1000, 1150][i % 4] / 2;
      return Animated.loop(
        Animated.sequence([
          Animated.delay(i * 80),
          Animated.timing(a, { toValue: 1, duration: d, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(a, { toValue: 0.3, duration: d, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ]),
      );
    });
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [animate, active, anims]);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 24, opacity: active ? 1 : 0.35 }}>
      {anims.map((a, i) => (
        <Animated.View key={i} style={{ width: 4, height: 22, borderRadius: 2, backgroundColor: CALL_GREEN, transform: [{ scaleY: a }] }} />
      ))}
    </View>
  );
}

/** The design's Effects glyph (a burst), drawn like the shared icon set (24 grid, 1.6 stroke). */
function EffectsGlyph({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no">
      <Path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

type ButtonIcon = IconName | 'effects';

function Glyph({ icon, size, color }: { icon: ButtonIcon; size: number; color: string }) {
  return icon === 'effects' ? <EffectsGlyph size={size} color={color} /> : <Icon name={icon} size={size} color={color} glow={false} />;
}

function RoundButton({
  icon,
  label,
  onPress,
  size = 60,
  bg,
  color = colors.text,
  on,
  busy,
  hideLabel,
  glow,
  iconSize,
  labelSize = 12,
  labelGap = 8,
  border,
}: {
  icon: ButtonIcon;
  label: string;
  onPress: () => void;
  size?: number;
  bg?: string;
  color?: string;
  on?: boolean;
  busy?: boolean;
  hideLabel?: boolean;
  glow?: string;
  iconSize?: number;
  labelSize?: number;
  labelGap?: number;
  border?: string;
}) {
  const fill = on ? colors.text : (bg ?? withAlpha(colors.white, 0.12));
  const fg = on ? colors.bg : color;
  const edge = border ?? (bg || on ? null : withAlpha(colors.white, 0.16));
  return (
    <Tap onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={on === undefined ? { busy } : { selected: on, busy }} style={{ alignItems: 'center', gap: labelGap, minWidth: 64 }}>
      <View
        style={[
          { width: size, height: size, borderRadius: size / 2, backgroundColor: fill, alignItems: 'center', justifyContent: 'center' },
          edge && !on ? { borderWidth: 1, borderColor: edge } : null,
          glow ? { shadowColor: glow, shadowOpacity: 0.5, shadowRadius: 15, shadowOffset: { width: 0, height: 10 }, elevation: 8 } : null,
        ]}
      >
        {busy ? <ActivityIndicator color={fg} /> : <Glyph icon={icon} size={iconSize ?? (size >= 72 ? 30 : size >= 60 ? 24 : 22)} color={fg} />}
      </View>
      {hideLabel ? null : (
        <T size={labelSize} weight={labelSize > 12 ? 400 : 500} color="#E5E5E5">
          {label}
        </T>
      )}
    </Tap>
  );
}

function NoteText({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite" style={{ marginBottom: 12 }}>
      {text}
    </T>
  );
}

/** Full-screen local camera preview (outgoing / incoming video calls before connecting). */
function LocalPreview({ s }: { s: CallSession | null }) {
  const agora = loadAgora();
  if (!agora || !s?.video || s.phase === 'idle' || s.phase === 'preparing') return null;
  const { RtcSurfaceView } = agora;
  return (
    <>
      <RtcSurfaceView style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} canvas={{ uid: 0, renderMode: 1 }} />
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' }} />
    </>
  );
}

/* ================================================================== incoming */

function Incoming({ call, s, peer, name, busy, note, onAccept, onDecline }: { call: Call; s: CallSession | null; peer: ChatPerson | null; name: string; busy: string | null; note: string | null; onAccept: () => void; onDecline: (reply?: string, openChat?: boolean, remind?: boolean) => void }) {
  const insets = useSafeAreaInsets();
  // What the caller is listening to (they shared it with the call; it plays for both once you accept).
  const listening = useCallListen(call.id)?.shared ?? null;
  const reduce = useReduceMotion();
  const [glow] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(Animated.sequence([Animated.timing(glow, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }), Animated.timing(glow, { toValue: 0, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true })]));
    loop.start();
    return () => loop.stop();
  }, [reduce, glow]);
  const video = call.kind === 'video';
  const callLabel = video ? 'Zoyra video call' : 'Zoyra voice call';
  // Only claim encryption when this call's media encryption is actually on (server-issued key: "Encrypted",
  // never "end-to-end").
  const header = s?.encrypted ? `Encrypted · ${callLabel}` : callLabel;
  return (
    <View style={{ flex: 1 }}>
      {video ? <LinearGradient colors={['#16305F', '#050505']} style={StyleSheet.absoluteFill} /> : null}
      <View style={{ flex: 1, alignItems: 'center', paddingTop: insets.top + 18, paddingBottom: insets.bottom + 32, paddingHorizontal: 24 }}>
        <View style={{ alignSelf: video ? 'flex-start' : 'center', height: 28, paddingHorizontal: 12, borderRadius: 22, backgroundColor: withAlpha(colors.white, 0.1), flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name={s?.encrypted ? 'lock' : video ? 'video' : 'call'} size={13} color={colors.text} />
          <T size={12} weight={600}>
            {header}
          </T>
        </View>
        <View style={{ marginTop: video ? 110 : 64 }}>
          <PulseAvatar peer={peer} size={video ? 130 : 150} rings />
        </View>
        <T size={34} weight={300} tracking={-0.8} align="center" numberOfLines={1} style={{ marginTop: video ? 30 : 36 }} accessibilityRole="header">
          {name}
        </T>
        <BlinkText text={video ? 'Zoyra video ringing…' : 'Zoyra audio ringing…'} />
        {listening ? (
          <View
            accessible
            accessibilityLabel={`Listening to ${listening.title}. It plays for both of you when you accept.`}
            style={{ marginTop: 18, height: 38, paddingLeft: 6, paddingRight: 14, borderRadius: 19, backgroundColor: withAlpha(CALL_GREEN, 0.12), borderWidth: 1, borderColor: withAlpha(CALL_GREEN, 0.4), flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: '100%' }}
          >
            <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: CALL_GREEN, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="music" size={14} color={ON_GREEN} glow={false} />
            </View>
            <T size={13} numberOfLines={1} style={{ flexShrink: 1 }}>
              Listening to{' '}
              <T size={13} weight={700}>
                {listening.title}
              </T>
            </T>
          </View>
        ) : null}
        <View style={{ flex: 1 }} />
        <NoteText text={note} />
        <View style={{ flexDirection: 'row', gap: 10, width: '100%', marginBottom: 26 }}>
          <Pill icon="chat" label="Message" busy={busy === 'message'} hint="Declines and opens your chat" onPress={() => onDecline(undefined, true)} />
          <Pill icon="clock" label="Remind me" busy={busy === 'remind'} hint="Declines and reminds you to call back in 1 hour" onPress={() => onDecline(undefined, false, true)} />
        </View>
        <SwipeHint />
        <View style={{ width: '100%', flexDirection: 'row', justifyContent: 'space-around', alignItems: 'flex-end', marginTop: 6 }}>
          <RoundButton icon="hangup" label="Decline" size={72} bg="#E5253B" color={colors.white} labelSize={13} labelGap={10} busy={busy === 'decline'} onPress={() => onDecline()} />
          <SwipeAnswer video={video} busy={busy === 'accept'} glow={reduce ? null : glow} onAccept={onAccept} />
          <View style={{ width: 72 }} />
        </View>
      </View>
      {video ? <IncomingSelfView s={s} /> : null}
    </View>
  );
}

/** "Zoyra audio ringing…" with the design's soft blink (static under Reduce Motion). */
function BlinkText({ text }: { text: string }) {
  const reduce = useReduceMotion();
  const [a] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(Animated.sequence([Animated.timing(a, { toValue: 0.5, duration: 800, useNativeDriver: true }), Animated.timing(a, { toValue: 1, duration: 800, useNativeDriver: true })]));
    loop.start();
    return () => loop.stop();
  }, [reduce, a]);
  return (
    <Animated.View style={{ marginTop: 6, opacity: a }}>
      <T size={15} color="#E5E5E5" accessibilityLiveRegion="polite">
        {text}
      </T>
    </Animated.View>
  );
}

function Pill({ icon, label, hint, busy, onPress }: { icon: IconName; label: string; hint: string; busy: boolean; onPress: () => void }) {
  return (
    <Tap
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ busy }}
      style={{ flex: 1, height: 44, borderRadius: 22, backgroundColor: withAlpha(colors.white, 0.1), borderWidth: 1, borderColor: withAlpha(colors.white, 0.14), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}
    >
      {busy ? <ActivityIndicator size="small" color={colors.text} /> : <Icon name={icon} size={16} color={colors.text} glow={false} />}
      <T size={13} weight={600}>
        {label}
      </T>
    </Tap>
  );
}

/** Three chevrons rising in turn above "Swipe up to answer". */
function SwipeHint() {
  const reduce = useReduceMotion();
  const [anims] = useState(() => [0, 1, 2].map(() => new Animated.Value(0.25)));
  useEffect(() => {
    if (reduce) return;
    const loops = anims.map((v, i) =>
      Animated.loop(Animated.sequence([Animated.delay((2 - i) * 300), Animated.timing(v, { toValue: 1, duration: 500, useNativeDriver: true }), Animated.timing(v, { toValue: 0.25, duration: 700, useNativeDriver: true }), Animated.delay(i * 300)])),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [reduce, anims]);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ alignItems: 'center', gap: 2, marginBottom: 6 }}>
      {anims.map((v, i) => (
        <Animated.View key={i} style={{ opacity: v }}>
          <Icon name="chevronUp" size={16} color={colors.text} glow={false} />
        </Animated.View>
      ))}
      <T size={13} color="#E5E5E5" style={{ marginTop: 2 }}>
        Swipe up to answer
      </T>
    </View>
  );
}

/** The 84 px green Answer button: swipe it up (or tap it) to answer. */
function SwipeAnswer({ video, busy, glow, onAccept }: { video: boolean; busy: boolean; glow: Animated.Value | null; onAccept: () => void }) {
  const [dy] = useState(() => new Animated.Value(0));
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => g.dy < -6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderMove: (_e, g) => dy.setValue(Math.max(-140, Math.min(0, g.dy))),
        onPanResponderRelease: (_e, g) => {
          if (g.dy < -80 || g.vy < -1.2) {
            Vibration.vibrate(20);
            onAccept();
          }
          Animated.spring(dy, { toValue: 0, useNativeDriver: true, bounciness: 8 }).start();
        },
        onPanResponderTerminate: () => Animated.spring(dy, { toValue: 0, useNativeDriver: true }).start(),
      }),
    [dy, onAccept],
  );
  return (
    <View style={{ alignItems: 'center', gap: 10 }}>
      <Animated.View {...pan.panHandlers} style={{ transform: [{ translateY: dy }] }}>
        {glow ? (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              width: 84,
              height: 84,
              borderRadius: 42,
              backgroundColor: withAlpha(CALL_GREEN, 0.55),
              opacity: glow.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
              transform: [{ scale: glow.interpolate({ inputRange: [0, 1], outputRange: [1, 112 / 84] }) }],
            }}
          />
        ) : null}
        <Tap
          onPress={onAccept}
          accessibilityRole="button"
          accessibilityLabel="Answer"
          accessibilityHint="Swipe up or double tap to answer"
          accessibilityState={{ busy }}
          style={{ width: 84, height: 84, borderRadius: 42, backgroundColor: CALL_GREEN, alignItems: 'center', justifyContent: 'center' }}
        >
          {busy ? <ActivityIndicator color={ON_GREEN} /> : <Icon name={video ? 'video' : 'call'} size={32} color={ON_GREEN} glow={false} />}
        </Tap>
      </Animated.View>
      <T size={13} color="#E5E5E5">
        Answer
      </T>
    </View>
  );
}

/** CallKitVideo: your own camera in a small "You" window while a video call rings. */
function IncomingSelfView({ s }: { s: CallSession | null }) {
  const insets = useSafeAreaInsets();
  const agora = loadAgora();
  const ready = !!agora && !!s?.video && s.phase !== 'idle' && s.phase !== 'preparing';
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: insets.top + 18, right: 18, width: 104, height: 150, borderRadius: 22, overflow: 'hidden', borderWidth: 2, borderColor: withAlpha(colors.white, 0.35), backgroundColor: '#2A080C' }}>
      {ready && agora ? <agora.RtcSurfaceView style={{ flex: 1 }} zOrderMediaOverlay canvas={{ uid: 0, renderMode: 1 }} /> : <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Icon name="videoOff" size={22} color={withAlpha(colors.white, 0.7)} /></View>}
      <T size={11} weight={600} style={{ position: 'absolute', left: 8, bottom: 8 }}>
        You
      </T>
    </View>
  );
}

/* ================================================================== voice */

function VoiceCall({ call, s, peer, name, outgoing, note, onMinimize, onEnd, onChat }: { call: Call; s: CallSession | null; peer: ChatPerson | null; name: string; outgoing: boolean; note: string | null; onMinimize: () => void; onEnd: () => void; onChat: () => void }) {
  const insets = useSafeAreaInsets();
  const timer = useTimer(s?.connectedAt ?? null);
  const line = timer ?? statusLine(call, s, outgoing);
  const [sheet, setSheet] = useState<'share' | 'effects' | null>(null);
  const controls: { key: string; icon: ButtonIcon; label: string; on?: boolean; onPress: () => void }[] = [
    { key: 'mute', icon: 'micOff', label: s?.muted ? 'Unmute' : 'Mute', on: !!s?.muted, onPress: toggleMute },
    { key: 'speaker', icon: 'speaker', label: 'Speaker', on: !!s?.speaker, onPress: toggleSpeaker },
    { key: 'video', icon: 'video', label: 'Video', onPress: () => void setCamera(true) },
    { key: 'share', icon: 'music', label: 'Share song', onPress: () => setSheet('share') },
    { key: 'chat', icon: 'chat', label: 'Chat', onPress: onChat },
    { key: 'effects', icon: 'effects', label: 'Effects', on: !!s && s.voiceEffect !== 'off', onPress: () => setSheet('effects') },
  ];
  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, alignItems: 'center', paddingTop: insets.top + 12, paddingBottom: insets.bottom + 28, paddingHorizontal: 20 }} bounces={false}>
        <View style={{ width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Tap onPress={onMinimize} accessibilityRole="button" accessibilityLabel="Minimize call" style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: withAlpha(colors.white, 0.1), alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="chevronDown" size={22} color={colors.text} />
          </Tap>
          {s?.encrypted ? (
            <View accessible accessibilityLabel="Encrypted call" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Icon name="lock" size={13} color="#D4D4D4" />
              <T size={12} color="#D4D4D4">
                Encrypted
              </T>
            </View>
          ) : (
            <T size={12} color="#D4D4D4">
              {call.kind === 'video' ? 'Zoyra video call' : 'Zoyra voice call'}
            </T>
          )}
          {/* "Add people" is not offered: calls are 1:1. */}
          <View style={{ width: 44 }} />
        </View>
        <View style={{ marginTop: 56 }}>
          <PulseAvatar peer={peer} size={160} rings={outgoing} />
        </View>
        <View style={{ marginTop: 20 }}>
          <SpeakingBars active={!!s?.remoteSpeaking} />
        </View>
        <T size={30} weight={300} tracking={-0.5} align="center" numberOfLines={1} style={{ marginTop: 16 }} accessibilityRole="header">
          {name}
        </T>
        <T size={15} mono={!!timer} color={timer ? CALL_GREEN : '#D4D4D4'} style={{ marginTop: 6 }} accessibilityLiveRegion={timer ? 'none' : 'polite'}>
          {line}
        </T>
        <SharedSongCard callId={call.id} />
        <View style={{ flex: 1, minHeight: 24 }} />
        <NoteText text={note} />
        <View style={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', rowGap: 22, marginBottom: 32 }}>
          {controls.map((c) => (
            <View key={c.key} style={{ width: '33.33%', alignItems: 'center' }}>
              <RoundButton icon={c.icon} label={c.label} on={c.on} onPress={c.onPress} />
            </View>
          ))}
        </View>
        <RoundButton icon="hangup" label="End call" hideLabel size={72} bg={CALL_RED} color={colors.white} glow={CALL_RED} onPress={onEnd} />
      </ScrollView>
      {sheet === 'share' ? <ShareSongSheet callId={call.id} onClose={() => setSheet(null)} /> : null}
      {sheet === 'effects' && s ? <EffectsSheet s={s} onClose={() => setSheet(null)} /> : null}
    </View>
  );
}

/* ================================================================== listening together */

/** "PLAYING FOR BOTH OF YOU": the shared song, its progress and a pause that controls both sides. */
function SharedSongCard({ callId }: { callId: string }) {
  const listen = useCallListen(callId);
  const player = usePlayerPick('track', 'playing');
  const shared = listen?.shared ?? null;
  if (!shared) return null;
  const current = player.track?.id === shared.id;
  const playing = current && player.playing;
  return (
    <View style={{ marginTop: 28, width: '100%', borderRadius: 26, borderWidth: 1, borderColor: withAlpha(colors.white, 0.16), overflow: 'hidden' }}>
      <LinearGradient colors={[withAlpha(colors.white, 0.14), withAlpha(colors.white, 0.04), 'rgba(229,9,20,0.05)']} locations={[0, 0.6, 1]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <View style={{ paddingVertical: 12, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Cover artwork={shared.artwork} id={shared.id} size={48} radius={14} />
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <T size={11} weight={700} tracking={0.6} color={MINT}>
            PLAYING FOR BOTH OF YOU
          </T>
          <T size={15} weight={600} numberOfLines={1}>
            {shared.title}
            <T size={15} weight={400} color="#A3A3A3">
              {` · ${shared.artist.name}`}
            </T>
          </T>
          {current ? <SharedProgress /> : <View style={{ height: 3, borderRadius: 2, backgroundColor: withAlpha(colors.white, 0.15) }} />}
        </View>
        <Tap
          onPress={toggleSharedPause}
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Pause shared song' : 'Play shared song'}
          style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: withAlpha(colors.white, 0.14), alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name={playing ? 'pause' : 'play'} size={16} color={colors.white} filled glow={false} />
        </Tap>
      </View>
    </View>
  );
}

function SharedProgress() {
  const { progress } = usePlaybackProgress();
  return (
    <View style={{ height: 3, borderRadius: 2, backgroundColor: withAlpha(colors.white, 0.15) }}>
      <View style={{ width: `${Math.round(progress * 1000) / 10}%`, height: 3, borderRadius: 2, backgroundColor: CALL_GREEN }} />
    </View>
  );
}

/** Video call: "<song> playing for both · Queue". */
function ListeningStrip({ callId, onQueue }: { callId: string; onQueue: () => void }) {
  const listen = useCallListen(callId);
  const player = usePlayerPick('track', 'playing');
  const shared = listen?.shared ?? null;
  if (!shared || player.track?.id !== shared.id) return null;
  return (
    <View style={{ alignSelf: 'center', height: 36, paddingLeft: 12, paddingRight: 6, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.45)', borderWidth: 1, borderColor: withAlpha(colors.white, 0.16), flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16, maxWidth: '100%' }}>
      <MiniBars active={player.playing} />
      <T size={12} numberOfLines={1} style={{ flexShrink: 1 }}>
        {`${shared.title} playing for both`}
      </T>
      <Tap onPress={onQueue} accessibilityRole="button" accessibilityLabel="Queue" hitSlop={8} style={{ height: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: withAlpha(colors.white, 0.16), justifyContent: 'center' }}>
        <T size={12} weight={600}>
          Queue
        </T>
      </Tap>
    </View>
  );
}

/** Three small green bars (0.8 s, staggered 0.2 s) while the shared song plays. */
function MiniBars({ active }: { active: boolean }) {
  const reduce = useReduceMotion();
  const [anims] = useState(() => [0, 1, 2].map(() => new Animated.Value(0.3)));
  const animate = active && !reduce;
  useEffect(() => {
    if (!animate) {
      anims.forEach((a) => a.setValue(active ? 0.8 : 0.3));
      return;
    }
    const loops = anims.map((a, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 200),
          Animated.timing(a, { toValue: 1, duration: 400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(a, { toValue: 0.3, duration: 400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [animate, active, anims]);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 12 }}>
      {anims.map((a, i) => (
        <Animated.View key={i} style={{ width: 3, height: 12, borderRadius: 2, backgroundColor: CALL_GREEN, transform: [{ scaleY: a }] }} />
      ))}
    </View>
  );
}

/** In-call sheet header (title + hint). */
function SheetHead({ title, hint }: { title: string; hint: string }) {
  return (
    <View style={{ gap: 4, paddingHorizontal: 4 }}>
      <T size={20} weight={600} accessibilityRole="header">
        {title}
      </T>
      <T size={13} color="#A3A3A3">
        {hint}
      </T>
    </View>
  );
}

/** Share song: pick a song; it's recorded for the call and starts for both of you. */
function ShareSongSheet({ callId, onClose }: { callId: string; onClose: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = async (t: CatalogTrack) => {
    if (busyId) return;
    setBusyId(t.id);
    setError(null);
    const err = await shareSong(t);
    setBusyId(null);
    if (err) setError(err);
    else onClose();
  };
  return (
    <View style={StyleSheet.absoluteFill}>
      <Sheet onDismiss={onClose} maxHeight={640}>
        <SheetHead title="Share a song" hint="It plays for both of you, from the same spot." />
        <NoteText text={error} />
        <SongPicker onPick={(t) => void pick(t)} busyId={busyId} busyLabel="Sharing…" maxHeight={420} />
      </Sheet>
    </View>
  );
}

/** Effects: Agora voice effects, plus beauty / background blur on video. */
function EffectsSheet({ s, onClose }: { s: CallSession; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => string | null) => setError(fn());
  const row = (key: string, label: string, hint: string, on: boolean, onPress: () => void, role: 'radio' | 'switch') => (
    <Tap
      key={key}
      onPress={onPress}
      pressScale={0.98}
      accessibilityRole={role}
      accessibilityLabel={`${label}. ${hint}`}
      accessibilityState={role === 'radio' ? { checked: on } : { checked: on }}
      style={{ minHeight: 56, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 18, backgroundColor: on ? withAlpha(CALL_GREEN, 0.12) : withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: on ? withAlpha(CALL_GREEN, 0.4) : withAlpha(colors.white, 0.12) }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <T size={15} weight={600}>
          {label}
        </T>
        <T size={12} color="#A3A3A3">
          {hint}
        </T>
      </View>
      {on ? <Icon name="checkBold" size={16} color={CALL_GREEN} glow={false} /> : null}
    </Tap>
  );
  return (
    <View style={StyleSheet.absoluteFill}>
      <Sheet onDismiss={onClose} maxHeight={680}>
        <SheetHead title="Effects" hint="Only changes how you sound and look to them." />
        <NoteText text={error} />
        <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ gap: 8 }}>
          {s.video ? (
            <>
              <T size={12} weight={700} tracking={0.6} color="#A3A3A3" style={{ marginTop: 4 }}>
                VIDEO
              </T>
              {row('beauty', 'Beauty', 'Smoother skin, brighter light', s.beauty, () => run(() => setBeauty(!s.beauty)), 'switch')}
              {row('blur', 'Blur background', 'Keeps the focus on you', s.blur, () => run(() => setBackgroundBlur(!s.blur)), 'switch')}
            </>
          ) : null}
          <T size={12} weight={700} tracking={0.6} color="#A3A3A3" style={{ marginTop: 4 }} accessibilityRole="header">
            VOICE
          </T>
          <View accessibilityRole="radiogroup" style={{ gap: 8 }}>
            {VOICE_EFFECTS.map((v) => row(v.key, v.label, v.hint, s.voiceEffect === v.key, () => run(() => setVoiceEffect(v.key)), 'radio'))}
          </View>
        </ScrollView>
      </Sheet>
    </View>
  );
}

/* ================================================================== video */

function VideoCall({ call, s, peer, name, outgoing, note, onMinimize, onEnd, onQueue }: { call: Call; s: CallSession; peer: ChatPerson | null; name: string; outgoing: boolean; note: string | null; onMinimize: () => void; onEnd: () => void; onQueue: () => void }) {
  const [effects, setEffects] = useState(false);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reduce = useReduceMotion();
  const agora = loadAgora();
  const timer = useTimer(s.connectedAt);
  const line = timer ?? statusLine(call, s, outgoing);
  const camReady = s.phase !== 'idle' && s.phase !== 'preparing';

  // Draggable picture-in-picture; snaps to the nearest side.
  const top = insets.top + 60;
  const [pos] = useState(() => {
    if (pipRest.x < 0) restPip(width - PIP_W - 16, top);
    return new Animated.ValueXY({ x: pipRest.x, y: pipRest.y });
  });
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) + Math.abs(g.dy) > 6,
        onPanResponderMove: (_e, g) => pos.setValue({ x: pipRest.x + g.dx, y: pipRest.y + g.dy }),
        onPanResponderRelease: (_e, g) => {
          const x = pipRest.x + g.dx + PIP_W / 2 < width / 2 ? 16 : width - PIP_W - 16;
          const y = Math.min(Math.max(pipRest.y + g.dy, top), height - PIP_H - insets.bottom - 140);
          restPip(x, y);
          if (reduce) pos.setValue({ x, y });
          else Animated.spring(pos, { toValue: { x, y }, useNativeDriver: false, bounciness: 6 }).start();
        },
      }),
    [pos, width, height, top, insets.bottom, reduce],
  );

  const bar: { key: string; icon: ButtonIcon; label: string; on?: boolean; onPress: () => void }[] = [
    { key: 'mute', icon: 'micOff', label: s.muted ? 'Unmute' : 'Mute', on: s.muted, onPress: toggleMute },
    { key: 'cam', icon: 'videoOff', label: s.video ? 'Turn camera off' : 'Turn camera on', on: !s.video, onPress: () => void setCamera(!s.video) },
    { key: 'effects', icon: 'effects', label: 'Effects', on: s.beauty || s.blur || s.voiceEffect !== 'off', onPress: () => setEffects(true) },
    { key: 'voice', icon: 'call', label: 'Switch to voice', onPress: () => void setCamera(false) },
  ];

  return (
    <View style={{ flex: 1 }}>
      {agora && s.remoteVideo ? (
        <agora.RtcSurfaceView style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} canvas={{ uid: s.remoteUid, renderMode: 1 }} />
      ) : agora && outgoing && s.video && camReady ? (
        <LocalPreview s={s} />
      ) : (
        <>
          <LinearGradient colors={['#3A1426', '#140810', '#050505']} locations={[0, 0.7, 1]} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
          <View style={{ position: 'absolute', top: 250, alignSelf: 'center', opacity: 0.55 }}>
            <PulseAvatar peer={peer} size={200} rings={outgoing} />
          </View>
        </>
      )}
      <LinearGradient pointerEvents="none" colors={['rgba(0,0,0,0.6)', 'transparent']} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 180 }} />
      <LinearGradient pointerEvents="none" colors={['transparent', 'rgba(0,0,0,0.75)']} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 260 }} />

      <View style={{ flex: 1, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 20, paddingHorizontal: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Tap onPress={onMinimize} accessibilityRole="button" accessibilityLabel="Minimize call" style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="chevronDown" size={22} color={colors.text} />
          </Tap>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={17} weight={600} numberOfLines={1} accessibilityRole="header">
              {name}
            </T>
            <T size={13} mono={!!timer} color={timer ? CALL_GREEN : '#D4D4D4'}>
              {line}
            </T>
          </View>
        </View>
        <View style={{ flex: 1 }} />
        <NoteText text={note} />
        <ListeningStrip callId={call.id} onQueue={onQueue} />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 40, backgroundColor: 'rgba(20,20,20,0.65)', borderWidth: 1, borderColor: withAlpha(colors.white, 0.16) }}>
          {bar.map((b) => (
            <RoundButton key={b.key} icon={b.icon} label={b.label} hideLabel size={52} bg={withAlpha(colors.white, 0.14)} on={b.on} onPress={b.onPress} />
          ))}
          <RoundButton icon="hangup" label="End call" hideLabel size={56} iconSize={30} bg={CALL_RED} color={colors.white} glow={CALL_RED} onPress={onEnd} />
        </View>
      </View>

      {/* Local picture-in-picture (only once the remote video is the background). */}
      {agora && s.remoteVideo ? (
        <Animated.View
          {...pan.panHandlers}
          accessibilityLabel="Your camera. Drag to move."
          style={{ position: 'absolute', left: 0, top: 0, transform: pos.getTranslateTransform(), width: PIP_W, height: PIP_H, borderRadius: 22, overflow: 'hidden', borderWidth: 2, borderColor: withAlpha(colors.white, 0.35), backgroundColor: '#16305F' }}
        >
          {s.video && camReady ? (
            <agora.RtcSurfaceView style={{ flex: 1 }} zOrderMediaOverlay canvas={{ uid: 0, renderMode: 1 }} />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="videoOff" size={26} color={withAlpha(colors.white, 0.8)} />
            </View>
          )}
          <View style={{ position: 'absolute', left: 8, bottom: 8, height: 22, paddingHorizontal: 8, borderRadius: 11, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center' }}>
            <T size={11} weight={600}>
              You
            </T>
          </View>
          {s.video ? (
            <Tap onPress={flipCamera} accessibilityRole="button" accessibilityLabel="Flip camera" style={{ position: 'absolute', right: 6, bottom: 6, width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="flipCamera" size={16} color={colors.white} glow={false} />
            </Tap>
          ) : null}
        </Animated.View>
      ) : s.video ? (
        <Tap onPress={flipCamera} accessibilityRole="button" accessibilityLabel="Flip camera" style={{ position: 'absolute', right: 16, top: insets.top + 8, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="flipCamera" size={20} color={colors.white} glow={false} />
        </Tap>
      ) : null}
      {effects ? <EffectsSheet s={s} onClose={() => setEffects(false)} /> : null}
    </View>
  );
}

/* ================================================================== ended */

function endedTitle(call: Call, iAmCaller: boolean): string {
  switch (call.status) {
    case 'ended':
      return 'Call ended';
    case 'declined':
      return 'Call declined';
    case 'busy':
      return iAmCaller ? 'On another call' : 'Missed call';
    case 'cancelled':
      return iAmCaller ? 'Call cancelled' : 'Missed call';
    default:
      return iAmCaller ? 'No answer' : 'Missed call';
  }
}

function Ended({ call, me, iAmCaller, peer, name, busy, note, onClose, onCallAgain, onMessage }: { call: Call; me: string; iAmCaller: boolean; peer: ChatPerson | null; name: string; busy: boolean; note: string | null; onClose: () => void; onCallAgain: (kind: CallKind) => void; onMessage: () => void }) {
  const insets = useSafeAreaInsets();
  const [stars, setStars] = useState(0);
  const [rateNote, setRateNote] = useState<string | null>(null);
  const [songs, setSongs] = useState<CatalogTrack[]>([]);
  const durationS = call.answered_at && call.ended_at ? Math.max(0, (new Date(call.ended_at).getTime() - new Date(call.answered_at).getTime()) / 1000) : null;
  const connected = durationS !== null;

  useEffect(() => {
    let alive = true;
    void loadCallTracks(call.id).then((rows) => alive && setSongs(uniqueCallTracks(rows)));
    if (connected) void loadCallRating(call.id, me).then((n) => alive && n > 0 && setStars(n));
    return () => {
      alive = false;
    };
  }, [call.id, me, connected]);

  const rate = (n: number) => {
    const prev = stars;
    setStars(n);
    setRateNote(null);
    rateCall(call.id, me, n).catch((e: unknown) => {
      setStars(prev);
      setRateNote(e instanceof CallError ? e.message : 'Couldn’t save your rating. Try again.');
    });
  };

  const missedForMe = !iAmCaller && call.status !== 'ended';
  return (
    <ScrollView contentContainerStyle={{ alignItems: 'center', gap: 16, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 28, paddingHorizontal: 16 }}>
      <View style={{ width: '100%', alignItems: 'flex-end' }}>
        <Tap onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: withAlpha(colors.white, 0.1), alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="close" size={20} color={colors.text} />
        </Tap>
      </View>
      <PulseAvatar peer={peer} size={96} rings={false} />
      <View style={{ alignItems: 'center', gap: 4 }}>
        <T size={26} weight={300} accessibilityRole="header" accessibilityLiveRegion="polite">
          {endedTitle(call, iAmCaller)}
        </T>
        <T size={14} color="#D4D4D4">
          {name}
          {connected ? ' · ' : ''}
          {connected ? (
            <T size={14} mono color="#D4D4D4">
              {formatDuration(durationS)}
            </T>
          ) : null}
        </T>
      </View>
      <View style={{ flexDirection: 'row', gap: 10, width: '100%' }}>
        <Tap
          onPress={() => onCallAgain(call.kind)}
          accessibilityRole="button"
          accessibilityLabel={missedForMe ? 'Call back' : 'Call again'}
          accessibilityState={{ busy }}
          style={{ flex: 1, height: 48, borderRadius: 24, backgroundColor: CALL_GREEN, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}
        >
          {busy ? <ActivityIndicator color={ON_GREEN} /> : <Icon name={call.kind === 'video' ? 'video' : 'call'} size={18} color={ON_GREEN} glow={false} />}
          <T size={14} weight={700} color={ON_GREEN}>
            {missedForMe ? 'Call back' : 'Call again'}
          </T>
        </Tap>
        <Tap
          onPress={onMessage}
          accessibilityRole="button"
          accessibilityLabel="Message"
          style={{ flex: 1, height: 48, borderRadius: 24, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}
        >
          <Icon name="chat" size={18} color={colors.text} />
          <T size={14} weight={600}>
            Message
          </T>
        </Tap>
      </View>
      <NoteText text={note} />
      {songs.length ? <ListenedTogether songs={songs} name={name} /> : null}
      {connected ? (
        <View accessibilityRole="radiogroup" accessibilityLabel="Rate call quality" style={{ width: '100%', padding: 14, borderRadius: 22, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12), alignItems: 'center', gap: 6 }}>
          <T size={13} color="#D4D4D4" accessibilityLiveRegion="polite">
            {stars ? 'Thanks for the feedback' : 'How was the call quality?'}
          </T>
          <View style={{ flexDirection: 'row' }}>
            {[1, 2, 3, 4, 5].map((n) => (
              <Tap
                key={n}
                onPress={() => rate(n)}
                accessibilityRole="radio"
                accessibilityLabel={n === 1 ? '1 star' : `${n} stars`}
                accessibilityState={{ checked: stars === n }}
                style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
              >
                <Icon name="star" size={28} color={n <= stars ? colors.amber : withAlpha(colors.white, 0.3)} filled={n <= stars} />
              </Tap>
            ))}
          </View>
          {rateNote ? (
            <T size={12} color={colors.error} align="center">
              {rateNote}
            </T>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

/** "You listened to N songs together · Save as playlist" + the songs (tap to play). */
function ListenedTogether({ songs, name }: { songs: CatalogTrack[]; name: string }) {
  const { playTracks } = usePlayerPick();
  const { createPlaylist, addToPlaylist } = useLibrary();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const count = songs.length;

  const save = async () => {
    if (saved) {
      router.push({ pathname: '/playlist', params: { id: saved } });
      return;
    }
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const date = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const pl = await createPlaylist({ title: `Call with ${name} · ${date}`.slice(0, 100), description: 'Songs you listened to together on a call.', visibility: 'private' });
      await addToPlaylist(pl.id, songs);
      setSaved(pl.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t save the playlist. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const play = (i: number) => {
    playTracks(songs, i, 'Listened together');
    router.push('/player');
  };

  return (
    <View style={{ width: '100%', borderRadius: 26, borderWidth: 1, borderColor: withAlpha(colors.white, 0.16), overflow: 'hidden' }}>
      <LinearGradient colors={[withAlpha(colors.white, 0.14), withAlpha(colors.white, 0.04), 'rgba(229,9,20,0.05)']} locations={[0, 0.6, 1]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <View style={{ paddingTop: 14, paddingHorizontal: 8, paddingBottom: 8, gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, gap: 8 }}>
          <T size={13} weight={600} style={{ flexShrink: 1 }} accessibilityRole="header">
            {`You listened to ${count} ${count === 1 ? 'song' : 'songs'} together`}
          </T>
          <Tap onPress={() => void save()} accessibilityRole="button" accessibilityLabel={saved ? 'Saved. Open playlist' : 'Save as playlist'} accessibilityState={{ busy: saving }} hitSlop={6} style={{ minHeight: 32, justifyContent: 'center' }}>
            {saving ? (
              <ActivityIndicator size="small" color={LINK_RED} />
            ) : (
              <T size={12} weight={700} color={saved ? CALL_GREEN : LINK_RED}>
                {saved ? 'Saved · Open' : 'Save as playlist'}
              </T>
            )}
          </Tap>
        </View>
        {error ? (
          <T size={12} color={colors.error} style={{ paddingHorizontal: 8 }}>
            {error}
          </T>
        ) : null}
        {songs.map((t, i) => (
          <Tap
            key={t.id}
            onPress={() => play(i)}
            accessibilityRole="button"
            accessibilityLabel={`${t.title} by ${t.artist.name}. Play`}
            pressScale={0.98}
            style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingHorizontal: 12 }, i > 0 ? { borderTopWidth: 1, borderTopColor: withAlpha(colors.white, 0.06) } : null]}
          >
            <Cover artwork={t.artwork} id={t.id} size={40} radius={12} />
            <View style={{ flex: 1, gap: 2 }}>
              <T size={14} weight={600} numberOfLines={1}>
                {t.title}
              </T>
              <T size={12} color="#A3A3A3" numberOfLines={1}>
                {t.artist.name}
              </T>
            </View>
          </Tap>
        ))}
      </View>
    </View>
  );
}

/* ================================================================== message */

function Message({ title, text, actionLabel, onAction, onClose }: { title: string; text: string; actionLabel?: string; onAction?: () => void; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 28, paddingHorizontal: 24 }}>
      <View style={{ alignItems: 'flex-end' }}>
        <Tap onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: withAlpha(colors.white, 0.1), alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="close" size={20} color={colors.text} />
        </Tap>
      </View>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
        <Icon name="call" size={36} color={colors.textSecondary} />
        <T size={22} weight={300} align="center" accessibilityRole="header">
          {title}
        </T>
        <T size={14} color={colors.textSecondary} align="center">
          {text}
        </T>
      </View>
      {actionLabel && onAction ? (
        <View style={{ alignItems: 'center' }}>
          <RoundButton icon="hangup" label={actionLabel} size={72} bg={CALL_RED} color={colors.white} onPress={onAction} />
        </View>
      ) : null}
    </View>
  );
}
