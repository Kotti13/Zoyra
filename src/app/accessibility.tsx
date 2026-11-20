import { Animated, View } from 'react-native';

import { Chip, Cover, Icon, Row, Screen, T, Tap, Toggle, useSpin } from '../components';
import { BigHeader, Panel, PanelRow, SectionLabel } from '../components/settings-ui';
import {
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  TEXT_SCALE_STEP,
  boldenWeight,
  scaledSize,
  statusColors,
  useAppReduceMotion,
  useBoldText,
  useColorBlindSafe,
  useHighContrast,
  useReduceLyricMotion,
  useScreenReaderHints,
  useSystemReduceMotion,
  useTextScale,
} from '../lib/a11y';
import { usePlayerPick } from '../state/player';
import { colors, type Weight } from '../theme/tokens';

const SCALES = [90, 100, 110, 120, 130];

/** Round "A" button (small A = smaller, big A = larger), as in the design. */
function StepButton({ label, size, onPress }: { label: string; size: number; onPress: () => void }) {
  return (
    <Tap onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={{ width: 40, height: 44, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.chipGhost, alignItems: 'center', justifyContent: 'center' }}>
        <T size={size} weight={600}>
          A
        </T>
      </View>
    </Tap>
  );
}

/** Live preview: reacts to every toggle on this screen. Shows the real now-playing track when there is one. */
function Preview({ scale, bold, reduce, lyricStatic, contrast, cbSafe }: { scale: number; bold: boolean; reduce: boolean; lyricStatic: boolean; contrast: boolean; cbSafe: boolean }) {
  const { track, playing } = usePlayerPick('track', 'playing');
  const rotate = useSpin(playing && !reduce);
  const w = (x: Weight) => boldenWeight(x, bold);
  const s = (x: number) => scaledSize(x, scale);
  const secondary = contrast ? colors.text : colors.textSecondary;
  const status = statusColors({ success: colors.success, error: colors.error }, cbSafe, { blue: colors.info, orange: colors.orange });
  const title = track?.title ?? 'Nothing playing';
  const artist = track ? track.artist.name : 'Play a song to preview it here';

  return (
    <View style={contrast ? { borderRadius: 36, borderWidth: 2, borderColor: colors.text } : undefined}>
      <Panel padding={18} radius={36}>
        <View style={{ gap: 12 }} accessible accessibilityLabel={`Preview. ${title}. ${artist}`}>
          <T size={12} color={contrast ? colors.text : colors.textSecondary}>
            Preview
          </T>
          <Row gap={14}>
            <Animated.View style={{ transform: [{ rotate }] }}>
              <Cover artwork={track?.artwork} id={track?.id} size={64} radius={32} />
            </Animated.View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <T size={s(22)} weight={w(600)} numberOfLines={1}>
                {title}
              </T>
              <T size={s(15)} weight={w(400)} color={contrast ? colors.text : colors.peach} numberOfLines={2}>
                {artist}
              </T>
            </View>
          </Row>
          <View style={{ gap: 6 }}>
            <View style={{ height: 6, borderRadius: 3, backgroundColor: contrast ? colors.textTertiary : colors.track, overflow: 'hidden' }}>
              <View style={{ width: lyricStatic ? '100%' : '55%', height: 6, backgroundColor: lyricStatic ? colors.trackLight : colors.accent }} />
            </View>
            <T size={s(13)} weight={w(500)} color={secondary}>
              {lyricStatic ? 'Lyric lines highlight without the moving fill' : 'Lyric lines fill as they are sung'}
            </T>
          </View>
          <Row gap={16}>
            <Row gap={6}>
              <Icon name="check" size={16} color={status.success} />
              <T size={s(12)} weight={w(500)} color={status.success}>
                Saved
              </T>
            </Row>
            <Row gap={6}>
              <Icon name="close" size={16} color={status.error} />
              <T size={s(12)} weight={w(500)} color={status.error}>
                Failed
              </T>
            </Row>
            <T size={s(12)} color={secondary} style={{ flex: 1 }} align="right">
              {reduce ? 'Disc still' : playing ? 'Disc spins' : 'Disc spins while playing'}
            </T>
          </Row>
        </View>
      </Panel>
    </View>
  );
}

