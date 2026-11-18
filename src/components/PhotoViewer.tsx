/**
 * Full-screen chat photo viewer (chat-pro, group-chat, chat-info shared media, chat-search).
 *
 *   pinch / double-tap zoom, pan while zoomed, swipe down to dismiss (backdrop fades with the drag),
 *   swipe left / right between the chat's photos, tap toggles the top bar (close, sender + time) and the
 *   bottom bar (Reply, Forward, Save, Share).
 *
 * react-native-gesture-handler / reanimated are not in this app, so gestures use PanResponder and the
 * settle animations run on the native driver. E2EE photos are decrypted to a cache file first
 * (`mediaUri` in src/lib/chat.ts) with a loader meanwhile. Reduce Motion: fades instead of springs.
 */
import { File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Modal, PanResponder, Platform, StatusBar, useWindowDimensions, View, type GestureResponderEvent, type PanResponderGestureState } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { dayLabel, mediaUri, timeOf } from '../lib/chat';
import { colors, withAlpha } from '../theme/tokens';
import { IconButton, Tap } from './controls';
import type { IconName } from './icons';
import { useReduceMotion } from './motion';
import { Icon, Row, T } from './primitives';

export type ViewerPhoto = { id: string; path: string; key?: string; mime?: string; width?: number; height?: number; senderName: string; at: string };

type Props = {
  photos: ViewerPhoto[];
  index: number | null;
  onClose: () => void;
  onIndexChange?: (i: number) => void;
  onReply?: (p: ViewerPhoto) => void;
  onForward?: (p: ViewerPhoto) => void;
};

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 260;
const DISMISS_DISTANCE = 120;

/** Resolves a photo to something <Image> can show (decrypted cache file for E2EE photos). */
function usePhotoUri(p: ViewerPhoto | undefined) {
  const [state, setState] = useState<{ id: string; uri: string | null; error: boolean } | null>(null);
  useEffect(() => {
    if (!p) return;
    let alive = true;
    mediaUri(p.path, p.key, p.mime)
      .then((uri) => alive && setState({ id: p.id, uri, error: false }))
      .catch(() => alive && setState({ id: p.id, uri: null, error: true }));
    return () => {
      alive = false;
    };
  }, [p]);
  const cur = p && state?.id === p.id ? state : null;
  return { uri: cur?.uri ?? null, error: !!cur?.error, loading: !!p && !cur };
}

function Slide({ photo, width, height, scale, panX, panY, active }: { photo: ViewerPhoto | undefined; width: number; height: number; scale?: Animated.Value; panX?: Animated.Value; panY?: Animated.Value; active: boolean }) {
  const media = usePhotoUri(photo);
  if (!photo) return <View style={{ width, height }} />;
  const transform = active && scale && panX && panY ? [{ translateX: panX }, { translateY: panY }, { scale }] : [];
  return (
    <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
      {media.uri ? (
        <Animated.View style={{ width, height, transform }}>
          <Image source={{ uri: media.uri }} style={{ width, height }} contentFit="contain" transition={120} accessibilityLabel={`Photo from ${photo.senderName}`} accessibilityIgnoresInvertColors />
        </Animated.View>
      ) : media.error ? (
        <View style={{ alignItems: 'center', gap: 8 }}>
          <Icon name="image" size={28} color={colors.textSecondary} />
          <T size={14} color={colors.textSecondary}>
            Couldn’t load photo
          </T>
        </View>
      ) : (
        <ActivityIndicator color={colors.textSecondary} accessibilityLabel="Loading photo" />
      )}
    </View>
  );
}

function BarButton({ icon, label, onPress, busy }: { icon: IconName; label: string; onPress: () => void; busy?: boolean }) {
  return (
    <Tap onPress={onPress} disabled={busy} accessibilityRole="button" accessibilityLabel={label} style={{ minWidth: 64, minHeight: 52, alignItems: 'center', justifyContent: 'center', gap: 4, opacity: busy ? 0.5 : 1 }}>
      {busy ? <ActivityIndicator color={colors.white} /> : <Icon name={icon} size={22} color={colors.white} />}
      <T size={12} weight={600} color={colors.white}>
        {label}
      </T>
    </Tap>
  );
}

