import { BlurView } from 'expo-blur';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  Animated,
  BackHandler,
  Easing,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type TextInputInstance,
  type TextInputSelectionChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  EMOJI_CATEGORIES,
  getEmojiData,
  prewarmEmoji,
  recordRecentEmoji,
  searchEmoji,
  SKIN_TONE_LABELS,
  SKIN_TONE_SAMPLES,
  useRecentEmoji,
  useSkinTone,
  withTone,
  type EmojiCategoryKey,
  type EmojiItem,
  type SkinTone,
} from '../lib/emoji';
import { colors, fonts, radius, shadow, withAlpha } from '../theme/tokens';
import { useReduceMotion } from './motion';
import { Icon, TopHighlight } from './primitives';

/**
 * Full emoji picker: category tabs (Recent, Smileys & People … Flags), search by name / keywords, recently
 * used (top 24), skin tones (tone button, or long-press an emoji), virtualized grid. Dataset: emojibase-data.
 *
 *  - `<EmojiPicker>`: the panel itself (the chat composer shows it in place of the keyboard).
 *  - `<EmojiPickerSheet>`: the same picker in a glass bottom sheet (reactions).
 *  - `useEmojiComposer()`: keyboard ⇄ picker switching + insert-at-cursor for a composer TextInput.
 */

const HEADER_H = 30;
const MIN_CELL = 44;

type GridRow = { key: string; kind: 'header'; title: string; cat: EmojiCategoryKey } | { key: string; kind: 'row'; items: EmojiItem[]; cat: EmojiCategoryKey };

export type EmojiPickerProps = {
  onPick: (emoji: string) => void;
  /** Total panel height (search + tabs + grid). */
  height: number;
  /** Emoji to mark as selected (e.g. my current reactions). */
  selected?: ReadonlySet<string>;
  /** Called when the search field gains / loses focus (the composer lets the keyboard share the space). */
  onSearchFocus?: (focused: boolean) => void;
};

