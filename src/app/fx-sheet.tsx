import { View } from 'react-native';

import { Button, ChipRow, Icon, Sheet, T, Tap, type IconName } from '../components';
import { usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
const speedLabel = (r: number) => `${Number.isInteger(r * 10) ? r.toFixed(1) : r.toFixed(2)}x`;

/**
 * Sound controls that work in this build: speed (persisted), Equalizer and Smooth transition / normalisation
 * (Settings › Playback). Pitch shifting (Nightcore, Slowed), reverb, 8D and spatial audio need a real-time DSP
 * stage; expo-audio's playlist player has none (no pitch toggle, no effect nodes), so they are listed as
 * unavailable with the reason instead of as switches that do nothing.
 */
const links: { title: string; sub: string; icon: IconName; href: '/equalizer' | '/playback-settings' }[] = [
  { title: 'Equalizer', sub: '10 bands, presets and bass boost', icon: 'speaker', href: '/equalizer' },
  { title: 'Smooth transition', sub: 'Crossfade between songs', icon: 'bolt', href: '/playback-settings' },
];
const unavailable = ['Nightcore and Slowed', 'Reverb', '8D audio', 'Spatial audio'];

export default function FxSheet() {
  const { rate, setRate } = usePlayerPick('rate');
  const current = Math.max(0, speeds.findIndex((s) => Math.abs(s - rate) < 0.001));

  return (
    <Sheet>
      <T variant="section" accessibilityRole="header">
        Speed and sound
      </T>

      <T size={12} weight={600} tracking={0.5} color={colors.textSecondary}>
        {`PLAYBACK SPEED · ${speedLabel(rate)}`}
      </T>
      <View style={{ marginTop: -8 }}>
        <ChipRow wrap options={speeds.map(speedLabel)} initial={current} onChange={(i) => setRate(speeds[i])} />
      </View>

      <View style={{ gap: 4 }}>
        {links.map((e, i) => (
          <Tap
            key={e.title}
            href={e.href}
            accessibilityLabel={`${e.title}. ${e.sub}`}
            style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}
          >
            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={e.icon} size={20} color={colors.accentLight} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <T size={16} weight={500}>
                {e.title}
              </T>
              <T size={14} color={colors.textSecondary}>
                {e.sub}
              </T>
            </View>
            <Icon name="chevronRight" size={16} color={colors.textSecondary} />
          </Tap>
        ))}
      </View>

      <T size={13} color={colors.textSecondary}>
        {`${unavailable.join(', ')} are not available: they need real-time audio processing that this player does not have.`}
      </T>

      <Button label="Done" href="back" />
    </Sheet>
  );
}
