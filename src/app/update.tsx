import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';

import { Button, Gradient, Icon, ModalCard, Row, T, useAsync } from '../components';
import { checkForUpdate, installedVersion } from '../lib/updates';
import { colors } from '../theme/tokens';

const titles = { up_to_date: "You're up to date", available: 'Update available', required: 'Update required' } as const;

export default function Update() {
  const check = useAsync(checkForUpdate, []);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const info = check.data;
  const required = info?.status === 'required';
  const home = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const openStore = async () => {
    if (!info?.storeUrl || opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      await Linking.openURL(info.storeUrl);
    } catch {
      setOpenError('Could not open the store. Update Zoyra from your app store.');
    } finally {
      setOpening(false);
    }
  };

  const title = check.loading && !info ? 'Checking for updates' : check.error ? 'Could not check for updates' : info ? titles[info.status] : "You're up to date";
  const sub = info && info.status !== 'up_to_date' ? `Version ${info.latest}` : `Version ${info?.installed ?? installedVersion()}`;

  return (
    <ModalCard onDismiss={required ? () => {} : home}>
      <Row>
        <Gradient colors={[colors.accent, colors.amber]} style={{ width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' }}>
          {check.loading && !info ? <ActivityIndicator color={colors.onAccent} /> : <Icon name={info?.status === 'up_to_date' || (!info && !check.error) ? 'check' : 'bolt'} size={26} color={colors.onAccent} />}
        </Gradient>
        <View style={{ gap: 2, flex: 1 }}>
          <T size={20} weight={700} accessibilityRole="header">
            {title}
          </T>
          <T mono size={12} color={colors.textSecondary}>
            {sub}
          </T>
        </View>
      </Row>

      {check.error ? (
        <T size={14} color={colors.textSecondary} lineHeight={20} accessibilityLiveRegion="polite">
          {check.error}
        </T>
      ) : null}

      {info && info.status !== 'up_to_date' && info.notes.length ? (
        <View style={{ gap: 10 }}>
          {info.notes.map((n) => (
            <T key={n} size={15} lineHeight={21}>
              {n}
            </T>
          ))}
        </View>
      ) : null}

      {info ? (
        <T size={12} color={colors.textSecondary} lineHeight={17}>
          {info.status === 'required'
            ? `You have version ${info.installed}. This version is no longer supported; update to ${info.latest} to keep listening.`
            : info.status === 'available'
              ? `You have version ${info.installed}.`
              : `Version ${info.installed} is the latest.`}
          {info.status !== 'up_to_date' && !info.storeUrl ? ' Update Zoyra from your app store.' : ''}
        </T>
      ) : null}

      {openError ? (
        <T size={13} color={colors.error} accessibilityLiveRegion="polite">
          {openError}
        </T>
      ) : null}

      <Row>
        {check.error ? (
          <>
            <Button label="Close" variant="glass" style={{ flex: 1 }} onPress={home} />
            <Button label="Try again" style={{ flex: 1 }} onPress={check.reload} />
          </>
        ) : info && info.status !== 'up_to_date' ? (
          <>
            {required ? null : <Button label="Later" variant="glass" style={{ flex: 1 }} onPress={home} />}
            <Button
              label={opening ? 'Opening…' : 'Open store'}
              variant={info.storeUrl && !opening ? 'primary' : 'disabled'}
              style={{ flex: 1 }}
              onPress={() => void openStore()}
            />
          </>
        ) : (
          <Button label="Done" variant={check.loading && !info ? 'glass' : 'primary'} style={{ flex: 1 }} onPress={home} />
        )}
      </Row>
    </ModalCard>
  );
}
