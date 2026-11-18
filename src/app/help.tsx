import { useMemo, useState } from 'react';
import { Linking, TextInput, View } from 'react-native';

import { Button, EmptyState, Glass, Icon, Row, Screen, ScreenHeader, SectionHeader, Spacer, T, Tap, Toast } from '../components';
import { useAuth } from '../state/auth';
import type { IconName } from '../components';
import { colors, fonts } from '../theme/tokens';

const topics: { label: string; icon: IconName }[] = [
  { label: 'Account', icon: 'user' },
  { label: 'Downloads', icon: 'download' },
  { label: 'Playback', icon: 'speaker' },
  { label: 'Billing', icon: 'lock' },
];

const faqs: { q: string; a: string; topic: string }[] = [
  {
    topic: 'Downloads',
    q: 'How do I download songs?',
    a: 'Tap the download button on any song, album, playlist or podcast episode. Downloaded songs play without internet — find them in Library → Downloads.',
  },
  {
    topic: 'Playback',
    q: 'Why is my audio quality lower?',
    a: 'Zoyra lowers streaming quality on slow or metered connections. Set your preferred quality in Settings › Audio.',
  },
  {
    topic: 'Billing',
    q: 'How do I cancel Premium?',
    a: 'In-app purchases are not live yet, so nobody is being charged. Once they launch, you will manage your subscription from Settings › Billing.',
  },
  {
    topic: 'Account',
    q: 'How do I reset my password?',
    a: 'On the sign-in screen tap Forgot password and enter your email. We will send you a link to set a new one.',
  },
  {
    topic: 'Playback',
    q: 'Where does the music come from?',
    a: 'Zoyra streams free, legal music from independent artists. Follow artists you like to see their new releases first.',
  },
  {
    topic: 'Account',
    q: 'How do I make my profile private?',
    a: 'Open Settings › Privacy and turn on Private profile. Only people you approve can see your activity.',
  },
];

export default function Help() {
  const { user } = useAuth();
  const [open, setOpen] = useState<number | null>(0);
  const [query, setQuery] = useState('');
  const [topic, setTopic] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return faqs.filter((f) => (!topic || f.topic === topic) && (!q || `${f.q} ${f.a} ${f.topic}`.toLowerCase().includes(q)));
  }, [query, topic]);

  const contact = () => {
    const subject = encodeURIComponent(topic ? `Zoyra help: ${topic}` : 'Zoyra help');
    const body = encodeURIComponent(user?.email ? `\n\n—\nAccount: ${user.email}` : '');
    const url = `mailto:support@zoyra.app?subject=${subject}&body=${body}`;
    setNote(null);
    Linking.openURL(url).catch(() => setNote('No mail app found. Email us at support@zoyra.app'));
  };

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'dots', mesh: 'peach' }} contentStyle={{ flexGrow: 1 }}>
      <ScreenHeader title="Help center" />

      <Row gap={8} style={{ height: 52, borderRadius: 26, backgroundColor: colors.bgTertiary, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 18 }}>
        <Icon name="search" size={20} color={colors.textSecondary} />
        <TextInput
          value={query}
          onChangeText={(v) => {
            setQuery(v);
            setOpen(null);
          }}
          placeholder="How can we help?"
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Search help"
          style={{ flex: 1, height: 44, color: colors.text, fontFamily: fonts.regular, fontSize: 16 }}
        />
      </Row>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {topics.map((t) => (
          <Tap
            key={t.label}
            accessibilityLabel={t.label}
            accessibilityState={{ selected: topic === t.label }}
            onPress={() => {
              setTopic((cur) => (cur === t.label ? null : t.label));
              setOpen(null);
            }}
            style={{ width: '47%', flexGrow: 1 }}
          >
            <Glass radius={36} padding={14} style={[{ height: 96, justifyContent: 'space-between' }, topic === t.label && { borderWidth: 2, borderColor: colors.accentLight }]}>
              <Icon name={t.icon} size={26} color={colors.accentLight} />
              <T size={14} weight={600}>
                {t.label}
              </T>
            </Glass>
          </Tap>
        ))}
      </View>

      <SectionHeader title={topic ?? (query.trim() ? 'Results' : 'Popular questions')} action={topic ? 'Clear' : undefined} onAction={() => setTopic(null)} />
      {shown.length ? (
      <Glass padding={16}>
        {shown.map((f, i) => {
          const isOpen = open === i;
          return (
            <View key={f.q} style={{ borderTopWidth: 1, borderTopColor: colors.divider, paddingVertical: 12, gap: 8 }}>
              <Tap
                onPress={() => setOpen(isOpen ? null : i)}
                accessibilityState={{ expanded: isOpen }}
                style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
              >
                <T size={16} weight={600} style={{ flex: 1 }}>
                  {f.q}
                </T>
                <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={20} color={colors.textSecondary} />
              </Tap>
              {isOpen ? (
                <T size={14} color={colors.textSecondary} lineHeight={21}>
                  {f.a}
                </T>
              ) : null}
            </View>
          );
        })}
      </Glass>
      ) : (
        <EmptyState icon="search" title="No answers found" body="Try other words, or contact support below." />
      )}

      <Spacer />

      {note ? <Toast icon="info" iconColor={colors.accentLight} message={note} /> : null}
      <Button label="Contact support" icon="mail" onPress={contact} />
    </Screen>
  );
}