/** Local file for a photo (decrypted cache file, or a downloaded copy of a signed URL). */
async function localFileFor(p: ViewerPhoto): Promise<string> {
  const uri = await mediaUri(p.path, p.key, p.mime);
  if (uri.startsWith('file:')) return uri;
  const ext = p.mime === 'image/png' ? 'png' : p.mime === 'image/webp' ? 'webp' : 'jpg';
  const dest = new File(Paths.cache, `zoyra-photo-${p.id}.${ext}`);
  if (dest.exists) return dest.uri;
  const f = await File.downloadFileAsync(uri, dest);
  return f.uri;
}

type Anim = { pagerX: Animated.Value; dismissY: Animated.Value; scale: Animated.Value; panX: Animated.Value; panY: Animated.Value; fade: Animated.Value };
type Live = { at: number; count: number; W: number; H: number; reduce: boolean; onClose: () => void; onIndexChange?: (i: number) => void; setAt: (i: number) => void; setBars: (f: (b: boolean) => boolean) => void };

/** Gesture state machine (kept outside React render: PanResponder needs synchronous mutable state). */
class ViewerGestures {
  a: Anim = { pagerX: new Animated.Value(0), dismissY: new Animated.Value(0), scale: new Animated.Value(1), panX: new Animated.Value(0), panY: new Animated.Value(0), fade: new Animated.Value(0) };
  g = { scale: 1, panX: 0, panY: 0, mode: 'none' as 'none' | 'pinch' | 'pan' | 'dismiss' | 'page' | 'undecided', startDist: 0, startScale: 1, startPanX: 0, startPanY: 0, lastTap: 0, tapTimer: null as ReturnType<typeof setTimeout> | null, moved: false, start: 0 };
  live: Live;
  responder: ReturnType<typeof PanResponder.create>;

  constructor(live: Live) {
    this.live = live;
    this.responder = this.makeResponder();
  }

  update(live: Live) {
    this.live = live;
  }

  dispose() {
    if (this.g.tapTimer) clearTimeout(this.g.tapTimer);
  }

  resetZoom = (animated: boolean) => {
    const s = this.g;
    s.scale = 1;
    s.panX = 0;
    s.panY = 0;
    if (!animated || this.live.reduce) {
      this.a.scale.setValue(1);
      this.a.panX.setValue(0);
      this.a.panY.setValue(0);
      return;
    }
    Animated.parallel([
      Animated.spring(this.a.scale, { toValue: 1, useNativeDriver: true, bounciness: 0 }),
      Animated.spring(this.a.panX, { toValue: 0, useNativeDriver: true, bounciness: 0 }),
      Animated.spring(this.a.panY, { toValue: 0, useNativeDriver: true, bounciness: 0 }),
    ]).start();
  };

  close = () => {
    const s = this.g;
    if (s.tapTimer) clearTimeout(s.tapTimer);
    Animated.timing(this.a.fade, { toValue: 0, duration: this.live.reduce ? 100 : 160, useNativeDriver: true }).start(() => {
      this.resetZoom(false);
      this.a.dismissY.setValue(0);
      this.a.pagerX.setValue(0);
      this.live.onClose();
    });
  };