export function EmojiPicker({ onPick, height, selected, onSearchFocus }: EmojiPickerProps) {
  const { width: winW } = useWindowDimensions();
  const [width, setWidth] = useState(winW);
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [toneOpen, setToneOpen] = useState(false);
  const [toneFor, setToneFor] = useState<EmojiItem | null>(null);
  const [active, setActive] = useState<EmojiCategoryKey>('recent');
  const [tone, setTone] = useSkinTone();
  const recents = useRecentEmoji();
  const list = useRef<FlatList<GridRow>>(null);

  // Build the dataset after the first frame so opening never blocks on it.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        getEmojiData();
      } finally {
        setReady(true);
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const cols = Math.max(7, Math.floor((width - 8) / 46));
  const cell = Math.max(MIN_CELL, Math.floor((width - 8) / cols));

  const recentItems = useMemo(() => {
    if (!ready) return [];
    const by = getEmojiData().byGlyph;
    // Recents keep their exact glyph (tone included), so they are never re-toned.
    return recents.map((e) => ({ e, name: by.get(e)?.name ?? e, hay: '' }) as EmojiItem);
  }, [ready, recents]);

  const q = query.trim();
  const { rows, offsets, catIndex } = useMemo(() => {
    const out: GridRow[] = [];
    const idx = new Map<EmojiCategoryKey, number>();
    if (!ready) return { rows: out, offsets: [0], catIndex: idx };
    const chunk = (items: EmojiItem[], cat: EmojiCategoryKey) => {
      for (let i = 0; i < items.length; i += cols) out.push({ key: `${cat}-${i}`, kind: 'row', items: items.slice(i, i + cols), cat });
    };
    if (q) {
      const found = searchEmoji(q);
      out.push({ key: 'h-search', kind: 'header', title: found.length ? 'Search results' : 'No emoji found', cat: 'recent' });
      chunk(found, 'recent');
    } else {
      const cats = [{ key: 'recent' as const, title: 'Recently used', items: recentItems }, ...getEmojiData().categories];
      for (const c of cats) {
        if (!c.items.length) continue;
        idx.set(c.key, out.length);
        out.push({ key: `h-${c.key}`, kind: 'header', title: c.title, cat: c.key });
        chunk(c.items, c.key);
      }
    }
    const offs = [0];
    for (const r of out) offs.push(offs[offs.length - 1] + (r.kind === 'header' ? HEADER_H : cell));
    return { rows: out, offsets: offs, catIndex: idx };
  }, [ready, q, cols, cell, recentItems]);

  const pick = useCallback(
    (e: string) => {
      recordRecentEmoji(e);
      onPick(e);
    },
    [onPick],
  );
  const onLong = useCallback((it: EmojiItem) => (it.skins ? setToneFor(it) : undefined), []);

  const jump = (k: EmojiCategoryKey) => {
    const i = catIndex.get(k);
    if (i === undefined) return;
    setActive(k);
    list.current?.scrollToOffset({ offset: offsets[i], animated: false });
  };

  const onScroll = (y: number) => {
    // Last category header at or above the top edge.
    let cur: EmojiCategoryKey = 'recent';
    for (const [k, i] of catIndex) if (offsets[i] <= y + 4) cur = k;
    if (cur !== active) setActive(cur);
  };

  const chromeH = 52 + 44 + (toneOpen || toneFor ? 52 : 0);
  const gridH = Math.max(cell * 2 + HEADER_H, (searchFocused ? Math.min(height, cell * 3 + chromeH) : height) - chromeH);

  return (
    <View onLayout={(e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width))} style={{ height: searchFocused ? undefined : height }}>
      {/* search + skin tone */}
      <View style={styles.searchRow}>
        <View style={styles.search}>
          <Icon name="search" size={16} color={colors.textSecondary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search emoji"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="Search emoji"
            returnKeyType="search"
            autoCorrect={false}
            onFocus={() => {
              setSearchFocused(true);
              onSearchFocus?.(true);
            }}
            onBlur={() => {
              setSearchFocused(false);
              onSearchFocus?.(false);
            }}
            style={styles.searchInput}
          />
          {query ? (
            <Pressable onPress={() => setQuery('')} accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={10} style={styles.clear}>
              <Icon name="close" size={14} color={colors.textSecondary} />
            </Pressable>
          ) : null}
        </View>
        <Pressable
          onPress={() => {
            setToneFor(null);
            setToneOpen((v) => !v);
          }}
          accessibilityRole="button"
          accessibilityLabel={`Skin tone: ${SKIN_TONE_LABELS[tone]}`}
          accessibilityHint="Choose the default skin tone"
          accessibilityState={{ expanded: toneOpen }}
          style={[styles.toneBtn, toneOpen && { borderColor: colors.accent }]}
        >
          <Text style={styles.toneGlyph}>{SKIN_TONE_SAMPLES[tone]}</Text>
        </Pressable>
      </View>

      {toneFor || toneOpen ? (
        <View style={styles.toneRow} accessibilityLabel={toneFor ? `Skin tones for ${toneFor.name}` : 'Default skin tone'}>
          {([0, 1, 2, 3, 4, 5] as SkinTone[]).map((t) => {
            const glyph = toneFor ? withTone(toneFor, t) : SKIN_TONE_SAMPLES[t];
            const on = !toneFor && t === tone;
            return (
              <Pressable
                key={t}
                onPress={() => {
                  setTone(t);
                  if (toneFor) {
                    pick(glyph);
                    setToneFor(null);
                  } else setToneOpen(false);
                }}
                accessibilityRole="button"
                accessibilityLabel={toneFor ? `${toneFor.name}, ${SKIN_TONE_LABELS[t].toLowerCase()}` : `${SKIN_TONE_LABELS[t]} skin tone`}
                accessibilityState={{ selected: on }}
                style={[styles.toneCell, on && { backgroundColor: colors.accentTint, borderColor: colors.accent }]}
              >
                <Text style={styles.toneGlyph}>{glyph}</Text>
              </Pressable>
            );
          })}
          {toneFor ? (
            <Pressable onPress={() => setToneFor(null)} accessibilityRole="button" accessibilityLabel="Close skin tones" hitSlop={8} style={styles.clear}>
              <Icon name="close" size={14} color={colors.textSecondary} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* grid */}
      <View style={{ height: gridH }}>
        {ready ? (
          <FlatList
            ref={list}
            data={rows}
            keyExtractor={(r) => r.key}
            extraData={tone + (selected ? [...selected].join('') : '')}
            renderItem={({ item }) =>
              item.kind === 'header' ? (
                <View style={styles.header}>
                  <Text style={styles.headerText} accessibilityRole="header">
                    {item.title}
                  </Text>
                </View>
              ) : (
                <EmojiRow items={item.items} cell={cell} tone={item.cat === 'recent' ? 0 : tone} selected={selected} onPick={pick} onLong={onLong} />
              )
            }
            getItemLayout={(_d, i) => ({ length: offsets[i + 1] - offsets[i], offset: offsets[i], index: i })}
            initialNumToRender={Math.ceil(height / cell) + 2}
            maxToRenderPerBatch={10}
            windowSize={9}
            removeClippedSubviews={Platform.OS === 'android'}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="none"
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={64}
            onScroll={q ? undefined : (e) => onScroll(e.nativeEvent.contentOffset.y)}
            contentContainerStyle={{ paddingHorizontal: 4, paddingBottom: 8 }}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel="Loading emoji">
            <Text style={{ fontSize: 28, opacity: 0.5 }}>😀</Text>
          </View>
        )}
      </View>

      {/* category tabs */}
      {q ? null : (
        <View style={styles.tabs} accessibilityRole="tablist">
          {EMOJI_CATEGORIES.map((c) => {
            const on = active === c.key;
            return (
              <Pressable
                key={c.key}
                onPress={() => jump(c.key)}
                accessibilityRole="tab"
                accessibilityLabel={c.title}
                accessibilityState={{ selected: on }}
                style={styles.tab}
              >
                <Text style={[styles.tabGlyph, { opacity: on ? 1 : 0.45 }]}>{c.icon}</Text>
                <View style={[styles.tabBar, { backgroundColor: on ? colors.accent : 'transparent' }]} />
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

const EmojiRow = memo(function EmojiRow({
  items,
  cell,
  tone,
  selected,
  onPick,
  onLong,
}: {
  items: EmojiItem[];
  cell: number;
  tone: SkinTone;
  selected?: ReadonlySet<string>;
  onPick: (e: string) => void;
  onLong: (it: EmojiItem) => void;
}) {
  const fs = Math.min(30, Math.round(cell * 0.62));
  return (
    <View style={{ flexDirection: 'row', height: cell }}>
      {items.map((it) => {
        const glyph = withTone(it, tone);
        const on = !!selected?.has(glyph);
        return (
          <Pressable
            key={it.e}
            onPress={() => onPick(glyph)}
            onLongPress={it.skins ? () => onLong(it) : undefined}
            delayLongPress={350}
            accessibilityRole="button"
            accessibilityLabel={it.name}
            accessibilityHint={it.skins ? 'Long press for skin tones' : undefined}
            accessibilityState={on ? { selected: true } : undefined}
            style={({ pressed }) => [
              { width: cell, height: cell, alignItems: 'center', justifyContent: 'center', borderRadius: radius.xs },
              on && { backgroundColor: colors.accentTint },
              pressed && { backgroundColor: withAlpha(colors.white, 0.1) },
            ]}
          >
            <Text allowFontScaling={false} style={{ fontSize: fs, lineHeight: Math.round(fs * 1.25), color: colors.text }}>
              {glyph}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
});

/* ------------------------------------------------------------------ composer panel + hook */

/** Height of the last keyboard shown (the picker takes the same space, so the composer doesn't jump). */
let lastKeyboardH = 0;

/**
 * Keyboard ⇄ emoji panel switching for a composer. Spread `inputProps` on the TextInput, call `onInputFocus()`
 * from its `onFocus`, wire the smiley button to `toggle`, and render `<EmojiPanel {...panelProps} />` under the input.
 * Emoji are inserted at the cursor (the selection is tracked while the keyboard is up).
 */
export function useEmojiComposer(draft: string, onDraft: (t: string) => void, inputRef: RefObject<TextInputInstance | null>, maxLength = 2000) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState({ start: draft.length, end: draft.length });
  const insets = useSafeAreaInsets();

  useEffect(() => prewarmEmoji(), []);
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', (e) => {
      lastKeyboardH = e.endCoordinates.height;
    });
    return () => sub.remove();
  }, []);
  // Android back closes the panel first.
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setOpen(false);
      return true;
    });
    return () => sub.remove();
  }, [open]);

  const len = draft.length;
  const clamped = { start: Math.min(sel.start, len), end: Math.min(sel.end, len) };

  const toggle = useCallback(() => {
    if (open) {
      setOpen(false);
      inputRef.current?.focus();
    } else {
      Keyboard.dismiss();
      setOpen(true);
    }
  }, [open, inputRef]);

  const insert = (e: string) => {
    const next = draft.slice(0, clamped.start) + e + draft.slice(clamped.end);
    if (next.length > maxLength) return;
    onDraft(next);
    const at = clamped.start + e.length;
    setSel({ start: at, end: at });
  };

  // iOS keyboard height includes the home-indicator inset, which the screen footer already adds.
  const kb = lastKeyboardH ? lastKeyboardH - (Platform.OS === 'ios' ? insets.bottom : 0) : 300;
  const height = Math.round(Math.min(380, Math.max(280, kb)));

  return {
    open,
    toggle,
    close: () => setOpen(false),
    /** Call from the TextInput's onFocus: tapping the input brings the keyboard back and closes the panel. */
    onInputFocus: () => setOpen(false),
    inputProps: {
      onSelectionChange: (ev: TextInputSelectionChangeEvent) => setSel(ev.nativeEvent.selection),
      // Pinned while the panel is open so inserts move the caret; released once typing resumes.
      selection: open ? clamped : undefined,
    },
    panelProps: { onPick: insert, height },
  };
}

/** The picker as a bottom panel in place of the keyboard (fades / rises in unless Reduce Motion). */
export function EmojiPanel({ onPick, height }: { onPick: (e: string) => void; height: number }) {
  const reduce = useReduceMotion();
  const [t] = useState(() => new Animated.Value(reduce ? 1 : 0));
  useEffect(() => {
    if (reduce) return;
    Animated.timing(t, { toValue: 1, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [t, reduce]);
  const [y] = useState(() => t.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }));
  return (
    <Animated.View style={[styles.panel, { opacity: t, transform: [{ translateY: y }] }]} accessibilityLabel="Emoji picker">
      <EmojiPicker onPick={onPick} height={height} />
    </Animated.View>
  );
}

/* ------------------------------------------------------------------ sheet (reactions) */

/** The picker in a glass bottom sheet (same look as `Sheet`): used to react with any emoji. */
export function EmojiPickerSheet({ visible, onClose, onPick, selected, title = 'React' }: { visible: boolean; onClose: () => void; onPick: (e: string) => void; selected?: ReadonlySet<string>; title?: string }) {
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  const reduce = useReduceMotion();
  const [y] = useState(() => new Animated.Value(600));

  useEffect(() => {
    if (!visible) return;
    if (reduce) y.setValue(0);
    else {
      y.setValue(600);
      Animated.spring(y, { toValue: 0, damping: 22, stiffness: 220, mass: 0.9, useNativeDriver: true }).start();
    }
  }, [visible, reduce, y]);

  const close = useCallback(() => {
    Keyboard.dismiss();
    if (reduce) return onClose();
    Animated.timing(y, { toValue: 600, duration: 200, easing: Easing.in(Easing.quad), useNativeDriver: true }).start(() => onClose());
  }, [reduce, y, onClose]);

  const [scrim] = useState(() => y.interpolate({ inputRange: [0, 600], outputRange: [1, 0], extrapolate: 'clamp' }));
  const h = Math.round(Math.min(520, winH * 0.62));

  return (
    <Modal visible={visible} transparent animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={close}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: scrim }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="Close emoji picker" onPress={close} style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]} />
        </Animated.View>
        <Animated.View style={[styles.sheet, shadow.float, { paddingBottom: Math.max(16, insets.bottom), transform: [{ translateY: y }] }]}>
          {Platform.OS === 'ios' ? <BlurView tint="dark" intensity={50} style={StyleSheet.absoluteFill} /> : null}
          <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.sheet }]} />
          <TopHighlight radius={36} color={withAlpha(colors.white, 0.22)} />
          <View style={{ paddingTop: 12, paddingBottom: 4, alignItems: 'center' }}>
            <View style={styles.handle} />
          </View>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle} accessibilityRole="header">
              {title}
            </Text>
            <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8} style={styles.sheetClose}>
              <Icon name="close" size={18} color={colors.textSecondary} />
            </Pressable>
          </View>
          <View style={{ paddingHorizontal: 8 }}>
            <EmojiPicker
              height={h}
              selected={selected}
              onPick={(e) => {
                onPick(e);
                close();
              }}
            />
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginHorizontal: 8,
    paddingHorizontal: 4,
    borderRadius: 28,
    overflow: 'hidden',
    backgroundColor: withAlpha(colors.white, 0.05),
    borderWidth: 1,
    borderColor: withAlpha(colors.white, 0.12),
  },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 52, paddingHorizontal: 6 },
  search: {
    flex: 1,
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 12,
    paddingRight: 6,
    borderRadius: 20,
    backgroundColor: withAlpha(colors.white, 0.07),
    borderWidth: 1,
    borderColor: withAlpha(colors.white, 0.1),
  },
  searchInput: { flex: 1, height: 40, color: colors.text, fontFamily: fonts.regular, fontSize: 15, paddingVertical: 0 },
  clear: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  toneBtn: { width: 44, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: withAlpha(colors.white, 0.1), backgroundColor: withAlpha(colors.white, 0.07) },
  toneGlyph: { fontSize: 22, lineHeight: 28, color: colors.text },
  toneRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 52, paddingHorizontal: 6 },
  toneCell: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'transparent' },
  header: { height: HEADER_H, justifyContent: 'flex-end', paddingHorizontal: 6, paddingBottom: 4 },
  headerText: { color: colors.textSecondary, fontFamily: fonts.semibold, fontSize: 12, letterSpacing: 0.3 },
  tabs: { flexDirection: 'row', height: 44, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabGlyph: { fontSize: 18, lineHeight: 24 },
  tabBar: { position: 'absolute', bottom: 2, width: 18, height: 3, borderRadius: 2 },
  sheet: { borderTopLeftRadius: 36, borderTopRightRadius: 36, overflow: 'hidden', borderWidth: 1, borderBottomWidth: 0, borderColor: colors.glassBorder },
  handle: { width: 40, height: 5, borderRadius: 3, backgroundColor: colors.handle },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 4 },
  sheetTitle: { color: colors.text, fontFamily: fonts.semibold, fontSize: 18 },
  sheetClose: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
