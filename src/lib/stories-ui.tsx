import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { Cover, Icon, T, Tap, useAsync } from '../components';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';
import { loadStoryGroups } from './stories';

/** Horizontal rail of people with live stories (yours first). Hidden when signed out or on error. */
export function StoriesRail() {
  const { user, profile } = useAuth();
  const me = user?.id;
  const res = useAsync(() => (me ? loadStoryGroups(me) : Promise.resolve([])), [me], 'lib/stories-ui:13');
  if (!me || res.error) return null;
  const groups = res.data ?? [];
  const mine = groups.find((g) => g.mine);
  const others = groups.filter((g) => !g.mine);

  const ring = (unseen: boolean) => ({ width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', borderWidth: 2.5, borderColor: unseen ? colors.accent : withAlpha(colors.white, 0.22) }) as const;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16, flexGrow: 0 }} contentContainerStyle={{ gap: 14, paddingHorizontal: 16 }}>
      <Tap onPress={() => router.push(mine ? { pathname: '/stories', params: { user: me } } : { pathname: '/stories', params: { compose: '1' } })} accessibilityLabel={mine ? 'Your story' : 'Add to your story'} style={{ alignItems: 'center', gap: 6, width: 72 }}>
        <View style={ring(false)}>
          <Cover uri={profile?.avatar_url} id={me} size={54} radius={27} style={{ alignItems: 'center', justifyContent: 'center' }}>
            {profile?.avatar_url ? null : (
              <T size={20} weight={600} color={colors.white}>
                {(profile?.display_name?.[0] ?? '?').toUpperCase()}
              </T>
            )}
          </Cover>
          {mine ? null : (
            <View style={{ position: 'absolute', right: -2, bottom: -2, width: 22, height: 22, borderRadius: 11, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.bg }}>
              <Icon name="plus" size={12} color={colors.white} />
            </View>
          )}
        </View>
        <T size={12} color={colors.textSecondary} numberOfLines={1}>
          {mine ? 'Your story' : 'Add story'}
        </T>
      </Tap>
      {others.map((g) => (
        <Tap key={g.author.id} onPress={() => router.push({ pathname: '/stories', params: { user: g.author.id } })} accessibilityLabel={`${g.author.display_name}'s story${g.seen ? '' : ', new'}`} style={{ alignItems: 'center', gap: 6, width: 72 }}>
          <View style={ring(!g.seen)}>
            <Cover uri={g.author.avatar_url} id={g.author.id} size={54} radius={27} style={{ alignItems: 'center', justifyContent: 'center' }}>
              {g.author.avatar_url ? null : (
                <T size={20} weight={600} color={colors.white}>
                  {(g.author.display_name[0] ?? '?').toUpperCase()}
                </T>
              )}
            </Cover>
          </View>
          <T size={12} color={g.seen ? colors.textSecondary : colors.text} numberOfLines={1}>
            {g.author.display_name.split(' ')[0]}
          </T>
        </Tap>
      ))}
    </ScrollView>
  );
}