  go = (dir: -1 | 1) => {
    const { at: i, count, W: w, reduce: rm, onIndexChange: cb } = this.live;
    const next = i + dir;
    if (next < 0 || next >= count) {
      Animated.spring(this.a.pagerX, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
      return;
    }
    const finish = () => {
      this.a.pagerX.setValue(0);
      this.resetZoom(false);
      this.live.setAt(next);
      cb?.(next);
    };
    if (rm) {
      finish();
      return;
    }
    Animated.timing(this.a.pagerX, { toValue: -dir * w, duration: 200, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(finish);
  };

  clampPan = (x: number, y: number, sc: number) => {
    const { W: w, H: h } = this.live;
    const mx = Math.max(0, (w * sc - w) / 2);
    const my = Math.max(0, (h * sc - h) / 2);
    return [Math.min(mx, Math.max(-mx, x)), Math.min(my, Math.max(-my, y))] as const;
  };

  dist = (e: GestureResponderEvent) => {
    const t = e.nativeEvent.touches;
    if (t.length < 2) return 0;
    return Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
  };

  onTap = (e: GestureResponderEvent) => {
    const s = this.g;
    const now = Date.now();
    if (now - s.lastTap < DOUBLE_TAP_MS) {
      s.lastTap = 0;
      if (s.tapTimer) clearTimeout(s.tapTimer);
      s.tapTimer = null;
      if (s.scale > 1) {
        this.resetZoom(true);
      } else {
        const { W: w, H: h } = this.live;
        // Zoom towards the tapped point.
        const [x, y] = this.clampPan((w / 2 - e.nativeEvent.pageX) * (DOUBLE_TAP_SCALE - 1), (h / 2 - e.nativeEvent.pageY) * (DOUBLE_TAP_SCALE - 1), DOUBLE_TAP_SCALE);
        s.scale = DOUBLE_TAP_SCALE;
        s.panX = x;
        s.panY = y;
        if (this.live.reduce) {
          this.a.scale.setValue(DOUBLE_TAP_SCALE);
          this.a.panX.setValue(x);
          this.a.panY.setValue(y);
        } else {
          Animated.parallel([
            Animated.spring(this.a.scale, { toValue: DOUBLE_TAP_SCALE, useNativeDriver: true, bounciness: 0 }),
            Animated.spring(this.a.panX, { toValue: x, useNativeDriver: true, bounciness: 0 }),
            Animated.spring(this.a.panY, { toValue: y, useNativeDriver: true, bounciness: 0 }),
          ]).start();
        }
      }
      return;
    }
    s.lastTap = now;
    s.tapTimer = setTimeout(() => {
      s.tapTimer = null;
      this.live.setBars((b) => !b);
    }, DOUBLE_TAP_MS);
  };


  makeResponder() {
    return PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          const s = this.g;
          s.moved = false;
          s.start = Date.now();
          s.startPanX = s.panX;
          s.startPanY = s.panY;
          s.startScale = s.scale;
          if (e.nativeEvent.touches.length >= 2) {
            s.mode = 'pinch';
            s.startDist = this.dist(e);
          } else {
            s.mode = s.scale > 1 ? 'pan' : 'undecided';
          }
        },
        onPanResponderMove: (e, gs: PanResponderGestureState) => {
          const s = this.g;
          if (Math.abs(gs.dx) > 6 || Math.abs(gs.dy) > 6) s.moved = true;
          if (e.nativeEvent.touches.length >= 2) {
            if (s.mode !== 'pinch') {
              s.mode = 'pinch';
              s.startDist = this.dist(e);
              s.startScale = s.scale;
              s.startPanX = s.panX;
              s.startPanY = s.panY;
              this.a.pagerX.setValue(0);
              this.a.dismissY.setValue(0);
            }
            const d = this.dist(e);
            if (s.startDist > 0 && d > 0) {
              const next = Math.min(MAX_SCALE, Math.max(0.8, (s.startScale * d) / s.startDist));
              s.scale = next;
              this.a.scale.setValue(next);
              const [x, y] = this.clampPan(s.startPanX, s.startPanY, Math.max(1, next));
              s.panX = x;
              s.panY = y;
              this.a.panX.setValue(x);
              this.a.panY.setValue(y);
            }
            return;
          }
          if (s.mode === 'pinch') return; // one finger lifted: wait for release
          if (s.mode === 'pan') {
            const [x, y] = this.clampPan(s.startPanX + gs.dx, s.startPanY + gs.dy, s.scale);
            s.panX = x;
            s.panY = y;
            this.a.panX.setValue(x);
            this.a.panY.setValue(y);
            return;
          }
          if (s.mode === 'undecided') {
            if (Math.abs(gs.dy) > 10 && Math.abs(gs.dy) > Math.abs(gs.dx) && gs.dy > 0) s.mode = 'dismiss';
            else if (Math.abs(gs.dx) > 10 && Math.abs(gs.dx) > Math.abs(gs.dy) && this.live.count > 1) s.mode = 'page';
          }
          if (s.mode === 'dismiss') this.a.dismissY.setValue(Math.max(0, gs.dy));
          else if (s.mode === 'page') {
            const { at: i, count } = this.live;
            const edge = (i === 0 && gs.dx > 0) || (i === count - 1 && gs.dx < 0);
            this.a.pagerX.setValue(edge ? gs.dx / 3 : gs.dx);
          }
        },
        onPanResponderRelease: (e, gs) => {
          const s = this.g;
          const mode = s.mode;
          s.mode = 'none';
          if (!s.moved && Date.now() - s.start < 300 && mode !== 'pinch') {
            this.onTap(e);
            return;
          }
          if (mode === 'pinch') {
            if (s.scale <= 1.02) this.resetZoom(true);
            return;
          }
          if (mode === 'dismiss') {
            if (gs.dy > DISMISS_DISTANCE || gs.vy > 1) {
              if (this.live.reduce) this.close();
              else Animated.timing(this.a.dismissY, { toValue: this.live.H, duration: 180, useNativeDriver: true }).start(this.close);
            } else if (this.live.reduce) this.a.dismissY.setValue(0);
            else Animated.spring(this.a.dismissY, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
            return;
          }
          if (mode === 'page') {
            const w = this.live.W;
            if (gs.dx < -w / 4 || gs.vx < -0.5) this.go(1);
            else if (gs.dx > w / 4 || gs.vx > 0.5) this.go(-1);
            else Animated.spring(this.a.pagerX, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
          }
        },
        onPanResponderTerminate: () => {
          this.g.mode = 'none';
          this.a.dismissY.setValue(0);
          this.a.pagerX.setValue(0);
        },
      });
  }
}

export function PhotoViewer({ photos, index, onClose, onIndexChange, onReply, onForward }: Props) {
  const visible = index !== null && photos.length > 0;
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const [at, setAt] = useState(index ?? 0);
  const [bars, setBars] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Sync the shown photo when the parent opens a different one.
  const [seenIndex, setSeenIndex] = useState(index);
  if (index !== seenIndex) {
    setSeenIndex(index);
    if (index !== null) {
      setAt(Math.min(Math.max(index, 0), photos.length - 1));
      setBars(true);
      setNote(null);
    }
  }
  const current = photos[at];

  const [ctl] = useState(() => new ViewerGestures({ at, count: photos.length, W, H, reduce, onClose, onIndexChange, setAt, setBars }));
  useEffect(() => {
    ctl.update({ at, count: photos.length, W, H, reduce, onClose, onIndexChange, setAt, setBars });
  }, [ctl, at, photos.length, W, H, reduce, onClose, onIndexChange]);
  const { pagerX, dismissY, scale, panX, panY, fade } = ctl.a;

  useEffect(() => {
    if (!visible) return;
    fade.setValue(0);
    dismissY.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: reduce ? 120 : 180, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [visible, fade, dismissY, reduce]);

  useEffect(() => () => ctl.dispose(), [ctl]);
  const close = ctl.close;
  const responder = ctl.responder;

  const run = async (key: string, fn: () => Promise<string | null>) => {
    if (busy || !current) return;
    setBusy(key);
    setNote(null);
    try {
      const msg = await fn();
      if (msg) setNote(msg);
    } catch (e) {
      setNote(e instanceof Error && e.message ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const share = () =>
    run('share', async () => {
      if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing isn’t available on this device.');
      const file = await localFileFor(current as ViewerPhoto);
      await Sharing.shareAsync(file, { mimeType: current?.mime ?? 'image/jpeg', dialogTitle: 'Share photo' });
      return null;
    });

  const save = () =>
    run('save', async () => {
      const file = await localFileFor(current as ViewerPhoto);
      // iOS: the photo-library "add" permission string isn't configured in this build, so use the system
      // share sheet ("Save Image"). Android: write to the gallery with expo-media-library.
      if (Platform.OS === 'android') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const ML = require('expo-media-library') as typeof import('expo-media-library');
          const perm = await ML.requestPermissionsAsync(true, ['photo']);
          if (!perm.granted) throw new Error('Allow Zoyra to save photos in system settings.');
          await ML.Asset.create(file);
          return 'Saved to your gallery';
        } catch (e) {
          if (e instanceof Error && /Allow Zoyra/.test(e.message)) throw e;
          // module missing in this build: fall through to the share sheet
        }
      }
      if (!(await Sharing.isAvailableAsync())) throw new Error('Saving isn’t available on this device.');
      await Sharing.shareAsync(file, { mimeType: current?.mime ?? 'image/jpeg', dialogTitle: 'Save photo' });
      return null;
    });

  if (!visible) return null;

  const backdrop = dismissY.interpolate({ inputRange: [0, 320], outputRange: [1, 0.15], extrapolate: 'clamp' });
  const shrink = reduce ? 1 : dismissY.interpolate({ inputRange: [0, 600], outputRange: [1, 0.8], extrapolate: 'clamp' });
  const when = current ? `${dayLabel(current.at)} · ${timeOf(current.at)}` : '';
  const slides = [-1, 0, 1].map((d) => ({ d, photo: photos[at + d] }));

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={close} supportedOrientations={['portrait', 'landscape']}>
      <StatusBar hidden={!bars} barStyle="light-content" animated />
      <Animated.View accessibilityViewIsModal style={{ flex: 1, opacity: fade }}>
        <Animated.View pointerEvents="none" style={{ position: 'absolute', inset: 0, backgroundColor: colors.black, opacity: backdrop }} />
        <View style={{ flex: 1, overflow: 'hidden' }} {...responder.panHandlers} accessibilityHint="Double tap to zoom, swipe down to close">
          <Animated.View style={{ flexDirection: 'row', width: W * 3, height: H, marginLeft: -W, transform: [{ translateX: pagerX }, { translateY: dismissY }, { scale: shrink }] }}>
            {slides.map(({ d, photo }) => (
              <Slide key={photo ? `${photo.id}` : `empty${d}`} photo={photo} width={W} height={H} active={d === 0} scale={scale} panX={panX} panY={panY} />
            ))}
          </Animated.View>
        </View>

        {bars && current ? (
          <>
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, paddingTop: insets.top + 6, paddingHorizontal: 12, paddingBottom: 10, backgroundColor: withAlpha(colors.black, 0.55) }}>
              <Row gap={8}>
                <IconButton icon="close" label="Close photo" size={44} bg={withAlpha(colors.white, 0.14)} onPress={close} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T size={15} weight={600} color={colors.white} numberOfLines={1}>
                    {current.senderName}
                  </T>
                  <T size={12} color={withAlpha(colors.white, 0.75)} numberOfLines={1}>
                    {when}
                    {photos.length > 1 ? ` · ${at + 1} of ${photos.length}` : ''}
                  </T>
                </View>
              </Row>
            </View>
            <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingBottom: insets.bottom + 8, paddingTop: 8, backgroundColor: withAlpha(colors.black, 0.55), gap: 4 }}>
              {note ? (
                <T size={13} color={colors.white} align="center" accessibilityLiveRegion="polite">
                  {note}
                </T>
              ) : null}
              <Row style={{ justifyContent: 'space-around' }}>
                {onReply ? (
                  <BarButton
                    icon="chat"
                    label="Reply"
                    onPress={() => {
                      const p = current;
                      close();
                      onReply(p);
                    }}
                  />
                ) : null}
                {onForward ? (
                  <BarButton
                    icon="send"
                    label="Forward"
                    onPress={() => {
                      const p = current;
                      close();
                      onForward(p);
                    }}
                  />
                ) : null}
                {Platform.OS !== 'web' ? <BarButton icon="download" label="Save" busy={busy === 'save'} onPress={() => void save()} /> : null}
                {Platform.OS !== 'web' ? <BarButton icon="share" label="Share" busy={busy === 'share'} onPress={() => void share()} /> : null}
              </Row>
            </View>
          </>
        ) : null}
      </Animated.View>
    </Modal>
  );
}
