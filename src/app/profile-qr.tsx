import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Button, EmptyState, Gradient, IconButton, LinkText, ModalCard, Row, T, Toast } from '../components';
import { FramedAvatar, useProfileCustom, violet } from '../lib/profile-custom';
import { Scanner } from '../lib/qr-scanner';
import { profileShareUrl, shareContent } from '../lib/share-links';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

type SvgRef = { toDataURL: (cb: (base64: string) => void) => void };
type Note = { text: string; error?: boolean };

export default function ProfileQR() {
  const { user, profile } = useAuth();
  const { custom } = useProfileCustom();
  const svg = useRef<SvgRef | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 2600);
    return () => clearTimeout(id);
  }, [note]);

  if (!user) {
    return (
      <ModalCard>
        <EmptyState icon="users" title="Sign in to share your profile" action="Sign in" href="/login" />
      </ModalCard>
    );
  }

  // https link: phone cameras open it too (app if installed, otherwise the web card).
  const link = profileShareUrl({ id: user.id, username: profile?.username });
  const name = profile?.display_name || 'You';

  const share = async () => {
    try {
      await shareContent({ url: link, title: `${name} on Zoyra`, message: `Follow ${name} on Zoyra` });
    } catch {
      setNote({ text: 'Could not open the share sheet', error: true });
    }
  };

  const copy = async () => {
    try {
      await Clipboard.setStringAsync(link);
      setNote({ text: 'Profile link copied' });
    } catch {
      setNote({ text: 'Could not copy the link', error: true });
    }
  };

  /** Render the QR to a PNG and hand it to the system share sheet (which offers Save Image). */
  const saveImage = async () => {
    if (saving) return;
    const ref = svg.current;
    if (!ref) return setNote({ text: 'The code is still drawing. Try again.', error: true });
    setSaving(true);
    try {
      if (!(await Sharing.isAvailableAsync())) throw new Error('Saving images isn’t available on this device.');
      const base64 = await new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Could not draw the code')), 5000);
        ref.toDataURL((b) => {
          clearTimeout(t);
          resolve(b);
        });
      });
      const file = new File(Paths.cache, 'zoyra-profile-code.png');
      if (file.exists) file.delete();
      file.create();
      await file.write(base64, { encoding: 'base64' });
      await Sharing.shareAsync(file.uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: 'Save your Zoyra code' });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Could not save the image', error: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalCard gap={16}>
      <Row gap={12}>
        <FramedAvatar uri={profile?.avatar_url} id={user.id} name={name} preset={custom.avatar_art} frame={custom.avatar_frame} size={48} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={16} weight={700} numberOfLines={1}>
            {name}
          </T>
          <T size={13} color={colors.textSecondary} numberOfLines={1}>
            {profile?.username ? `@${profile.username} on Zoyra` : 'on Zoyra'}
          </T>
        </View>
        <IconButton icon="close" label="Close" onPress={() => router.back()} />
      </Row>

      <View style={{ alignSelf: 'center', padding: 14, borderRadius: 36, backgroundColor: colors.white }} accessible accessibilityRole="image" accessibilityLabel="Your profile QR code">
        <QRCode
          value={link}
          size={200}
          color={colors.bg}
          backgroundColor={colors.white}
          ecl="H"
          getRef={(c: SvgRef | null) => {
            svg.current = c;
          }}
        />
        <View pointerEvents="none" style={styles.logoWrap}>
          <Gradient colors={[colors.accent, violet]} style={styles.logo} />
        </View>
      </View>

      <T size={13} color={colors.textSecondary} align="center">
        {profile?.is_private ? 'Your profile is private. People who scan this can ask to follow you.' : 'Friends can scan this code to follow you'}
      </T>

      <Row gap={10}>
        <Button label="Share" icon="share" onPress={() => void share()} style={{ flex: 1 }} />
        <Button label="Copy link" icon="link" variant="glass" onPress={() => void copy()} style={{ flex: 1 }} />
      </Row>
      {saving ? (
        <View style={{ height: 48, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.accent} accessibilityLabel="Preparing image" />
        </View>
      ) : (
        <Button label="Save to photos" icon="download" variant="glass" onPress={() => void saveImage()} />
      )}

      {note ? (
        <View accessibilityLiveRegion="polite">
          <Toast icon={note.error ? 'info' : 'check'} iconColor={note.error ? colors.error : colors.success} message={note.text} />
        </View>
      ) : null}

      <View style={{ alignItems: 'center' }}>
        <LinkText label="Scan a code instead" icon="qr" onPress={() => setScanning(true)} />
      </View>

      {scanning ? (
        <Scanner
          onClose={() => setScanning(false)}
          onRoute={(path) => {
            setScanning(false);
            router.replace(path as Parameters<typeof router.replace>[0]);
          }}
        />
      ) : null}
    </ModalCard>
  );
}

const styles = StyleSheet.create({
  logoWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  logo: { width: 44, height: 44, borderRadius: 22, borderWidth: 4, borderColor: colors.white },
});