export default function Accessibility() {
  const [scale, setScale] = useTextScale();
  const [bold, setBold] = useBoldText();
  const [appReduce, setAppReduce] = useAppReduceMotion();
  const system = useSystemReduceMotion();
  const [lyricStatic, setLyricStatic] = useReduceLyricMotion();
  const [contrast, setContrast] = useHighContrast();
  const [cbSafe, setCbSafe] = useColorBlindSafe();
  const [hints, setHints] = useScreenReaderHints();
  const pct = Math.round(scale * 100);
  const reduce = appReduce || system;

  return (
    <Screen top={4} gap={16} bottom={24} backdrop={{ pattern: 'none', mesh: 'coral' }}>
      <BigHeader title="Accessibility" />

      <Preview scale={scale} bold={bold} reduce={reduce} lyricStatic={lyricStatic || reduce} contrast={contrast} cbSafe={cbSafe} />

      <View style={{ gap: 8 }}>
        <SectionLabel size={12} tracking={1.2}>Text</SectionLabel>
        <Panel padding={{ v: 12, h: 16 }}>
          <View style={{ gap: 10 }}>
            <Row>
              <View style={{ flex: 1, gap: 2 }}>
                <T size={16} weight={500}>
                  Text size
                </T>
                <T variant="small" color={colors.textSecondary}>
                  {pct === 100 ? 'Design size' : `${pct}% of the design size`} · works with your system text size
                </T>
              </View>
            </Row>
            <Row gap={8}>
              <StepButton label="Smaller text" size={13} onPress={() => setScale(pct - TEXT_SCALE_STEP)} />
              <View
                style={{ flex: 1, flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap' }}
                accessibilityRole="adjustable"
                accessibilityLabel="Text size"
                accessibilityValue={{ min: TEXT_SCALE_MIN, max: TEXT_SCALE_MAX, now: pct, text: `${pct} percent` }}
                accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                onAccessibilityAction={(e) => setScale(pct + (e.nativeEvent.actionName === 'increment' ? TEXT_SCALE_STEP : -TEXT_SCALE_STEP))}
              >
                {SCALES.map((v) => (
                  <Chip key={v} label={`${v}%`} active={v === pct} onPress={() => setScale(v)} />
                ))}
              </View>
              <StepButton label="Larger text" size={20} onPress={() => setScale(pct + TEXT_SCALE_STEP)} />
            </Row>
          </View>
        </Panel>
        <Panel padding={{ v: 4, h: 16 }}>
          <PanelRow title="Bold text" subtitle="Heavier weights everywhere" minHeight={60} right={<Toggle value={bold} onChange={setBold} label="Bold text" />} />
        </Panel>
      </View>

      <View style={{ gap: 8 }}>
        <SectionLabel size={12} tracking={1.2}>Motion</SectionLabel>
        <Panel padding={{ v: 4, h: 16 }}>
        <PanelRow
          title="Reduce motion"
          subtitle={system ? 'Already on in your phone settings' : 'Calm transitions, no spinning disc'}
          minHeight={64}
          right={<Toggle value={appReduce} onChange={setAppReduce} label="Reduce motion" />}
        />
        <PanelRow
          title="Reduce lyric animation"
          subtitle="Static highlight instead of fill"
          minHeight={64}
          divider
          right={<Toggle value={lyricStatic} onChange={setLyricStatic} label="Reduce lyric animation" />}
        />
      </Panel>
      </View>

      <View style={{ gap: 8 }}>
        <SectionLabel size={12} tracking={1.2}>Vision and hearing</SectionLabel>
        <Panel padding={{ v: 4, h: 16 }}>
        <PanelRow title="High contrast" subtitle="Stronger borders and text" minHeight={64} right={<Toggle value={contrast} onChange={setContrast} label="High contrast" />} />
        <PanelRow
          title="Colour blind friendly"
          subtitle="Blue and orange instead of red and green cues"
          minHeight={64}
          divider
          right={<Toggle value={cbSafe} onChange={setCbSafe} label="Colour blind friendly" />}
        />
        <PanelRow
          title="Screen reader hints"
          subtitle="Extra spoken hints on buttons and artwork"
          minHeight={64}
          divider
          right={<Toggle value={hints} onChange={setHints} label="Screen reader hints" />}
        />
      </Panel>
      </View>

      <Panel padding={14} radius={32}>
        <Row gap={10} align="flex-start">
          <Icon name="info" size={18} color={colors.textSecondary} />
          <T size={13} color={colors.textSecondary} style={{ flex: 1 }}>
            Mono audio and haptic feedback aren’t available in this version: mono needs a native audio mixer, and vibration needs a module this build doesn’t include. Your phone’s own mono audio setting
            (in its accessibility settings) still works with Zoyra.
          </T>
        </Row>
      </Panel>
    </Screen>
  );
}
