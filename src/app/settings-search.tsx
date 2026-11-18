import { router, type Href } from 'expo-router';
import { useMemo, useState } from 'react';
import { TextInput, View } from 'react-native';

import { EmptyState, Glass, Icon, IconButton, ListGroup, ListRow, Overline, Row, Screen, T, Tap, useDebounced } from '../components';
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
    <ListRow
      key={`${e.route}|${e.title}`}
      title={e.title}
      subtitle={e.section === 'Screen' ? 'Settings screen' : e.section}
      icon={e.icon}
      divider={i > 0}
      onPress={() => open(e)}
    />
  );

  return (
    <Screen top={4} gap={16} bottom={24} backdrop={{ pattern: 'none', mesh: 'coral' }} stagger={false}>
      <Row gap={8}>
        <IconButton icon="back" label="Back" href="back" />
        <Glass radius={26} style={{ flex: 1, height: 52, justifyContent: 'center', paddingHorizontal: 16 }}>
          <Row gap={10}>
            <Icon name="search" size={20} color={colors.textSecondary} />
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
        </Glass>
      </Row>

      {typing ? (
        results.length ? (
          <ListGroup title={`RESULTS · ${results.length}`}>{results.map(row)}</ListGroup>
        ) : q.trim() ? (
          <EmptyState icon="search" title="No settings found" body={`Nothing matches “${q.trim()}”. Try another word, like “data” or “lyrics”.`} />
        ) : null
      ) : (
        <>
          {recent.length ? (
            <View style={{ gap: 8 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Overline color={colors.textSecondary}>RECENT SEARCHES</Overline>
                <Tap onPress={() => setRecent([])} accessibilityRole="button" accessibilityLabel="Clear recent searches" style={{ minHeight: 44, justifyContent: 'center' }}>
                  <T size={13} color={colors.accentLight}>
                    Clear
                  </T>
                </Tap>
              </Row>
              <Glass padding={4}>
                {recent.map((r, i) => (
                  <ListRow
                    key={r}
                    title={r}
                    minHeight={52}
                    divider={i > 0}
                    onPress={() => setQuery(r)}
                    leading={<Icon name="clock" size={18} color={colors.textSecondary} />}
                    right={<Icon name="arrowRight" size={16} color={colors.textSecondary} />}
                  />
                ))}
              </Glass>
            </View>
          ) : null}
          <ListGroup title="POPULAR">{POPULAR_SETTINGS.map(row)}</ListGroup>
        </>
      )}
    </Screen>
  );
}
