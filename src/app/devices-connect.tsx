import * as Device from 'expo-device';
import { useState } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';

import { LinearGradient } from 'expo-linear-gradient';
import { Cover, Icon, IconButton, Row, Screen, T, Toast } from '../components';
import { IconChip, Panel, PanelRow, SectionLabel } from '../components/settings-ui';
import { useConnection } from '../lib/network';
import { usePlayerPick } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';

const backdrop = {
  pattern: 'dots' as const,
  mesh: 'none' as const,
  glows: [
    { x: 0, y: 0, color: colors.accent, opacity: 0.4 },
    { x: 1, y: 0.35, color: colors.amber, opacity: 0.22 },
  ],
};

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
    <Screen top={4} gap={14} bottom={24} backdrop={backdrop}>
      <Row gap={10}>
        <IconButton icon="back" label="Back" href="back" />
        {track ? <Cover artwork={track.artwork} id={track.id} size={44} radius={22} /> : <IconChip icon="speaker" size={44} />}
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={17} weight={700} accessibilityRole="header" numberOfLines={1}>
            Connect to a device
          </T>
          <T size={12} color={colors.accentLight} numberOfLines={1}>
            Choose where Zoyra plays
          </T>
        </View>
      </Row>

      <SectionLabel>Playing on</SectionLabel>
      <View style={{ borderRadius: 32, borderWidth: 1, borderColor: withAlpha(colors.accent, 0.55), overflow: 'hidden' }}>
        <LinearGradient colors={[withAlpha(colors.accent, 0.3), 'rgba(20,20,20,0.6)']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} pointerEvents="none" />
        <Row gap={14} style={{ padding: 14 }}>
          <View style={{ width: 46, height: 46, borderRadius: 26, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="phone" size={22} color={colors.onAccent} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <T size={16} weight={600} numberOfLines={1}>
              {deviceName()}
            </T>
            <T size={12} color={colors.accentLight} numberOfLines={1}>
              {status}
            </T>
          </View>
          <View style={{ height: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: withAlpha(colors.white, 0.1), alignItems: 'center', justifyContent: 'center' }}>
            <T size={11} weight={700}>
              {conn.known ? (conn.online ? conn.label : 'Offline') : '...'}
            </T>
          </View>
        </Row>
      </View>

      <SectionLabel>Available</SectionLabel>
      <Panel radius={26} padding={{ v: 4, h: 12 }}>
        {Platform.OS === 'web' ? null : (
          <PanelRow
            title={Platform.OS === 'android' ? 'Bluetooth speakers and headphones' : 'Speakers and headphones'}
            subtitle={Platform.OS === 'android' ? 'Pair and pick one in Bluetooth settings' : 'Pair in Settings › Bluetooth'}
            icon="speaker"
            onPress={() => void openBluetooth()}
            minHeight={64}
          />
        )}
        <PanelRow title="Car mode" subtitle="Big buttons and voice control for driving" icon="car" href="/car-mode" divider={Platform.OS !== 'web'} minHeight={64} />
        <PanelRow
          title={conn.known ? conn.label : 'Checking connection'}
          subtitle={conn.known ? [conn.detail, conn.ssid].filter(Boolean).join(' · ') : 'Waiting for the network'}
          icon={conn.online ? 'wifi' : 'wifiOff'}
          href="/net-status"
          divider
          minHeight={64}
        />
        <PanelRow title="Data usage" subtitle="Streaming on Wi-Fi and mobile data" icon="chart" href="/data-usage" divider minHeight={64} />
      </Panel>

      <T size={12} color={colors.textSecondary} align="center">
        Zoyra plays through whatever your phone is connected to. Use
        {Platform.OS === 'ios' ? ' Control Center’s AirPlay button' : ' your phone’s output switcher'} to choose where sound goes.
      </T>

      {error ? <Toast icon="info" iconColor={colors.error} message={error} /> : null}
    </Screen>
  );
}
