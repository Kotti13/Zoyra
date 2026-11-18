import { CameraView, useCameraPermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { Button, Chip, Cover, ErrorState, Glass, IconButton, Loading, Row, Screen, ScreenHeader, Sticker, T, Toast, useAsync } from '../components';
import { moodFromPhoto } from '../lib/ai';
import { MOOD_MAP, catalog } from '../lib/catalog';
import { usePlayerPick } from '../state/player';
import { art, colors, shadow, withAlpha } from '../theme/tokens';

const moods = Object.keys(MOOD_MAP);

/** Map whatever the model returns onto one of our mood chips. */
function toChip(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  const direct = moods.find((m) => m.toLowerCase() === v);
  if (direct) return direct;
  const viaCatalog = moods.find((m) => (MOOD_MAP[m] ?? []).some((c) => c.toLowerCase() === v));
  return viaCatalog ?? null;
}

type Scan = { state: 'idle' } | { state: 'camera' } | { state: 'reading' } | { state: 'done'; mood: string; confidence: number; reason: string };

export default function MoodScan() {
  const { playTracks } = usePlayerPick();
  const [mood, setMood] = useState('Chill');
  const [note, setNote] = useState<string | null>(null);
  const [scan, setScan] = useState<Scan>({ state: 'idle' });
  const [ready, setReady] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 3600);
    return () => clearTimeout(id);
  }, [note]);

  const mix = useAsync(() => catalog.byMood(mood, 30), [mood]);
  const list = mix.data ?? [];

  const openCamera = async () => {
    let p = permission;
    if (!p?.granted) p = await requestPermission();
    if (!p.granted) {
      if (!p.canAskAgain) {
        setNote('Camera access is off. Turn it on in Settings, or pick your mood below.');
        void Linking.openSettings().catch(() => {});
      } else setNote('Camera permission is needed to scan. You can still pick your mood below.');
      return;
    }
    setReady(false);
    setScan({ state: 'camera' });
  };

  const capture = async () => {
    if (!camera.current || !ready) return;
    setScan({ state: 'reading' });
    let uri: string | null = null;
    try {
      // Small JPEG keeps the upload light. The photo is sent once and never stored.
      const pic = await camera.current.takePictureAsync({ quality: 0.4, base64: true, imageType: 'jpg', shutterSound: false });
      uri = pic.uri;
      if (!pic.base64) throw new Error('Could not read the photo');
      const res = await moodFromPhoto(pic.base64, 'image/jpeg');
      if (!res.ok) {
        setScan({ state: 'idle' });
        setNote(res.reason === 'not_configured' ? `Mood scan needs ${res.service} setup. Pick your mood below.` : `Could not read your mood (${res.message}). Pick it below.`);
        return;
      }
      const chip = toChip(res.data.mood);
      if (!chip) {
        setScan({ state: 'idle' });
        setNote(`Got "${res.data.mood}", which doesn't match a mix. Pick your mood below.`);
        return;
      }
      setMood(chip);
      setScan({ state: 'done', mood: chip, confidence: res.data.confidence, reason: res.data.reason });
    } catch (e) {
      setScan({ state: 'idle' });
      setNote(e instanceof Error ? e.message : 'Scan failed. Pick your mood below.');
    } finally {
      if (uri && !uri.startsWith('data:')) {
        try {
          new File(uri).delete();
        } catch {
          /* already gone */
        }
      }
    }
  };

  const play = (open: boolean) => {
    if (!list.length) return setNote(`No ${mood.toLowerCase()} tracks right now. Pick another mood.`);
    playTracks(list, 0, `${mood} mix`);
    if (open) router.push('/player');
  };

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'lines', mesh: 'amber' }}>
      <ScreenHeader title="Mood scan" />

      {/* Camera viewfinder: live front camera only while scanning */}
      <View style={{ alignSelf: 'center', width: 280, height: 280, borderRadius: 140, backgroundColor: withAlpha(colors.white, 0.06), alignItems: 'center', justifyContent: 'center', marginVertical: -10 }}>
        <View
          accessibilityLabel={scan.state === 'camera' ? 'Front camera preview' : 'Camera off'}
          style={{ width: 260, height: 260, borderRadius: 130, borderWidth: 4, borderColor: colors.accent, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}
        >
          <LinearGradient colors={[art.coral[1], colors.playerBg]} start={{ x: 0.33, y: 0 }} end={{ x: 0.67, y: 1 }} style={StyleSheet.absoluteFill} />
          {scan.state === 'camera' ? (
            <CameraView
              ref={camera}
              facing="front"
              style={StyleSheet.absoluteFill}
              onCameraReady={() => setReady(true)}
              onMountError={(e) => {
                setScan({ state: 'idle' });
                setNote(e.message || 'Camera could not start. Pick your mood below.');
              }}
            />
          ) : null}
          {scan.state === 'reading' ? <Loading height={60} label="Reading your mood" /> : null}
          <View style={{ width: 120, height: 150, borderRadius: 60, borderWidth: 3, borderStyle: 'dashed', borderColor: withAlpha(colors.white, 0.5) }} />
          <LinearGradient
            colors={['transparent', colors.accent, 'transparent']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={{ position: 'absolute', left: 0, right: 0, top: '48%', height: 3 }}
          />
        </View>
      </View>

      <View style={{ alignItems: 'center', gap: 8 }}>
        <T size={13} color={colors.textSecondary}>
          You are feeling
        </T>
        <T size={36} weight={700} tracking={-1} accessibilityRole="header">
          {mood}
        </T>
        <Sticker
          label={scan.state === 'done' && scan.mood === mood ? `Scanned · ${Math.round(scan.confidence * (scan.confidence <= 1 ? 100 : 1))}%` : 'Your pick'}
          bg={colors.success}
          rotate={-3}
          style={{ alignSelf: 'center' }}
        />
        {scan.state === 'done' && scan.mood === mood && scan.reason ? (
          <T size={13} color={colors.textSecondary} align="center" style={{ maxWidth: 300 }}>
            {scan.reason}
          </T>
        ) : null}
      </View>

      {note ? <Toast icon="info" iconColor={colors.amber} message={note} /> : null}

      <Glass radius={26} padding={16} style={{ gap: 8 }}>
        <T size={14} color={colors.textSecondary}>
          How do you feel right now?
        </T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, rowGap: 4 }}>
          {moods.map((m) => (
            <Chip
              key={m}
              label={m}
              active={m === mood}
              onPress={() => {
                setMood(m);
                if (scan.state === 'camera') setScan({ state: 'idle' });
              }}
            />
          ))}
        </View>
      </Glass>

      <Glass radius={26} padding={14}>
        {mix.loading && !mix.data ? (
          <Loading height={56} />
        ) : mix.error ? (
          <ErrorState message={mix.error} onRetry={mix.reload} />
        ) : (
          <Row>
            <Cover artwork={list[0]?.artwork} id={mood} size={56} radius={18} />
            <View style={{ flex: 1, gap: 2 }}>
              <T size={16} weight={600}>
                {mood} mix
              </T>
              <T size={13} color={colors.textSecondary}>
                {list.length ? `${list.length} songs picked for ${mood.toLowerCase()}` : 'No songs for this mood right now'}
              </T>
            </View>
            <IconButton icon="play" label={`Play ${mood} mix`} size={48} bg={colors.accent} color={colors.onAccent} onPress={() => play(false)} style={shadow.sticker} />
          </Row>
        )}
      </Glass>

      <T size={12} lineHeight={17} align="center" color={colors.textSecondary}>
        Scan takes one photo, sends it once to read your mood, and deletes it. Nothing is stored. Not right? Pick another mood above.
      </T>

      <Row>
        {scan.state === 'camera' ? (
          <Button label={ready ? 'Take photo' : 'Starting…'} icon="camera" variant={ready ? 'glass' : 'disabled'} style={{ flex: 1 }} onPress={() => void capture()} />
        ) : (
          <Button
            label={scan.state === 'reading' ? 'Reading…' : scan.state === 'done' ? 'Scan again' : 'Scan'}
            icon="camera"
            variant={scan.state === 'reading' ? 'disabled' : 'glass'}
            style={{ flex: 1 }}
            onPress={() => void openCamera()}
          />
        )}
        <Button label="Play my mix" onPress={() => play(true)} style={{ flex: 1 }} />
      </Row>
    </Screen>
  );
}
