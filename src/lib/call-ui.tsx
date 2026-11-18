/**
 * App-wide call UI glue (screen: src/app/call.tsx, engine: src/lib/call-session.ts, backend: src/lib/calls.ts).
 * - <CallHost me={id} />, mounted once in the root AuthGate: shows the incoming-call heads-up banner
 *   (CallKitBanner design) while you're elsewhere in the app (tap → full-screen /call), wires the native
 *   call UI (src/lib/native-call.ts: CallKit / Android full-screen call notification → Answer / Decline),
 *   keeps the active call session in sync with its `calls` row while the call screen is minimized, and
 *   shows the floating "Return to call" pill.
 * - useStartCall(cid): what every Call / Video button uses (startCall → /call?id=).
 * - useCallPeer(id) and CallLogRow (the chat's call log entries).
 */
import { router, usePathname } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Animated, Easing, Platform, Vibration, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, T, Tap, useReduceMotion } from '../components';
import { colors, shadow, withAlpha } from '../theme/tokens';
import { useCallListenHost } from './call-listen';
import { callsSupported, getCallSession, hangUp, setMinimized, syncCall, useCallSession } from './call-session';
import { answerCall, CALLS_ENABLED, CallError, endCall, getCall, startCall, useCall, useIncomingCall, type Call, type CallKind, type CallMessageMeta } from './calls';
import { callSummary, formatDuration, timeOf, type ChatPerson } from './chat';
import { ChatAvatar } from './chat-ui';
import { ringtoneFor } from './forever';
import { grantAutoAnswer, isShownNatively, nativeCallsAvailable, setNativeCallHandlers, setupNativeCalls, startTone, stopTone, subscribeNativeShown, syncNativeCall, teardownNativeCalls } from './native-call';
import { supabase } from './supabase';

/** Green used by the call designs (Accept, timer, speaking bars). */
export const CALL_GREEN = '#2EE59D';
/** Red used by the call designs (Decline, End). */
export const CALL_RED = '#E5484D';

/* ================================================================== peer */

const peerCache = new Map<string, ChatPerson>();

/** Name and avatar of the other person in a call (cached per session). */
export function useCallPeer(userId: string | null | undefined): ChatPerson | null {
  const [fetched, setFetched] = useState<ChatPerson | null>(null);
  const cached = userId ? peerCache.get(userId) : undefined;
  useEffect(() => {
    if (!userId || peerCache.has(userId)) return;
    let alive = true;
    void supabase
      .from('profiles')
      .select('id, display_name, avatar_url, username')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!data) return;
        const p = data as ChatPerson;
        peerCache.set(userId, p);
        if (alive) setFetched(p);
      });
    return () => {
      alive = false;
    };
  }, [userId]);
  if (!userId) return null;
  return cached ?? (fetched?.id === userId ? fetched : null);
}

export const peerName = (p: ChatPerson | null) => p?.display_name || (p?.username ? `@${p.username}` : '') || 'Zoyra user';

/* ================================================================== starting a call */

/**
 * Places a call from a chat. `blockedReason` (request pending / blocked) disables it with that text.
 * `start` resolves with a user-facing error message (also kept in `error`), or null once /call opened.
 */
export function useStartCall(cid: string | null | undefined, blockedReason?: string | null, opts?: { replace?: boolean }) {
  const replace = !!opts?.replace;
  const [busy, setBusy] = useState<CallKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = useCallback(
    async (kind: CallKind): Promise<string | null> => {
      const fail = (msg: string) => {
        setError(msg);
        return msg;
      };
      if (!cid || busy) return null;
      if (blockedReason) return fail(blockedReason);
      if (!callsSupported()) return fail('Calls need the latest app build.');
      setBusy(kind);
      setError(null);
      try {
        const call = await startCall(cid, kind);
        if (call.status === 'busy') return fail("They're on another call. We'll let them know you called.");
        if (replace) router.replace({ pathname: '/call', params: { id: call.id } });
        else router.push({ pathname: '/call', params: { id: call.id } });
        return null;
      } catch (e) {
        return fail(e instanceof CallError ? e.message : 'Couldn’t start the call. Try again.');
      } finally {
        setBusy(null);
      }
    },
    [cid, busy, blockedReason, replace],
  );
  return { start, busy, error, clearError: () => setError(null), enabled: CALLS_ENABLED && !!cid };
}

/* ================================================================== host */

