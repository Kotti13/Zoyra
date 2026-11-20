import { router, type Href } from 'expo-router';
import { useMemo, useState } from 'react';
import { TextInput, View } from 'react-native';

import { EmptyState, IconButton, Row, Screen, T, Tap, useDebounced } from '../components';
import { Panel, PanelRow, SectionLabel } from '../components/settings-ui';
import { usePref } from '../lib/prefs';
import { POPULAR_SETTINGS, searchSettings, type SettingsEntry } from '../lib/settings-index';
import { colors } from '../theme/tokens';

const RECENT_KEY = 'settingsRecentSearches';
const MAX_RECENT = 6;
const NO_RECENT: string[] = [];

export default function SettingsSearch() {
  const [query, setQuery] = useState('');
  const [recent, setRecent] = usePref<string[]>(RECENT_KEY, NO_RECENT);
  const q = useDebounced(query, 120);
  const results = useMemo(() => searchSettings(q), [q]);
  const typing = query.trim().length > 0;

  const remember = (term: string) => {
    const t = term.trim();
    if (!t) return;
    setRecent([t, ...recent.filter((r) => r.toLowerCase() !== t.toLowerCase())].slice(0, MAX_RECENT));
  };

  const open = (e: SettingsEntry) => {
    remember(typing ? query : e.title);
    router.push(e.route as Href);
  };

  const row = (e: SettingsEntry, i: number) => (
    <PanelRow
      key={`${e.route}|${e.title}`}
      title={e.title}
      subtitle={e.section === 'Screen' ? 'Settings screen' : e.section}
      icon={e.icon}
      divider={i > 0}
      onPress={() => open(e)}
      titleSize={15}
      titleWeight={600}
      subSize={12}
      minHeight={64}
      vPad={0}
    />
  );

  return (
    <Screen top={4} gap={16} bottom={24} backdrop={{ pattern: 'none', mesh: 'coral' }} stagger={false}>
      <Row gap={10}>
        <IconButton icon="back" label="Back" href="back" bg={colors.chipGhost} />
        <Panel radius={26} style={{ flex: 1, height: 52, justifyContent: 'center', paddingHorizontal: 18, borderWidth: 1.5, borderColor: colors.accent }}>
          <Row gap={10}>
            <TextInput
              autoFocus
              value={query}
              onChangeText={setQuery}
              onSubmitEditing={() => remember(query)}
              placeholder="Search settings"
              placeholderTextColor={colors.textTertiary}
              accessibilityLabel="Search settings"
              returnKeyType="search"
              autoCorrect={false}
              autoCapitalize="none"
              style={{ flex: 1, color: colors.text, fontSize: 16, minHeight: 44 }}
            />
            {typing ? <IconButton icon="close" label="Clear search" size={32} iconSize={18} onPress={() => setQuery('')} /> : null}
          </Row>
        </Panel>
      </Row>

      {typing ? (
        results.length ? (
          <View style={{ gap: 8 }}>
            <SectionLabel size={12} tracking={1.2}>{`Results · ${results.length}`}</SectionLabel>
            <Panel padding={{ v: 4, h: 16 }}>{results.map(row)}</Panel>
          </View>
        ) : q.trim() ? (
          <EmptyState icon="search" title="No settings found" body={`Nothing matches “${q.trim()}”. Try another word, like “data” or “lyrics”.`} />
        ) : null
      ) : (
        <>
          {recent.length ? (
            <View style={{ gap: 8 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <SectionLabel size={12} tracking={1.2}>Recent searches</SectionLabel>
                <Tap onPress={() => setRecent([])} accessibilityRole="button" accessibilityLabel="Clear recent searches" style={{ minHeight: 44, justifyContent: 'center' }}>
                  <T size={13} color={colors.accentLight}>
                    Clear
                  </T>
                </Tap>
              </Row>
              <Row gap={8} style={{ flexWrap: 'wrap' }}>
                {recent.map((r) => (
                  <Tap key={r} onPress={() => setQuery(r)} accessibilityRole="button" accessibilityLabel={`Search ${r}`}>
                    <Panel radius={19} style={{ height: 38, paddingHorizontal: 16, justifyContent: 'center' }}>
                      <T size={13} weight={600}>
                        {r}
                      </T>
                    </Panel>
                  </Tap>
                ))}
              </Row>
            </View>
          ) : null}
          <View style={{ gap: 8 }}>
            <SectionLabel size={12} tracking={1.2}>Popular</SectionLabel>
            <Panel padding={{ v: 4, h: 16 }}>{POPULAR_SETTINGS.map(row)}</Panel>
          </View>
        </>
      )}
    </Screen>
  );
}
