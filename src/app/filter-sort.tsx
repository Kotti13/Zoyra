import { router } from 'expo-router';
import { useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';

import { Button, Chip, Row, Sheet, T, Tap } from '../components';
import { GENRES, MOOD_MAP } from '../lib/catalog';
import { colors } from '../theme/tokens';

/* ------------------------------------------------------------------ shared search filter store (read by Search) */

export const SEARCH_SORTS = ['Relevance', 'Newest', 'Most played', 'Alphabetical'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];
export type SearchFilterState = { sort: SearchSort; genres: string[]; moods: string[] };

const DEFAULT_FILTERS: SearchFilterState = { sort: 'Relevance', genres: [], moods: [] };
let filterState: SearchFilterState = DEFAULT_FILTERS;
const filterListeners = new Set<() => void>();

export const searchFilters = {
  get: () => filterState,
  set: (next: SearchFilterState) => {
    filterState = next;
    filterListeners.forEach((l) => l());
  },
  reset: () => searchFilters.set(DEFAULT_FILTERS),
  subscribe: (cb: () => void) => {
    filterListeners.add(cb);
    return () => {
      filterListeners.delete(cb);
    };
  },
  isActive: (s: SearchFilterState) => s.sort !== 'Relevance' || s.genres.length > 0 || s.moods.length > 0,
};

export function useSearchFilters() {
  return useSyncExternalStore(searchFilters.subscribe, searchFilters.get, searchFilters.get);
}

/* ------------------------------------------------------------------ sheet */

const genres = GENRES.slice(0, 8) as readonly string[];
const moods = Object.keys(MOOD_MAP);

function Label({ children }: { children: string }) {
  return (
    <T size={12} weight={600} tracking={0.5} color={colors.textSecondary}>
      {children}
    </T>
  );
}

function MultiChips({ options, selected, onToggle }: { options: readonly string[]; selected: string[]; onToggle: (o: string) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, rowGap: 4 }}>
      {options.map((o) => (
        <Chip key={o} label={o} active={selected.includes(o)} onPress={() => onToggle(o)} />
      ))}
    </View>
  );
}

const toggleIn = (list: string[], o: string) => (list.includes(o) ? list.filter((x) => x !== o) : [...list, o]);

export default function FilterSort() {
  const initial = searchFilters.get();
  const [sort, setSort] = useState<SearchSort>(initial.sort);
  const [genre, setGenre] = useState<string[]>(initial.genres);
  const [mood, setMood] = useState<string[]>(initial.moods);

  return (
    <Sheet>
      <T variant="section" accessibilityRole="header">
        Sort and filter
      </T>

      <Label>SORT BY</Label>
      {SEARCH_SORTS.map((s) => {
        const on = s === sort;
        return (
          <Tap
            key={s}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            onPress={() => setSort(s)}
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48 }}
          >
            <T size={16}>{s}</T>
            <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: on ? colors.accentLight : colors.textTertiary, alignItems: 'center', justifyContent: 'center' }}>
              {on ? <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.accentLight }} /> : null}
            </View>
          </Tap>
        );
      })}

      <Label>GENRE</Label>
      <MultiChips options={genres} selected={genre} onToggle={(o) => setGenre((g) => toggleIn(g, o))} />

      <Label>MOOD</Label>
      <MultiChips options={moods} selected={mood} onToggle={(o) => setMood((l) => toggleIn(l, o))} />

      <Row>
        <Button
          label="Reset"
          variant="glass"
          style={{ flex: 1 }}
          onPress={() => {
            setSort('Relevance');
            setGenre([]);
            setMood([]);
          }}
        />
        <Button
          label="Apply"
          style={{ flex: 1 }}
          onPress={() => {
            searchFilters.set({ sort, genres: genre, moods: mood });
            if (router.canGoBack()) router.back();
            else router.replace('/search');
          }}
        />
      </Row>
    </Sheet>
  );
}
