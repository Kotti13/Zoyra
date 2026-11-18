import { useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';

import { Button, Glass, ListGroup, Overline, Row, Screen, ScreenHeader, Segmented, Sticker, T, Toast } from '../components';
import { formatBytes } from '../lib/downloads';
import { useDevicePref } from '../lib/network';
import { STREAM_KBPS, monthKey, streamedBytes, usage, type MonthUsage } from '../lib/usage';
import { useDownloads } from '../state/downloads';
import { colors } from '../theme/tokens';

const FILTERS = ['Cellular', 'Wi-Fi', 'All'] as const;
type Filter = (typeof FILTERS)[number];
/** Monthly mobile-plan size the user can set, in GB (0 = no limit). */
const LIMITS = [0, 2, 5, 10, 20, 50];
const GB = 1024 ** 3;
const WEEKS = ['1–7', '8–14', '15–21', '22+'];
const PER_HOUR = [
  { label: 'Low', kbps: 96 },
  { label: 'Normal', kbps: 160 },
  { label: 'High', kbps: STREAM_KBPS },
  { label: 'Lossless', kbps: 800 },
];

const pick = (m: MonthUsage | undefined, f: Filter) => (!m ? 0 : f === 'Cellular' ? m.cellular : f === 'Wi-Fi' ? m.wifi : streamedBytes(m));
const monthName = (key: string) => {
  const [y, mo] = key.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
};

export default function DataUsage() {
  const snap = useSyncExternalStore(usage.subscribe, usage.getSnapshot, usage.getSnapshot);
  const dl = useDownloads();
  const [filter, setFilter] = useState<Filter>('Cellular');
  const [limitGb, setLimitGb, limitLoaded] = useDevicePref('dataLimitGb', 0);
  const [confirm, setConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string }>();

  const key = monthKey();
  const month = snap.months[key];
  const used = pick(month, filter);
  const limit = limitGb * GB;
  const showLimit = limit > 0 && filter === 'Cellular';
  const pct = showLimit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const now = new Date();
  const resets = new Date(now.getFullYear(), now.getMonth() + 1, 1).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  const weekVals = month?.weeks ?? [0, 0, 0, 0];
  const weekMax = Math.max(1, ...weekVals);
  const thisWeek = Math.min(3, Math.floor((now.getDate() - 1) / 7));
  // Downloads saved this calendar month (real bytes on disk; the network they used isn't recorded).
  const downloadedThisMonth = dl.list.filter((e) => e.downloadedAt.startsWith(key)).reduce((n, e) => n + e.bytes, 0);
  const past = Object.keys(snap.months)
    .filter((k) => k !== key)
    .sort()
    .reverse();

  const where = [
    { label: 'Streaming', value: used, color: colors.accent, note: filter === 'All' ? 'all networks' : filter.toLowerCase() },
    ...(filter === 'All' ? [{ label: 'Downloads saved', value: downloadedThisMonth, color: colors.violet, note: 'any network' }] : []),
    { label: 'Played from downloads', value: month?.offline ?? 0, color: colors.success, note: 'no data used' },
  ];
  const whereMax = Math.max(1, ...where.map((w) => w.value));

  const reset = async () => {
    if (resetting) return;
    if (!confirm) {
      setConfirm(true);
      return setNote({ ok: true, text: 'Tap again to reset this month’s data usage.' });
    }
    setConfirm(false);
    setResetting(true);
    setNote(undefined);
    try {
      await usage.reset('month');
      setNote({ ok: true, text: 'Data usage reset for this month' });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not reset data usage' });
    } finally {
      setResetting(false);
    }
  };

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'grid', mesh: 'coral' }}>
      <ScreenHeader title="Data usage" />
      <Segmented options={[...FILTERS]} initial={0} onChange={(i) => setFilter(FILTERS[i])} />

      <Glass padding={16}>
        <View style={{ gap: 12 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Row gap={8} align="baseline" style={{ flexShrink: 1 }}>
              <T size={36} weight={700} tracking={-1} accessibilityLabel={`About ${formatBytes(Math.round(used))} this month`}>
                {snap.ready ? `≈ ${formatBytes(Math.round(used))}` : '…'}
              </T>
              {showLimit ? (
                <T size={14} color={colors.textSecondary}>
                  of {limitGb} GB
                </T>
              ) : null}
            </Row>
            {showLimit ? <Sticker label={`${pct}% used`} bg={pct >= 80 ? colors.amber : colors.accentLight} rotate={3} /> : null}
          </Row>
          {showLimit ? (
            <View style={{ height: 12, borderRadius: 6, backgroundColor: colors.track, overflow: 'hidden' }}>
              <View style={{ width: `${pct}%`, height: 12, backgroundColor: pct >= 80 ? colors.amber : colors.accent }} />
            </View>
          ) : null}
          <T size={13} color={colors.textSecondary}>
            {`${monthName(key)} · resets on ${resets}`}
          </T>
          {showLimit && pct >= 80 ? (
            <T size={13} color={colors.amber}>
              You’re close to your plan. Turn on Wi-Fi only downloads or play your downloads to save data.
            </T>
          ) : null}
        </View>
      </Glass>

      <Glass padding={16}>
        <View style={{ gap: 12 }}>
          <T size={14} weight={600}>
            Streamed by week (all networks)
          </T>
          <Row gap={8} align="flex-end" style={{ height: 90 }}>
            {WEEKS.map((w, i) => (
              <View
                key={w}
                accessibilityLabel={`Days ${w}: about ${formatBytes(Math.round(weekVals[i]))}`}
                style={{ flex: 1, height: Math.max(6, Math.round((weekVals[i] / weekMax) * 90)), borderRadius: 14, backgroundColor: i === thisWeek ? colors.accent : colors.trackLight }}
              />
            ))}
          </Row>
          <Row gap={8}>
            {WEEKS.map((w) => (
              <T key={w} size={11} color={colors.textSecondary} align="center" style={{ flex: 1 }}>
                {w}
              </T>
            ))}
          </Row>
        </View>
      </Glass>

      <ListGroup title="WHERE IT WENT">
        <View style={{ padding: 12, gap: 14 }}>
          {where.map((w) => (
            <View key={w.label} style={{ gap: 6 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T size={15} weight={500}>
                  {w.label}
                  <T size={12} color={colors.textSecondary}>{`  ${w.note}`}</T>
                </T>
                <T mono size={13} color={colors.textSecondary}>
                  {formatBytes(Math.round(w.value))}
                </T>
              </Row>
              <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.track, overflow: 'hidden' }}>
                <View style={{ width: `${(w.value / whereMax) * 100}%`, height: 6, backgroundColor: w.color }} />
              </View>
            </View>
          ))}
        </View>
      </ListGroup>

      <View style={{ gap: 8 }}>
        <Overline color={colors.textSecondary}>MONTHLY MOBILE PLAN</Overline>
        <Segmented
          key={limitLoaded ? 'ready' : 'loading'}
          options={LIMITS.map((g) => (g ? `${g} GB` : 'Off'))}
          initial={Math.max(0, LIMITS.indexOf(limitGb))}
          onChange={(i) => setLimitGb(LIMITS[i])}
        />
        <T size={12} color={colors.textSecondary}>
          Set your plan size to see how much of it Zoyra used on mobile data.
        </T>
      </View>

      <ListGroup title="DATA PER HOUR OF MUSIC">
        {PER_HOUR.map((q, i) => {
          const current = q.kbps === STREAM_KBPS;
          return (
            <Row key={q.label} style={[{ minHeight: 52, paddingHorizontal: 12 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
              <View style={{ flex: 1 }}>
                <T size={15} weight={current ? 600 : 400} color={current ? colors.accentLight : colors.text}>
                  {q.label}
                  {current ? ' · every song' : ''}
                </T>
                <T size={12} color={colors.textSecondary}>
                  {q.label === 'Lossless' ? 'about 800 kbps' : `${q.kbps} kbps`}
                  {current ? '' : ' · not offered'}
                </T>
              </View>
              <T mono size={13} color={current ? colors.text : colors.textSecondary}>
                {q.label === 'Lossless' ? '~' : ''}
                {Math.round((q.kbps * 3600) / 8 / 1000)} MB
              </T>
            </Row>
          );
        })}
      </ListGroup>

      {past.length ? (
        <ListGroup title="EARLIER MONTHS">
          {past.map((k, i) => (
            <Row key={k} style={[{ minHeight: 48, paddingHorizontal: 12, justifyContent: 'space-between' }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
              <T size={15}>{monthName(k)}</T>
              <T mono size={13} color={colors.textSecondary}>
                {formatBytes(Math.round(pick(snap.months[k], filter)))}
              </T>
            </Row>
          ))}
        </ListGroup>
      ) : null}

      <T size={12} color={colors.textSecondary} lineHeight={18}>
        {`An estimate from listening time × the ${STREAM_KBPS} kbps stream. It ignores buffering ahead and covers this device only; your carrier’s count is the one that matters.`}
      </T>

      {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.error} message={note.text} /> : null}
      <Button label={resetting ? 'Resetting…' : confirm ? 'Tap to confirm' : 'Reset this month'} variant={resetting ? 'disabled' : 'glass'} onPress={() => void reset()} />
    </Screen>
  );
}
