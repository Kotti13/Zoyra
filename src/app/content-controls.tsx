import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Avatar, Cover, EmptyState, ErrorState, Icon, Row, Screen, T, Tap, TextField, Toast, Toggle, artFor, useAsync, useDebounced } from '../components';
import { BigHeader, Panel, PanelRow, SectionLabel } from '../components/settings-ui';
import { catalog, type Artist } from '../lib/catalog';
import { useContentFilter, type HiddenItem } from '../lib/content-filter';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

type Note = { ok: boolean; text: string } | null;

function HiddenRow({ item, divider, busy, onUnhide }: { item: HiddenItem; divider: boolean; busy: boolean; onUnhide: () => void }) {
  return (
    <PanelRow
      title={item.name || (item.kind === 'artist' ? 'Artist' : 'Song')}
      subtitle={item.subtitle}
      divider={divider}
      minHeight={60}
      leading={
        item.image ? (
          <Cover uri={item.image} id={item.id} size={40} radius={item.kind === 'artist' ? 20 : 8} />
        ) : (
          <Avatar initial={(item.name.trim().charAt(0) || '?').toUpperCase()} art={artFor(item.id)} size={40} />
        )
      }
      right={
        busy ? (
          <ActivityIndicator color={colors.accent} style={{ minWidth: 72, minHeight: 44 }} />
        ) : (
          <Tap onPress={onUnhide} accessibilityRole="button" accessibilityLabel={`Unhide ${item.name}`} style={{ minHeight: 44, minWidth: 72, alignItems: 'flex-end', justifyContent: 'center' }}>
            <T size={14} weight={600} color={colors.accentLight}>
              Unhide
            </T>
          </Tap>
        )
      }
    />
  );
}

/** Search the catalogue for an artist to hide. */
function HideArtistSearch({ hidden, onHide, busyId }: { hidden: ReadonlySet<string>; onHide: (a: Artist) => void; busyId: string | null }) {
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 350);
  const res = useAsync(() => (q.length >= 2 ? catalog.searchArtists(q, 6) : Promise.resolve([] as Artist[])), [q], 'app/content-controls:46');
  const list = (res.data ?? []).filter((a) => !hidden.has(a.id));

  return (
    <View style={{ gap: 8 }}>
      <TextField label="Hide an artist" hideLabel placeholder="Search for an artist to hide" icon="search" value={query} onChangeText={setQuery} autoCorrect={false} returnKeyType="search" />
      {q.length < 2 ? null : res.loading ? (
        <ActivityIndicator color={colors.accent} style={{ minHeight: 44 }} />
      ) : res.error ? (
        <ErrorState message={res.error} onRetry={res.reload} />
      ) : list.length ? (
        <Panel padding={{ v: 4, h: 16 }}>
          {list.map((a, i) => (
            <PanelRow
              key={a.id}
              title={a.name}
              subtitle={`@${a.handle}`}
              divider={i > 0}
              minHeight={60}
              leading={<Cover uri={a.image.small} id={a.id} size={40} radius={20} />}
              right={
                busyId === a.id ? (
                  <ActivityIndicator color={colors.accent} style={{ minWidth: 56, minHeight: 44 }} />
                ) : (
                  <Tap onPress={() => onHide(a)} accessibilityRole="button" accessibilityLabel={`Hide ${a.name}`} style={{ minHeight: 44, minWidth: 56, alignItems: 'flex-end', justifyContent: 'center' }}>
                    <T size={14} weight={600} color={colors.accentLight}>
                      Hide
                    </T>
                  </Tap>
                )
              }
            />
          ))}
        </Panel>
      ) : (
        <T size={13} color={colors.textSecondary}>
          No artists found for “{q}”.
        </T>
      )}
    </View>
  );
}

