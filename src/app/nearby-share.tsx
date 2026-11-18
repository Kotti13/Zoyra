import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, TextInput, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Button, Cover, Glass, Icon, Overline, Row, Screen, ScreenHeader, T, Tap, Toast } from '../components';
import { Scanner } from '../lib/qr-scanner';
import { claimNearbyShare, cleanNearbyCode, CODE_LENGTH, createNearbyShare, endNearbyShare, nearbyLink, nearbyRoute, type NearbyClaim, type NearbyShare } from '../lib/nearby';
import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import { useSheetTrack } from '../state/selection';
import { colors, fonts } from '../theme/tokens';

type Note = { text: string; error?: boolean };

/**
 * Nearby share (`/nearby-share[?code=]`). Show a short-lived code for a song to someone next to you; they scan the
 * QR code or type the code in the same screen. No radio discovery: the Expo stack has no Bluetooth module, so
 * this is honest about using a code. Codes work for 10 minutes and can be stopped early.
 */
export default function NearbyShareScreen() {
  const { user } = useAuth();
  const params = useLocalSearchParams<{ code?: string }>();
  const player = usePlayerPick('track');
  const track = useSheetTrack(player.track, false);

  const [share, setShare] = useState<NearbyShare | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState<'make' | 'join' | null>(null);
  const [input, setInput] = useState(typeof params.code === 'string' ? cleanNearbyCode(params.code) : '');
  const [claim, setClaim] = useState<NearbyClaim | null>(null);
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const shareRef = useRef<NearbyShare | null>(null);

  // End my code when leaving the screen (no stray codes in the table).
  useEffect(() => {
    shareRef.current = share;
  }, [share]);
  useEffect(
    () => () => {
      if (shareRef.current) void endNearbyShare(shareRef.current.code);
    },
    [],
  );

  // Countdown.
  useEffect(() => {
    if (!share) return;
    const tick = () => {
      const s = Math.max(0, Math.round((new Date(share.expires_at).getTime() - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) setShare(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [share]);

  const make = async () => {
    if (!track || busy) return;
    setBusy('make');
    setNote(null);
    try {
      setShare(await createNearbyShare(track));
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Could not make a code', error: true });
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    const s = share;
    setShare(null);
    if (s) await endNearbyShare(s.code);
  };

  const join = useCallback(
    async (raw: string) => {
      const code = cleanNearbyCode(raw);
      if (code.length !== CODE_LENGTH) return;
      setBusy('join');
      setNote(null);
      setClaim(null);
      try {
        setClaim(await claimNearbyShare(code));
      } catch (e) {
        setNote({ text: e instanceof Error ? e.message : 'Could not use that code', error: true });
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  // Opened from a scanned / tapped link with ?code=
  const autoCode = typeof params.code === 'string' ? params.code : '';
  const tried = useRef('');
  useEffect(() => {
    if (!user || !autoCode || tried.current === autoCode) return;
    tried.current = autoCode;
    void join(autoCode);
  }, [user, autoCode, join]);

  if (!user) {
    return (
      <Screen top={4} gap={16} backdrop={{ pattern: 'none', mesh: 'coral' }}>
        <ScreenHeader title="Nearby share" back="back" />
        <T color={colors.textSecondary}>Sign in to share songs with people nearby.</T>
        <Button label="Sign in" href="/login" />
      </Screen>
    );
  }

  const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

  return (
    <Screen top={4} gap={18} bottom={24} backdrop={{ pattern: 'none', mesh: 'coral' }}>
      <ScreenHeader title="Nearby share" />

      <View style={{ gap: 8 }}>
        <Overline color={colors.textSecondary}>SHARE A SONG</Overline>
        {!track ? (
          <T size={14} color={colors.textSecondary}>
            Play or pick a song, then open Share → Nearby to get a code for it.
          </T>
        ) : (
          <Glass padding={14} style={{ gap: 14 }}>
            <Row gap={12}>
              <Cover artwork={track.artwork} id={track.id} size={52} radius={14} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T size={16} weight={600} numberOfLines={1}>
                  {track.title}
                </T>
                <T size={14} color={colors.textSecondary} numberOfLines={1}>
                  {track.artist.name}
                </T>
              </View>
            </Row>
            {share ? (
              <View style={{ alignItems: 'center', gap: 10 }}>
                <View style={{ padding: 14, borderRadius: 28, backgroundColor: colors.white }} accessible accessibilityRole="image" accessibilityLabel={`QR code for ${track.title}`}>
                  <QRCode value={nearbyLink(share.code)} size={180} color={colors.bg} backgroundColor={colors.white} ecl="M" />
                </View>
                <T size={30} weight={700} mono tracking={6} accessibilityLabel={`Code ${share.code.split('').join(' ')}`}>
                  {share.code}
                </T>
                <T size={13} color={colors.textSecondary} align="center">
                  {`Ask them to open Nearby share in Zoyra and scan this or type the code. Works for ${mm}.`}
                </T>
                <Button label="Stop sharing" variant="secondary" onPress={() => void stop()} style={{ alignSelf: 'stretch' }} />
              </View>
            ) : busy === 'make' ? (
              <ActivityIndicator color={colors.accent} style={{ minHeight: 48 }} />
            ) : (
              <Button label="Show code" icon="qr" onPress={() => void make()} />
            )}
          </Glass>
        )}
      </View>

      <View style={{ gap: 8 }}>
        <Overline color={colors.textSecondary}>RECEIVE A SONG</Overline>
        <Row gap={8}>
          <TextInput
            value={input}
            onChangeText={(v) => setInput(cleanNearbyCode(v))}
            placeholder="ABC123"
            placeholderTextColor={colors.textTertiary}
            accessibilityLabel="Nearby code"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={CODE_LENGTH}
            style={{ flex: 1, height: 48, borderRadius: 24, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.bgTertiary, color: colors.text, fontFamily: fonts.mono ?? fonts.regular, fontSize: 18, letterSpacing: 4, paddingHorizontal: 18 }}
          />
          <Button label={busy === 'join' ? 'Checking…' : 'Join'} variant={input.length === CODE_LENGTH && !busy ? 'primary' : 'disabled'} onPress={() => void join(input)} />
        </Row>
        <Tap onPress={() => setScanning(true)} accessibilityRole="button" accessibilityLabel="Scan a code" style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Icon name="qr" size={18} color={colors.accentLight} />
          <T size={15} weight={600} color={colors.accentLight}>
            Scan a code
          </T>
        </Tap>
      </View>

      {claim ? (
        <Glass padding={14} style={{ gap: 12 }}>
          <T size={12} weight={600} tracking={0.6} color={colors.textSecondary}>
            {`FROM ${(claim.owner_name || 'A FRIEND').toUpperCase()}`}
          </T>
          <Row gap={12}>
            {claim.item.art ? <Cover uri={claim.item.art} id={claim.item.id} size={52} radius={14} /> : <Icon name="music" size={28} color={colors.accentLight} />}
            <View style={{ flex: 1, minWidth: 0 }}>
              <T size={16} weight={600} numberOfLines={1}>
                {claim.item.title || 'Shared song'}
              </T>
              {claim.item.subtitle ? (
                <T size={14} color={colors.textSecondary} numberOfLines={1}>
                  {claim.item.subtitle}
                </T>
              ) : null}
            </View>
          </Row>
          <Button label="Open" icon="play" onPress={() => router.replace(nearbyRoute(claim) as Parameters<typeof router.replace>[0])} />
        </Glass>
      ) : null}

      {scanning ? (
        <Scanner
          title="Scan a nearby code"
          caption="Point at the code on your friend’s screen."
          onClose={() => setScanning(false)}
          onRoute={(path) => {
            setScanning(false);
            const m = /^\/nearby-share\?code=([A-Za-z0-9]+)/.exec(path);
            if (m) {
              setInput(cleanNearbyCode(m[1]));
              void join(m[1]);
            } else router.replace(path as Parameters<typeof router.replace>[0]);
          }}
        />
      ) : null}

      {note ? <Toast icon={note.error ? 'info' : 'check'} iconColor={note.error ? colors.error : colors.success} message={note.text} /> : null}
    </Screen>
  );
}
