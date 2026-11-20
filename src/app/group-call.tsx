import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, T, Tap, useAsync } from '../components';
import type { IconName } from '../components/icons';
import { loadAgora } from '../lib/agora';
import { CALL_RED } from '../lib/call-ui';
import { formatDuration } from '../lib/chat';
import { ChatAvatar } from '../lib/chat-ui';
import {
  endGroupCall,
  flipGroupCamera,
  GROUP_CALL_MAX,
  joinGroupCallSession,
  leaveGroupCallSession,
  markGroupCallOver,
  toggleGroupCamera,
  toggleGroupMute,
  toggleGroupSpeaker,
  useGroupCallRoom,
  useGroupCallSession,
  type GroupCallSession,
} from '../lib/group-calls';
import { firstName, loadGroupMembers, type GroupMember } from '../lib/groups';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

const GAP = 10;

/** Seconds on the call, ticking once a second. */
function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
}

type Tile = { key: string; uid: number; me: boolean; member: GroupMember | undefined; video: boolean; speaking: boolean; muted: boolean };

/**
 * Group call (`/group-call?id=<group call id>`): participant grid, mute / camera / speaker / flip / leave.
 * Opening the screen joins the room (join late works the same way); leaving the screen leaves the call.
 * The starter or a group admin can also end it for everyone. Backend: src/lib/group-calls.ts.
 */
export default function GroupCallScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const { user } = useAuth();
  const me = user?.id ?? '';
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const agora = loadAgora();
  const room = useGroupCallRoom(id || null);
  const s = useGroupCallSession();
  const mine = s && s.callId === id ? s : null;
  const cid = room.call?.conversation_id ?? '';
  const members = useAsync(() => (cid ? loadGroupMembers(cid) : Promise.resolve([] as GroupMember[])), [cid], 'app/group-call:62');
  const byUser = useMemo(() => new Map((members.data ?? []).map((m) => [m.user_id, m])), [members.data]);
  const live = room.call?.status === 'live';
  const ended = !!room.call && !live;
  const elapsed = useElapsed(mine?.connectedAt ?? null);

  // Join once the room is known to be live; leaving the screen leaves the call.
  const call = room.call;
  useEffect(() => {
    if (!call || call.status !== 'live') return;
    void joinGroupCallSession(call);
  }, [call]);
  useEffect(() => {
    if (!id) return;
    return () => void leaveGroupCallSession();
  }, [id]);
  // The room ended for everyone (starter / admin ended it, or the last person left).
  useEffect(() => {
    if (ended && id) markGroupCallOver(id);
  }, [ended, id]);

  const tiles: Tile[] = useMemo(() => {
    const out: Tile[] = [{ key: 'me', uid: 0, me: true, member: byUser.get(me), video: !!mine?.video, speaking: !!mine?.mySpeaking, muted: !!mine?.muted }];
    for (const p of room.people) {
      if (p.user_id === me) continue;
      const r = mine?.remote[p.agora_uid];
      out.push({ key: p.user_id, uid: p.agora_uid, me: false, member: byUser.get(p.user_id), video: !!r?.video, speaking: !!r?.speaking, muted: !!r?.muted });
    }
    return out;
  }, [room.people, byUser, me, mine]);

  const cols = tiles.length <= 1 ? 1 : 2;
  const tileW = Math.floor((width - 32 - GAP * (cols - 1)) / cols);
  const tileH = tiles.length <= 1 ? Math.round(tileW * 1.2) : tiles.length <= 4 ? Math.round(tileW * 1.15) : Math.round(tileW * 0.95);

  const leave = () => {
    void leaveGroupCallSession();
    if (router.canGoBack()) router.back();
    else router.replace('/messages');
  };
  const endForAll = () => {
    Alert.alert('End call for everyone?', 'Everyone in the call is disconnected.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'End for everyone', style: 'destructive', onPress: () => void endGroupCall(id).catch(() => undefined).finally(leave) },
    ]);
  };

  const canEndAll = !!call && live && call.started_by === me;
  const status = ended || mine?.over ? 'Call ended' : mine?.error ? mine.error : !mine || mine.phase === 'preparing' || mine.phase === 'joining' ? 'Connecting…' : formatDuration(elapsed);

  if (!id || room.error) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 }}>
        <T size={16} color={colors.textSecondary} align="center">
          {room.error ?? 'This call is no longer available.'}
        </T>
        <Control icon="close" label="Close" onPress={leave} />
      </View>
    );
  }

  const done = ended || !!mine?.over;
  const unsupported = !agora || !!mine?.unsupported;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 12 }}>
      <View style={{ paddingHorizontal: 16, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name={mine?.encrypted ? 'lock' : call?.kind === 'video' ? 'video' : 'call'} size={14} color={colors.textSecondary} />
          <T size={13} color={colors.textSecondary} style={{ flex: 1 }}>
            {`Group ${call?.kind === 'video' ? 'video' : 'voice'} call · ${tiles.length} of ${GROUP_CALL_MAX}`}
          </T>
          {!done && !mine?.error && mine?.phase !== 'joined' ? <ActivityIndicator size="small" color={colors.textSecondary} /> : null}
        </View>
        <T size={22} weight={700} accessibilityLiveRegion="polite" color={mine?.error ? colors.amber : colors.text}>
          {unsupported ? 'Calls need the latest app build' : status}
        </T>
      </View>

      <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignContent: 'center', justifyContent: 'center', gap: GAP, padding: 16 }}>
        {tiles.map((t) => (
          <ParticipantTile key={t.key} t={t} w={tileW} h={tileH} agora={agora} sess={mine} />
        ))}
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 14, paddingHorizontal: 16 }}>
        <Control icon="micOff" label={mine?.muted ? 'Unmute' : 'Mute'} on={!!mine?.muted} disabled={done || unsupported} onPress={toggleGroupMute} />
        <Control icon={mine?.video ? 'video' : 'videoOff'} label={mine?.video ? 'Camera off' : 'Camera on'} on={!!mine?.video} disabled={done || unsupported} onPress={() => void toggleGroupCamera()} />
        {mine?.video ? <Control icon="flipCamera" label="Flip camera" disabled={done} onPress={flipGroupCamera} /> : null}
        <Control icon="speaker" label="Speaker" on={!!mine?.speaker} disabled={done || unsupported} onPress={toggleGroupSpeaker} />
        <Control icon="hangup" label={done ? 'Close' : 'Leave call'} danger onPress={leave} />
      </View>
      {canEndAll ? (
        <Tap onPress={endForAll} accessibilityRole="button" accessibilityLabel="End call for everyone" style={{ alignSelf: 'center', minHeight: 44, justifyContent: 'center', marginTop: 8 }}>
          <T size={13} weight={600} color={colors.textSecondary}>
            End for everyone
          </T>
        </Tap>
      ) : null}
    </View>
  );
}

