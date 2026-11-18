import NetInfo, { useNetInfo, type NetInfoState } from '@react-native-community/netinfo';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Icon, ModalCard, T } from '../components';
import { useDownloads } from '../state/downloads';
import { usePlayerPick } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';

const isOnline = (s: Pick<NetInfoState, 'isConnected' | 'isInternetReachable'>) => s.isConnected === true && s.isInternetReachable !== false;

const leave = () => (router.canGoBack() ? router.back() : router.replace('/'));

export default function Offline() {
  const net = useNetInfo();
  const [checking, setChecking] = useState(false);
  const [stillOffline, setStillOffline] = useState(false);
  const online = isOnline(net);
  const dl = useDownloads();
  const player = usePlayerPick();
  const count = dl.list.length;

  const playDownloads = () => {
    if (!count) return;
    // Downloaded tracks play from their local files, so this works with no connection.
    player.playTracks(
      dl.list.map((e) => e.track),
      0,
      'Downloads',
    );
    router.replace('/player');
  };

  const retry = async () => {
    if (checking) return;
    setChecking(true);
    setStillOffline(false);
    try {
      const state = await NetInfo.refresh();
      if (isOnline(state)) leave();
      else setStillOffline(true);
    } catch {
      setStillOffline(true);
    } finally {
      setChecking(false);
    }
  };

  const status = online
    ? 'You are back online.'
    : net.isConnected === null
      ? 'Checking your connection…'
      : net.isConnected
        ? `Connected to ${net.type === 'wifi' ? 'Wi-Fi' : net.type}, but the internet is not reachable.`
        : 'No network connection.';

  return (
    <ModalCard>
      <View style={{ alignItems: 'center', gap: 16, paddingTop: 4 }}>
        <View
          style={{
            width: 72,
            height: 72,
            borderRadius: 36,
            backgroundColor: online ? colors.accentTint : withAlpha(colors.error, 0.16),
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={online ? 'check' : 'wifiOff'} size={34} color={online ? colors.success : colors.error} />
        </View>
        <T size={22} weight={700} tracking={-0.3} align="center" accessibilityRole="header">
          {online ? 'You are online' : 'You are offline'}
        </T>
        <T size={15} lineHeight={22} color={colors.textSecondary} align="center">
          {online ? 'Your connection is back. Pick up where you left off.' : 'Zoyra switched to offline mode. Your downloaded music still plays.'}
        </T>
        <T size={13} color={stillOffline ? colors.error : colors.textSecondary} align="center" accessibilityLiveRegion="polite">
          {stillOffline ? 'Still offline. Check Wi-Fi or mobile data and try again.' : status}
        </T>
        <View style={{ gap: 8, alignSelf: 'stretch' }}>
          <Button label={online ? 'Continue' : checking ? 'Checking…' : 'Try again'} onPress={() => (online ? leave() : void retry())} />
          {count > 0 ? <Button label={`Play downloads · ${count} ${count === 1 ? 'song' : 'songs'}`} icon="play" variant="glass" onPress={playDownloads} /> : null}
          <Button label={count > 0 ? 'Go to downloads' : 'No downloads yet · Go to downloads'} variant="glass" onPress={() => router.replace('/downloads')} />
        </View>
      </View>
    </ModalCard>
  );
}