/** Ring → heads-up banner (or native UI); minimized call → keep in sync + "Return to call" pill. Mount once (signed in). */
export function CallHost({ me }: { me: string | null | undefined }) {
  const pathname = usePathname();
  const incoming = useIncomingCall(CALLS_ENABLED ? me : null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  // Native calling (CallKit / Android call notification) for this account; sign-out stops it ringing here.
  const wasSignedIn = useRef(false);
  useEffect(() => {
    if (!CALLS_ENABLED) return;
    if (me) {
      wasSignedIn.current = true;
      void setupNativeCalls(me);
    } else if (wasSignedIn.current) {
      wasSignedIn.current = false;
      void teardownNativeCalls();
    }
  }, [me]);

  // Native Answer / Decline (CallKit, Telecom, the Android notification).
  useEffect(() => {
    if (!me) return;
    setNativeCallHandlers({
      onAnswer: (id) => {
        grantAutoAnswer(id);
        router.push({ pathname: '/call', params: { id, answer: '1' } });
      },
      onEnd: (id) => {
        void (async () => {
          const c = await getCall(id).catch(() => null);
          if (!c) return;
          if (c.status === 'ringing' && c.callee_id === me) await answerCall(id, false).catch(() => undefined);
          else if (c.status === 'accepted' || c.status === 'ringing') {
            if (getCallSession()?.callId === id) await hangUp(id, true);
            else await endCall(id).catch(() => undefined);
          }
        })();
      },
    });
    return () => setNativeCallHandlers(null);
  }, [me]);

  // A call that stopped ringing (cancelled / answered elsewhere / missed): close the native ring too.
  const lastIncoming = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastIncoming.current;
    lastIncoming.current = incoming?.id ?? null;
    if (prev && prev !== incoming?.id) void getCall(prev).then((c) => syncNativeCall(c)).catch(() => undefined);
  }, [incoming]);

  const shownNatively = useSyncExternalStore(subscribeNativeShown, () => (incoming ? isShownNatively(incoming.id) : false));
  // iOS with VoIP: CallKit rings even in the foreground; give its report a moment before showing our banner.
  const [settled, setSettled] = useState<string | null>(null);
  const incomingId = incoming?.id ?? null;
  useEffect(() => {
    if (!incomingId) return;
    const t = setTimeout(() => setSettled(incomingId), Platform.OS === 'ios' && nativeCallsAvailable() ? 1200 : 0);
    return () => clearTimeout(t);
  }, [incomingId]);

  const showBanner = !!incoming && incoming.id === settled && pathname !== '/call' && dismissed !== incoming.id && !shownNatively;

  const session = useCallSession();
  const { call } = useCall(session?.callId);
  useEffect(() => {
    syncCall(call);
    syncNativeCall(call);
  }, [call]);
  // Listening together (shared song + play / pause sync) for the active call, minimized or not.
  useCallListenHost(session && call?.id === session.callId ? call : null);

  const [now, setNow] = useState(() => Date.now());
  const showPill = !!session && pathname !== '/call';
  useEffect(() => {
    if (!showPill) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [showPill]);

  const insets = useSafeAreaInsets();
  if (showBanner && incoming) return <IncomingBanner call={incoming} onHide={() => setDismissed(incoming.id)} />;
  if (!session || !showPill) return null;
  const connected = session.connectedAt !== null;
  const label = connected ? formatDuration((now - (session.connectedAt ?? now)) / 1000) : session.phase === 'joined' || session.phase === 'joining' ? 'Connecting…' : 'Calling…';
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 6, left: 0, right: 0, alignItems: 'center' }}>
      <Tap
        onPress={() => {
          setMinimized(session.callId, false);
          router.push({ pathname: '/call', params: { id: session.callId } });
        }}
        accessibilityRole="button"
        accessibilityLabel={`Return to call, ${label}`}
        style={[
          { minHeight: 36, paddingHorizontal: 14, borderRadius: 18, backgroundColor: CALL_GREEN, flexDirection: 'row', alignItems: 'center', gap: 8 },
          shadow.sticker,
        ]}
      >
        <Icon name={session.video ? 'video' : 'call'} size={16} color="#05140D" glow={false} />
        <T size={13} weight={700} color="#05140D">
          Return to call · <T size={13} mono color="#05140D">{label}</T>
        </T>
      </Tap>
    </View>
  );
}

/* ================================================================== heads-up banner */

/**
 * CallKitBanner: heads-up card at the top while a call comes in and you're elsewhere in the app.
 * Rings (tone follows the ringer / silent switch, vibration always); tap → full-screen /call.
 */