export default function ContentControls() {
  const { settings } = useAuth();
  const cf = useContentFilter();
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const artists = cf.items.filter((i) => i.kind === 'artist');
  const songs = cf.items.filter((i) => i.kind === 'track');

  const run = async (key: string, fn: () => Promise<void>, ok: string) => {
    if (busy) return;
    setBusy(key);
    setNote(null);
    try {
      await fn();
      setNote({ ok: true, text: ok });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Something went wrong' });
    } finally {
      setBusy(null);
    }
  };

  const toggleKidSafe = (v: boolean) => {
    setNote(null);
    cf.setKidSafe(v).catch((e: unknown) => setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not save' }));
  };

  return (
    <Screen top={4} gap={16} bottom={24} backdrop={{ pattern: 'none', mesh: 'coral' }}>
      <BigHeader title="Content" />

      <View>
        <Panel padding={{ v: 4, h: 16 }}>
        <PanelRow
          title="Kid-safe mode"
          subtitle="Hide songs the artist titled or tagged explicit. Same switch as Family plan."
          minHeight={72}
          right={settings ? <Toggle value={cf.kidSafe} onChange={toggleKidSafe} label="Kid-safe mode" /> : <ActivityIndicator color={colors.accent} />}
        />
      </Panel>
      </View>
      <Panel padding={14} radius={32}>
        <Row gap={10} align="flex-start">
          <Icon name="info" size={18} color={colors.textSecondary} />
          <T size={13} color={colors.textSecondary} style={{ flex: 1 }}>
            The Audius catalogue has no reliable explicit rating, so there’s no separate “Allow explicit” switch. Kid-safe mode can only catch songs the artist marked as explicit in the title or tags, and
            some explicit songs may still play.
          </T>
        </Row>
      </Panel>

      <View style={{ gap: 8 }}>
        <SectionLabel size={12} tracking={1.2}>Kids</SectionLabel>
        <Panel padding={{ v: 4, h: 16 }}>
        <PanelRow title="Kids mode" subtitle="Family friendly music, limits and a parent PIN" icon="shield" href="/kids-mode" />
      </Panel>
      </View>

      <View style={{ gap: 8 }}>
        <SectionLabel size={12} tracking={1.2}>{`HIDDEN ARTISTS${artists.length ? ` · ${artists.length}` : ''}`}</SectionLabel>
        <T size={13} color={colors.textSecondary}>
          Songs by hidden artists are skipped in your lists, mixes and queues.
        </T>
        <HideArtistSearch
          hidden={cf.hiddenArtists}
          busyId={busy}
          onHide={(a) => void run(a.id, () => cf.hideArtist({ id: a.id, name: a.name, image: a.image.small ?? null }), `${a.name} is hidden`)}
        />
        {cf.loading ? (
          <ActivityIndicator color={colors.accent} style={{ minHeight: 60 }} />
        ) : cf.error ? (
          <ErrorState message={cf.error} onRetry={() => void cf.reload()} />
        ) : artists.length ? (
          <Panel padding={{ v: 4, h: 16 }}>
            {artists.map((it, i) => (
              <HiddenRow key={it.id} item={it} divider={i > 0} busy={busy === `u:${it.id}`} onUnhide={() => void run(`u:${it.id}`, () => cf.unhide('artist', it.id), `${it.name} is back`)} />
            ))}
          </Panel>
        ) : (
          <T size={13} color={colors.textTertiary}>
            No hidden artists.
          </T>
        )}
      </View>

      <View style={{ gap: 8 }}>
        <SectionLabel size={12} tracking={1.2}>{`HIDDEN SONGS${songs.length ? ` · ${songs.length}` : ''}`}</SectionLabel>
        {cf.loading || cf.error ? null : songs.length ? (
          <Panel padding={{ v: 4, h: 16 }}>
            {songs.map((it, i) => (
              <HiddenRow key={it.id} item={it} divider={i > 0} busy={busy === `u:${it.id}`} onUnhide={() => void run(`u:${it.id}`, () => cf.unhide('track', it.id), `${it.name} is back`)} />
            ))}
          </Panel>
        ) : (
          <EmptyState icon="music" title="No hidden songs" body="Hide a song from its options menu and it won’t show up in your lists or queues." />
        )}
      </View>

      <View style={{ gap: 8 }}>
        <SectionLabel size={12} tracking={1.2}>Recommendations</SectionLabel>
        <Panel padding={{ v: 4, h: 16 }}>
        <PanelRow title="Private session and history" subtitle="Privacy and security" icon="shield" href="/privacy" />
        <PanelRow title="Family plan" subtitle="Members and kid-safe mode" icon="users" href="/family" divider />
      </Panel>
      </View>

      {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.error} message={note.text} /> : null}
    </Screen>
  );
}
