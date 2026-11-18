import * as Device from 'expo-device';
import { useState } from 'react';
import { Linking, Platform, View } from 'react-native';

import { Glass, Icon, ListGroup, ListRow, Overline, Row, Screen, ScreenHeader, T, Toast } from '../components';
import { useConnection } from '../lib/network';
import { usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

const deviceName = () => Device.deviceName ?? Device.modelName ?? (Platform.OS === 'web' ? 'This browser' : 'This phone');

export default function DevicesConnect() {
  const conn = useConnection();
  const { track, playing } = usePlayerPick('track', 'playing');
  const [error, setError] = useState<string | null>(null);

  const openBluetooth = async () => {
    setError(null);
    try {
      if (Platform.OS === 'android') await Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS');
      else await Linking.openSettings();
    } catch {
      setError(Platform.OS === 'android' ? 'Could not open Bluetooth settings. Open them from your phone’s Settings app.' : 'Could not open Settings.');
    }
  };

  const status = track ? `${playing ? 'Playing' : 'Paused'} · ${track.title}` : 'Nothing playing';

  return (
    <Screen top={4} gap={16} bottom={24} backdrop={{ pattern: 'none', mesh: 'coral' }}>
      <ScreenHeader title="Devices" />

      <View style={{ gap: 8 }}>
        <Overline color={colors.textSecondary}>THIS DEVICE</Overline>
        <Glass padding={16} radius={28}>
          <Row gap={14}>
            <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="phone" size={24} color={colors.onAccent} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <T size={16} weight={600} numberOfLines={1}>
                {deviceName()}
              </T>
              <T size={13} color={colors.textSecondary} numberOfLines={1}>
                {status}
              </T>
            </View>
          </Row>
        </Glass>
      </View>

      <ListGroup title="CONNECTION">
        <ListRow
          title={conn.known ? conn.label : 'Checking connection'}
          subtitle={conn.known ? [conn.detail, conn.ssid].filter(Boolean).join(' · ') : 'Waiting for the network'}
          icon={conn.online ? 'wifi' : 'wifiOff'}
          href="/net-status"
        />
        <ListRow title="Data usage" subtitle="Streaming on Wi-Fi and mobile data" icon="chart" href="/data-usage" divider />
      </ListGroup>

      <ListGroup title="AUDIO OUTPUT">
        {Platform.OS === 'web' ? null : (
          <ListRow
            title={Platform.OS === 'android' ? 'Open Bluetooth settings' : 'Open Settings'}
            subtitle={Platform.OS === 'android' ? 'Pair headphones, speakers or your car' : 'Pair Bluetooth devices in Settings › Bluetooth'}
            icon="speaker"
            onPress={() => void openBluetooth()}
          />
        )}
        <ListRow title="Car mode" subtitle="Big buttons and voice control for driving" icon="car" href="/car-mode" divider={Platform.OS !== 'web'} />
      </ListGroup>

      <Glass padding={14}>
        <Row gap={10} align="flex-start">
          <Icon name="cast" size={18} color={colors.textSecondary} />
          <T size={13} color={colors.textSecondary} style={{ flex: 1 }}>
            Casting, AirPlay pickers and playing on other devices aren’t available in this version. Zoyra plays through whatever your phone is connected to, so pair a Bluetooth speaker or use
            {Platform.OS === 'ios' ? ' Control Center’s AirPlay button' : ' your phone’s output switcher'} to choose where sound goes.
          </T>
        </Row>
      </Glass>

      {error ? <Toast icon="info" iconColor={colors.error} message={error} /> : null}
    </Screen>
  );
}
