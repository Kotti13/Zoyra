import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Glass, IconButton, ListRow, Overline, Row, Screen, T, Tap, Toggle, type IconName } from '../components';
import { dmSettings, loadInbox, type DmSettings } from '../lib/dm';
import { OnlineDot, RoundFace } from '../lib/inbox-ui';
import { LAST_SEEN_WHO, lastSeenAtLabel, lastSeenPrefs, type LastSeenWho } from '../lib/last-seen';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

/**
 * Last seen and online (`/last-seen`, from Message privacy). Who can see my last seen (Everyone / Mutuals /
 * Forever only / Nobody, reciprocal), "Show when I am online", "Approximate time", read receipts and typing.
 * Saved in user_settings.dm (src/lib/last-seen.ts); the server applies them in last_seen_for().
 * The preview shows roughly what a recent chat partner sees right now.
 */

type Person = { id: string; name: string; avatar: string | null };

const AMBER = colors.gold;

function Radio({ on }: { on: boolean }) {
  return (
    <View
      style={{
        width: 24,
        height: 24,
        borderRadius: 12,
        borderWidth: on ? 0 : 2,
        borderColor: withAlpha(colors.white, 0.3),
        backgroundColor: on ? colors.accent : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {on ? <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: colors.onAccent }} /> : null}
    </View>
  );
}

type SwitchKey = 'online_status' | 'last_seen_approx' | 'read_receipts' | 'typing';
const SWITCHES: { key: SwitchKey; title: string; subtitle: string; icon: IconName }[] = [
  { key: 'online_status', title: 'Show when I am online', subtitle: 'Green dot in chats and header', icon: 'eye' },
  { key: 'last_seen_approx', title: 'Approximate time', subtitle: 'Show "last seen recently" instead', icon: 'clock' },
  { key: 'read_receipts', title: 'Read receipts', subtitle: 'Blue ticks and "Seen" label', icon: 'checkBold' },
  { key: 'typing', title: 'Typing indicator', subtitle: 'Show "typing…" while you write', icon: 'edit' },
];

export default function LastSeen() {
  const { user, profile, settings, updateSettings, refresh } = useAuth();
  const uid = user?.id;
  const raw = settings?.dm;
  const dm = dmSettings(raw);
  const prefs = lastSeenPrefs(raw);
  const [note, setNote] = useState<string>();
  const [friend, setFriend] = useState<Person | null>(null);
  /** Example time for the preview: two minutes before the screen opened. */
  const [example] = useState(() => new Date(Date.now() - 120_000).toISOString());

  // A recent 1:1 chat partner for the preview ("What Priya sees").
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    loadInbox()
      .then((rows) => {
        const r = rows.find((x) => x.other_id && Number(x.member_count) === 2 && x.request_state !== 'outgoing' && !x.blocked);
        if (alive && r?.other_id) setFriend({ id: r.other_id, name: r.other_name ?? 'Friend', avatar: r.other_avatar });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [uid]);

  /** Saves at once (optimistic in the auth context); on failure reloads the stored settings. */
  const save = async (patch: Record<string, unknown>) => {
    setNote(undefined);
    try {
      await updateSettings({ dm: { ...(raw ?? {}), ...patch } as Partial<DmSettings> });
    } catch (e) {
      setNote(e instanceof Error && e.message ? e.message : 'Could not save that change');
      await refresh().catch(() => undefined);
    }
  };

  const value = (k: SwitchKey) => (k === 'last_seen_approx' ? prefs.last_seen_approx : dm[k]);
  const first = friend?.name.split(' ')[0] ?? 'a friend';
  const preview = prefs.last_seen_who === 'nobody' ? 'Your last seen is hidden' : prefs.last_seen_approx ? 'last seen recently' : lastSeenAtLabel(example);

  return (
    <Screen top={4} gap={14} onRefresh={uid ? () => refresh().catch(() => undefined) : undefined} backdrop={{ pattern: 'none', mesh: 'coral', orbs: true }}>
      <Row gap={8} style={{ minHeight: 44 }}>
        <IconButton icon="back" label="Back" size={44} iconSize={20} glass href="back" />
      </Row>
      <View style={{ gap: 6 }}>
        <T size={36} weight={300} tracking={-1} lineHeight={40} accessibilityRole="header">
          Last seen and online
        </T>
        <T size={14} lineHeight={20} color={colors.textSecondary}>
          Choose who can see when you were last active.
        </T>
      </View>

      <Glass radius={32} padding={0} style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
        <Row gap={12} accessible accessibilityLabel={`What ${first} sees: ${preview}${dm.online_status ? '. Online while you use Zoyra' : ''}`}>
          <View>
            <RoundFace id={uid} name={profile?.display_name ?? 'You'} uri={profile?.avatar_url} size={54} radius={18} />
            {dm.online_status ? (
              <View style={{ position: 'absolute', right: -1, bottom: -1 }}>
                <OnlineDot size={14} ring={colors.bg} />
              </View>
            ) : null}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={13} color={colors.textSecondary} numberOfLines={1}>
              What {first} sees
            </T>
            <T size={15} weight={600} numberOfLines={2}>
              {preview}
            </T>
          </View>
          {friend ? <RoundFace id={friend.id} name={friend.name} uri={friend.avatar} size={32} /> : null}
        </Row>
      </Glass>

      <View style={{ paddingHorizontal: 4 }}>
        <Overline color={colors.textSecondary}>Who can see my last seen</Overline>
      </View>
      <Glass radius={32} padding={0}>
        <View accessibilityRole="radiogroup" accessibilityLabel="Who can see my last seen">
          {LAST_SEEN_WHO.map((w, i) => {
            const on = prefs.last_seen_who === w.key;
            return (
              <Tap
                key={w.key}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${w.title}. ${w.hint}`}
                pressScale={0.98}
                onPress={() => !on && void save({ last_seen_who: w.key satisfies LastSeenWho })}
                style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14, minHeight: 60 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <T size={15} weight={600}>
                    {w.title}
                  </T>
                  <T size={12} color={colors.textSecondary}>
                    {w.hint}
                  </T>
                </View>
                <Radio on={on} />
              </Tap>
            );
          })}
        </View>
      </Glass>

      <Glass radius={36} padding={0} style={{ paddingHorizontal: 4, paddingVertical: 4 }}>
        {SWITCHES.map((s, i) => (
          <ListRow
            key={s.key}
            title={s.title}
            subtitle={s.subtitle}
            icon={s.icon}
            divider={i > 0}
            right={<Toggle value={value(s.key)} label={s.title} onChange={(v) => void save({ [s.key]: v })} />}
          />
        ))}
      </Glass>

      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderRadius: 22, backgroundColor: withAlpha(AMBER, 0.1), borderWidth: 1, borderColor: withAlpha(AMBER, 0.35) }}>
        <T size={22} weight={800} color={AMBER} accessibilityElementsHidden importantForAccessibility="no">
          ∞
        </T>
        <T size={12} lineHeight={17} color={colors.text} style={{ flex: 1 }}>
          Forever friends always see your last seen, even when it is hidden from others, unless you choose Nobody. Privacy works both ways: if you hide yours from someone, you won’t see theirs.
        </T>
      </View>

      {note ? (
        <T size={13} lineHeight={18} color={colors.error} align="center" accessibilityLiveRegion="polite">
          {note}
        </T>
      ) : null}
    </Screen>
  );
}
