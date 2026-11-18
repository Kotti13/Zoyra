import { View } from 'react-native';

import { eventDate, priceRange, type ConcertEvent } from '../lib/concerts';
import { colors } from '../theme/tokens';
import { LinkText, Sticker } from './controls';
import { Glass, Row, T } from './primitives';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** One concert listing: date block, name, venue/city/time, price range, Tickets link. */
export function EventCard({ e, following, onTickets, showCity = true }: { e: ConcertEvent; following?: boolean; onTickets: () => void; showCity?: boolean }) {
  const d = eventDate(e);
  const valid = !Number.isNaN(d.getTime());
  const time = /T\d{2}:\d{2}/.test(e.date) && valid ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : null;
  const meta = [e.venue, showCity ? e.city : null, time].filter(Boolean).join(' · ');
  const price = priceRange(e);
  return (
    <Glass radius={26} padding={14}>
      <Row gap={14}>
        <View style={{ width: 56, height: 64, borderRadius: 28, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
          <T variant="overline" color={colors.accentLight}>
            {valid ? MONTHS[d.getMonth()] : 'TBA'}
          </T>
          <T size={22} weight={700}>
            {valid ? String(d.getDate()).padStart(2, '0') : '–'}
          </T>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T size={16} weight={600} numberOfLines={2}>
            {e.name}
          </T>
          {meta ? (
            <T size={14} color={colors.textSecondary} numberOfLines={2}>
              {meta}
            </T>
          ) : null}
          {price ? (
            <T mono size={12} color={colors.textSecondary}>
              {price}
            </T>
          ) : null}
        </View>
        {following ? <Sticker label="FOLLOWING" rotate={3} style={{ alignSelf: 'center' }} /> : null}
        {e.url ? <LinkText label="Tickets" onPress={onTickets} /> : null}
      </Row>
    </Glass>
  );
}
