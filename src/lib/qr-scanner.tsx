import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import { Linking, Modal, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton, LinkText, Loading, Row, T, Toast } from '../components';
import { colors } from '../theme/tokens';
import { appPathFromShareUrl } from './share-links';

/** Zoyra share links (https://<share host>/u/…) and zoyra:// links open in the app; anything else is rejected. */
export function routeFromCode(data: string): string | null {
  const shared = appPathFromShareUrl(data);
  if (shared) return shared;
  const m = /^zoyra:\/\/\/?(.+)$/i.exec(data.trim());
  return m ? `/${m[1]}` : null;
}

export function Scanner({ onClose, onRoute, title = 'Scan a profile code', caption = 'Point at a friend’s Zoyra profile code.' }: { onClose: () => void; onRoute: (path: string) => void; title?: string; caption?: string }) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [hint, setHint] = useState<string | null>(null);
  const locked = useRef(false);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission?.granted]);

  const onScan = (r: BarcodeScanningResult) => {
    if (locked.current) return;
    locked.current = true;
    const path = routeFromCode(r.data);
    if (path) return onRoute(path);
    setHint('That code isn’t a Zoyra link.');
    setTimeout(() => (locked.current = false), 1500);
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {permission?.granted ? (
          <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScan} />
        ) : null}
        <View style={{ flex: 1, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24, paddingHorizontal: 16, justifyContent: 'space-between' }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={18} weight={700} accessibilityRole="header">
              {title}
            </T>
            <IconButton icon="close" label="Close scanner" bg={colors.chipGhost} onPress={onClose} />
          </Row>
          {!permission ? (
            <Loading label="Opening camera" />
          ) : !permission.granted ? (
            <View style={{ gap: 12, alignItems: 'center' }}>
              <T size={16} align="center">
                Camera access is needed to scan codes.
              </T>
              <LinkText
                label={permission.canAskAgain ? 'Allow camera' : 'Open Settings'}
                onPress={() => (permission.canAskAgain ? void requestPermission() : void Linking.openSettings().catch(() => {}))}
              />
            </View>
          ) : (
            <View style={{ alignSelf: 'center', width: 240, height: 240, borderRadius: 36, borderWidth: 4, borderColor: colors.accent }} />
          )}
          <View style={{ gap: 8 }}>
            {hint ? <Toast icon="info" iconColor={colors.amber} message={hint} /> : null}
            <T size={13} color={colors.textSecondary} align="center">
              {caption}
            </T>
          </View>
        </View>
      </View>
    </Modal>
  );
}

