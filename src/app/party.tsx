import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Cover, ErrorState, Glass, IconButton, LiveDot, Loading, Row, Screen, ScreenHeader, SectionHeader, T, Tap } from '../components';
import { colors } from '../theme/tokens';
import { FloatingReactions, JoinByCode, PersonAvatar, QueueAdder, ReactionBar, RoomEnded, RoomLobby, RoomNote, RoomQR, RoomQueue, useRoom } from './group-listening';

const backdrop = {
  pattern: 'dots' as const,
  mesh: 'none' as const,
  glows: [
    { x: 0.5, y: 0, color: colors.violet, opacity: 0.34 },
    { x: 0, y: 0.6, color: colors.accent, opacity: 0.22 },
  ],
};

export default function Party() {
  const { id: rawId, code: rawCode } = useLocalSearchParams<{ id?: string; code?: string }>();
  const id = typeof rawId === 'string' && rawId ? rawId : undefined;
  const code = typeof rawCode === 'string' && rawCode.trim() ? rawCode : undefined;
  if (!id) {
    return (
      <Screen top={4} gap={16} backdrop={backdrop}>
        <ScreenHeader title="Party mode" />
        {code ? <JoinByCode kind="party" code={code} /> : <RoomLobby kind="party" />}
      </Screen>
    );
  }
  return <PartyRoom id={id} />;
}

function PartyRoom({ id }: { id: string }) {
  const api = useRoom(id);
  const { room, members, online, isHost } = api;
  const [settings, setSettings] = useState(false);

  if (api.loading || api.error || !room) {
    return (
      <Screen top={4} gap={16} backdrop={backdrop}>
        <ScreenHeader title="Party mode" />
        {api.loading ? <Loading /> : <ErrorState message={api.error ?? 'Party not found'} onRetry={() => void api.reload()} />}
      </Screen>
    );
  }
  if (!room.is_open) {
    return (
      <Screen top={4} gap={16} backdrop={backdrop}>
        <ScreenHeader title="Party mode" />
        <RoomEnded />
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <Screen top={4} gap={16} backdrop={backdrop}>
        <ScreenHeader title="Party mode" right={<IconButton icon={settings ? 'close' : 'sliders'} label="Settings" onPress={() => setSettings((s) => !s)} />} />

        {settings ? (
          <Glass padding={14}>
            <View style={{ gap: 4 }}>
              <T size={16} weight={600} numberOfLines={1}>
                {room.name}
              </T>
              <T size={13} color={colors.textSecondary}>
                {isHost ? 'You are the host. Your playback is what everyone hears.' : 'The host controls playback. Add songs and vote below.'}
              </T>
            </View>
          </Glass>
        ) : null}

        {/* Scannable join QR + code */}
        <View style={{ alignItems: 'center', gap: 12 }}>
          <RoomQR kind="party" code={room.code} onPress={() => void api.copyCode()} />
          <Tap onPress={() => void api.copyCode()} style={{ alignItems: 'center', gap: 2 }} accessibilityLabel={`Copy code ${room.code}`}>
            <T size={12} tracking={0.2} color={colors.textSecondary}>
              Guests scan or enter this code · tap to copy
            </T>
            <T mono size={24} selectable>
              {room.code}
            </T>
          </Tap>
        </View>

        {/* Guests */}
        <Glass padding={12}>
          <Row gap={12}>
            <Row gap={0}>
              {members.slice(0, 5).map((m, i) => (
                <View key={m.user_id} style={{ marginLeft: i === 0 ? 0 : -10, borderWidth: 2, borderColor: online.has(m.user_id) ? colors.success : colors.bgSecondary, borderRadius: 28 }}>
                  <PersonAvatar p={m.profiles} size={36} />
                </View>
              ))}
            </Row>
            <T size={14} color={colors.textSecondary} style={{ flex: 1 }}>
              {members.length} {members.length === 1 ? 'guest' : 'guests'} joined
            </T>
            {room.is_playing ? <LiveDot /> : null}
          </Row>
        </Glass>

        {room.track ? (
          <Glass padding={12}>
            <Row gap={12}>
              <Cover artwork={room.track.artwork} id={room.track.id} size={44} radius={14} />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <T size={16} weight={600} numberOfLines={1}>
                  {room.track.title}
                </T>
                <T size={14} color={colors.textSecondary} numberOfLines={1}>
                  {room.track.artist.name}
                </T>
              </View>
              <Button
                label={isHost ? 'Skip' : `Skip ${room.skip_votes}/${Math.floor(Math.max(1, members.length) / 2) + 1}`}
                variant={api.votedTrack === room.track.id ? 'disabled' : 'glass'}
                height={40}
                onPress={() => void api.voteSkip()}
              />
            </Row>
          </Glass>
        ) : null}

        <ReactionBar onReact={api.react} />

        <SectionHeader title="Shared queue" />
        <Glass padding={4}>
          <RoomQueue api={api} />
        </Glass>
        <QueueAdder api={api} />

        <RoomNote api={api} />

        <Row gap={12}>
          <Button label="Invite friends" style={{ flex: 1 }} onPress={() => void api.share()} />
          <Button label={isHost ? 'End party' : 'Leave party'} variant="glass" style={{ flex: 1 }} onPress={() => void (isHost ? api.end() : api.leave())} />
        </Row>
      </Screen>
      <FloatingReactions list={api.reactions} />
    </View>
  );
}