function IncomingBanner({ call, onHide }: { call: Call; onHide: () => void }) {
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const peer = useCallPeer(call.caller_id);
  const name = peerName(peer);
  const video = call.kind === 'video';
  const [busy, setBusy] = useState(false);
  const [slide] = useState(() => new Animated.Value(reduce ? 1 : 0));
  const [pulse] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!reduce) Animated.spring(slide, { toValue: 1, useNativeDriver: true, bounciness: 8, speed: 14 }).start();
    const loop = reduce ? null : Animated.loop(Animated.sequence([Animated.timing(pulse, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }), Animated.timing(pulse, { toValue: 0, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true })]));
    loop?.start();
    void startTone('ring', ringtoneFor(call.caller_id)); // gold chime for Forever friends
    Vibration.vibrate([0, 700, 1300], true);
    return () => {
      loop?.stop();
      stopTone();
      Vibration.cancel();
    };
  }, [reduce, slide, pulse, call.caller_id]);

  const open = (answer: boolean) => {
    onHide();
    if (answer) grantAutoAnswer(call.id);
    router.push({ pathname: '/call', params: answer ? { id: call.id, answer: '1' } : { id: call.id } });
  };
  const decline = async () => {
    if (busy) return;
    setBusy(true);
    stopTone();
    Vibration.cancel();
    await answerCall(call.id, false).catch(() => undefined);
    onHide();
  };

  const what = video ? 'Incoming Zoyra video call' : 'Incoming Zoyra voice call';
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 6, left: 10, right: 10 }}>
      <Animated.View style={{ opacity: slide, transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [-120, 0] }) }] }}>
        <Tap
          onPress={() => open(false)}
          pressScale={0.98}
          accessibilityRole="button"
          accessibilityLabel={`${name}. ${what}. Opens the call`}
          style={[
            { borderRadius: 30, paddingVertical: 14, paddingHorizontal: 16, backgroundColor: 'rgba(32,32,32,0.96)', borderWidth: 1, borderColor: withAlpha(colors.white, 0.16), flexDirection: 'row', alignItems: 'center', gap: 12 },
            shadow.sticker,
          ]}
        >
          <View>
            <ChatAvatar person={peer} size={50} radius={17} />
            <View style={{ position: 'absolute', right: -3, bottom: -3, width: 20, height: 20, borderRadius: 10, backgroundColor: CALL_GREEN, borderWidth: 2, borderColor: '#202020', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={video ? 'video' : 'call'} size={10} color="#05140D" glow={false} />
            </View>
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T size={16} weight={700} numberOfLines={1}>
              {name}
            </T>
            <Animated.View style={{ opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.55] }) }}>
              <T size={13} color="#E5E5E5" numberOfLines={1} accessibilityLiveRegion="polite">
                {what}
              </T>
            </Animated.View>
          </View>
          <Tap onPress={() => void decline()} accessibilityRole="button" accessibilityLabel="Decline" accessibilityState={{ busy }} hitSlop={4} style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: '#E5253B', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="hangup" size={22} color={colors.white} glow={false} />
          </Tap>
          <Tap onPress={() => open(true)} accessibilityRole="button" accessibilityLabel="Accept" hitSlop={4} style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: CALL_GREEN, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={video ? 'video' : 'call'} size={22} color="#05140D" glow={false} />
          </Tap>
        </Tap>
      </Animated.View>
    </View>
  );
}

/* ================================================================== call log row */

/** Centered system row for a `kind: 'call'` message; tap to call back. */
export function CallLogRow({ meta, mine, at, onCallBack }: { meta: CallMessageMeta; mine: boolean; at: string; onCallBack?: (kind: CallKind) => void }) {
  const missed = meta.status !== 'ended';
  // The server posts the log entry as the caller; "missed" only reads red for the person who missed it.
  const tint = missed && !mine ? colors.error : colors.text;
  const text = meta.status === 'ended' ? callSummary(meta) : mine ? (meta.status === 'declined' ? `${meta.kind === 'video' ? 'Video' : 'Voice'} call declined` : `${meta.kind === 'video' ? 'Video' : 'Voice'} call · No answer`) : callSummary(meta);
  return (
    <Tap
      onPress={onCallBack ? () => onCallBack(meta.kind) : undefined}
      accessibilityRole="button"
      accessibilityLabel={`${text}, ${timeOf(at)}`}
      accessibilityHint={onCallBack ? 'Calls back' : undefined}
      pressScale={0.98}
      style={{
        alignSelf: 'center',
        minHeight: 44,
        paddingHorizontal: 14,
        borderRadius: 22,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: withAlpha(colors.white, 0.06),
        borderWidth: 1,
        borderColor: withAlpha(colors.white, 0.12),
        maxWidth: '90%',
      }}
    >
      <View style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: withAlpha(missed && !mine ? colors.error : CALL_GREEN, 0.16) }}>
        <Icon name={meta.kind === 'video' ? 'video' : 'call'} size={15} color={missed && !mine ? colors.error : CALL_GREEN} />
      </View>
      <T size={13} weight={600} color={tint} numberOfLines={1} style={{ flexShrink: 1 }}>
        {text}
      </T>
      <T size={11} color={colors.textSecondary}>
        {timeOf(at)}
      </T>
    </Tap>
  );
}
