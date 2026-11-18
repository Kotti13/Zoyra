import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Glass, Row, Screen, T, Tap } from '../components';
import { peerFromParams } from '../lib/chat';
import { ChatAvatar } from '../lib/chat-ui';
import { DialogButton, DialogIcon, DialogNote, dialogColors, DrawnCheck, PopIn, useDialogFocus } from '../lib/confirm-ui';
import { friendlySocialError, unblockUser } from '../lib/social';
import { REPORT_EMAIL } from '../lib/youtube';
import { colors, withAlpha } from '../theme/tokens';

/**
 * Blocked done (`/blocked-done?uid=&name=&avatar=&report=failed`), shown in place of Confirm block.
 * Undo unblocks straight away (the block happened seconds ago) and goes back to where you were.
 */
export default function BlockedDone() {
  const params = useLocalSearchParams<{ uid?: string; name?: string; avatar?: string; report?: string }>();
  const person = peerFromParams(params.uid, params.name, params.avatar);
  const name = person?.display_name?.trim() || 'This person';
  const titleRef = useDialogFocus();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(
    params.report === 'failed' ? { ok: false, text: `No mail app found. To report, email ${REPORT_EMAIL} with user id ${person?.id ?? ''}.` } : null,
  );
  const [undone, setUndone] = useState(false);

  const undo = async () => {
    if (!person || busy) return;
    setBusy(true);
    setNote(null);
    try {
      await unblockUser(person.id);
      setUndone(true);
      setNote({ ok: true, text: `${name} is unblocked` });
      if (router.canGoBack()) router.back();
    } catch (e) {
      setNote({ ok: false, text: friendlySocialError(e, 'Could not unblock. Try again.') });
    } finally {
      setBusy(false);
    }
  };

  const toMessages = () => router.dismissTo('/messages');

  return (
    <Screen scroll={false} gap={0} stagger={false}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 48, paddingHorizontal: 8, gap: 18 }}>
        <PopIn style={{ width: 96, height: 96, borderRadius: 48, backgroundColor: withAlpha(dialogColors.done, 0.14), borderWidth: 2, borderColor: withAlpha(dialogColors.done, 0.5), alignItems: 'center', justifyContent: 'center' }}>
          <View accessible={false} importantForAccessibility="no-hide-descendants">
            {undone ? <DialogIcon name="undo" size={40} color={dialogColors.done} /> : <DrawnCheck color={dialogColors.done} />}
          </View>
        </PopIn>
        <View ref={titleRef} accessible accessibilityRole="header">
          <T size={26} weight={300} tracking={-0.4} align="center">
            {undone ? `${name} is unblocked` : `${name} is blocked`}
          </T>
        </View>
        <T size={15} color={dialogColors.body} lineHeight={22} align="center" style={{ maxWidth: 300 }}>
          {undone ? 'They can message, call and see your activity again.' : "They can't message, call or see your activity. We didn't notify them."}
        </T>

        {person ? (
          <Glass radius={26} padding={14} style={{ width: '100%' }}>
            <Row gap={12}>
              <ChatAvatar person={person} size={44} radius={15} />
              <View style={{ flex: 1, gap: 2 }}>
                <T size={15} weight={600} numberOfLines={1}>
                  {name}
                </T>
                <T size={12} color={colors.textSecondary}>
                  {undone ? 'Unblocked' : 'Blocked just now'}
                </T>
              </View>
              {undone ? null : (
                <Tap
                  onPress={() => void undo()}
                  disabled={busy}
                  accessibilityLabel={`Undo, unblock ${name}`}
                  accessibilityState={{ busy }}
                  hitSlop={4}
                  style={{ height: 40, paddingHorizontal: 14, borderRadius: 20, backgroundColor: withAlpha(colors.white, 0.1), flexDirection: 'row', alignItems: 'center', gap: 6 }}
                >
                  {busy ? <ActivityIndicator size="small" color={colors.text} /> : <DialogIcon name="undo" size={16} color={colors.text} />}
                  <T size={13} weight={600}>
                    Undo
                  </T>
                </Tap>
              )}
            </Row>
          </Glass>
        ) : null}

        <DialogNote text={note?.text ?? null} ok={note?.ok} />

        <View style={{ width: '100%', gap: 10, marginTop: 12 }}>
          <DialogButton label="Back to messages" kind="accent" onPress={toMessages} />
          <DialogButton label="Manage blocked accounts" onPress={() => router.push('/blocked')} />
        </View>
      </View>
    </Screen>
  );
}
