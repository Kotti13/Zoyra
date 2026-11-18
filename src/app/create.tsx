import { useState } from 'react';
import { View } from 'react-native';

import { Art, ChipRow, EmptyState, Glass, Icon, OutlineTag, Row, Screen, ScreenHeader, T, Tap, TextField } from '../components';
import { FILTERS, filterTools, type StudioTool } from '../lib/studio';
import { colors, radius } from '../theme/tokens';

const STATUS_LABEL: Record<StudioTool['status'], string> = {
  ready: 'Works on device',
  server: 'Uses a stem service',
  unavailable: 'Not available in this version',
};

function ToolCard({ tool }: { tool: StudioTool }) {
  const off = tool.status === 'unavailable';
  const body = (
    <Glass radius={radius.card} padding={14} style={off ? { opacity: 0.72 } : undefined}>
      <Row gap={14} align="flex-start">
        <Art art={tool.art} size={58} radius={19} style={{ alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={tool.icon} size={26} color={colors.white} strokeWidth={1.6} />
        </Art>
        <View style={{ flex: 1, gap: 4 }}>
          <T size={17} weight={500}>
            {tool.title}
          </T>
          <T size={13} weight={300} color={colors.textSecondary} lineHeight={18}>
            {off && tool.note ? tool.note : tool.blurb}
          </T>
          <View style={{ alignSelf: 'flex-start', marginTop: 4 }}>
            <OutlineTag label={STATUS_LABEL[tool.status]} color={off ? colors.textSecondary : tool.status === 'ready' ? colors.success : colors.accentLight} />
          </View>
        </View>
        {off ? null : <Icon name="chevronRight" size={20} color={colors.textSecondary} strokeWidth={1.6} />}
      </Row>
    </Glass>
  );
  if (off) {
    // Informational only: not a dead button.
    return (
      <View accessible accessibilityLabel={`${tool.title}. ${tool.note ?? STATUS_LABEL.unavailable}`}>
        {body}
      </View>
    );
  }
  return (
    <Tap
      href={{ pathname: '/create-tool', params: { tool: tool.id } }}
      accessibilityRole="button"
      accessibilityLabel={`${tool.title}. ${tool.blurb}`}
      accessibilityHint="Opens the tool"
    >
      {body}
    </Tap>
  );
}

/** Create studio hub: sound tools, filtered by chips and search. */
export default function Create() {
  const [filter, setFilter] = useState(0);
  const [query, setQuery] = useState('');
  const tools = filterTools(FILTERS[filter], query);

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'none', orbs: true }}>
      <ScreenHeader title="Create" />
      <TextField label="Search tools" hideLabel placeholder="Search" value={query} onChangeText={setQuery} icon="search" returnKeyType="search" autoCorrect={false} />
      <ChipRow options={[...FILTERS]} initial={filter} onChange={setFilter} />
      <T variant="section" accessibilityRole="header">
        Sound tools
      </T>
      {tools.length ? (
        tools.map((t) => <ToolCard key={t.id} tool={t} />)
      ) : (
        <EmptyState icon="search" title="No tools match" body="Try another filter or search word." />
      )}
      <T size={12} color={colors.textTertiary} lineHeight={17}>
        Vocal remover and Stem studio only work on your own files, or on Audius tracks the artist made downloadable or released under a Creative Commons licence that allows remixes.
      </T>
    </Screen>
  );
}