function ParticipantTile({ t, w, h, agora, sess }: { t: Tile; w: number; h: number; agora: ReturnType<typeof loadAgora>; sess: GroupCallSession | null }) {
  const name = t.me ? 'You' : firstName(t.member?.display_name);
  const showVideo = t.video && !!agora && !!sess && sess.phase !== 'idle';
  const person = t.member ? { id: t.member.user_id, display_name: t.member.display_name, avatar_url: t.member.avatar_url, username: t.member.username } : null;
  return (
    <View
      accessible
      accessibilityLabel={`${name}${t.speaking ? ', speaking' : ''}${t.muted ? ', muted' : ''}${t.video ? ', video on' : ''}`}
      style={{
        width: w,
        height: h,
        borderRadius: 24,
        overflow: 'hidden',
        backgroundColor: colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 2,
        borderColor: t.speaking ? colors.accent : withAlpha(colors.white, 0.08),
      }}
    >
      {showVideo && agora ? (
        <agora.RtcSurfaceView style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} canvas={{ uid: t.me ? 0 : t.uid, renderMode: 1 }} />
      ) : (
        <ChatAvatar person={person} size={Math.min(88, Math.round(w * 0.42))} radius={Math.min(88, Math.round(w * 0.42)) / 2} />
      )}
      <View style={{ position: 'absolute', left: 8, bottom: 8, right: 8, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <View style={{ maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, minHeight: 26, borderRadius: 13, backgroundColor: withAlpha(colors.black, 0.55) }}>
          {t.muted ? <Icon name="micOff" size={12} color={colors.error} glow={false} /> : null}
          <T size={12} weight={600} numberOfLines={1}>
            {name}
          </T>
        </View>
      </View>
    </View>
  );
}

function Control({ icon, label, onPress, on, danger, disabled }: { icon: IconName; label: string; onPress: () => void; on?: boolean; danger?: boolean; disabled?: boolean }) {
  return (
    <Tap
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on, disabled }}
      pressScale={0.92}
      style={{
        width: 56,
        height: 56,
        borderRadius: 28,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : 1,
        backgroundColor: danger ? CALL_RED : on ? colors.white : withAlpha(colors.white, 0.12),
      }}
    >
      <Icon name={icon} size={24} color={danger ? colors.white : on ? colors.bg : colors.text} glow={false} />
    </Tap>
  );
}
