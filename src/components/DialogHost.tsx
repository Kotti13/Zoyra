import { useEffect, useState } from 'react';
import { Modal, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DialogBody, DialogButton, DialogTitle, FactRow, dialogColors } from '../lib/confirm-ui';
import { settleDialog, subscribeDialogs, type DialogAction, type DialogRequest } from '../lib/dialog';
import { colors, withAlpha } from '../theme/tokens';
import { ModalCard } from './layout';
import { Icon, T } from './primitives';

const kindFor = (a: DialogAction) => (a.style === 'destructive' ? 'danger' : a.style === 'primary' ? 'accent' : 'ghost');

const toneColors = {
  danger: { bg: withAlpha(dialogColors.danger, 0.16), fg: dialogColors.dangerText },
  success: { bg: withAlpha(dialogColors.done, 0.16), fg: dialogColors.done },
  default: { bg: withAlpha(colors.accent, 0.16), fg: colors.accent },
} as const;

/**
 * Renders every in-app confirmation / alert requested through `showDialog` (src/lib/dialog.ts) as the
 * centered glass dialog from the Confirm clear / Confirm block designs. Mount once at the root.
 * One dialog at a time; later requests wait in a queue. Backdrop tap and Android back = dismiss (null).
 */
export function DialogHost() {
  const insets = useSafeAreaInsets();
  const [req, setReq] = useState<DialogRequest | null>(null);

  useEffect(() => subscribeDialogs(setReq), []);

  if (!req) return null;
  const dismiss = () => settleDialog(req.id, null);
  const tone = toneColors[req.tone ?? 'default'];
  const label = req.message ? `${req.title}. ${req.message}` : req.title;

  const actions = req.actions.length ? req.actions : [{ label: 'OK', style: 'primary' as const }];
  const sideBySide = actions.length === 2;
  // Two buttons sit in a row with Cancel first (Confirm clear); otherwise they stack with Cancel last (Confirm block).
  const ordered = sideBySide
    ? [...actions].sort((a, b) => Number(b.style === 'cancel') - Number(a.style === 'cancel'))
    : [...actions].sort((a, b) => Number(a.style === 'cancel') - Number(b.style === 'cancel'));

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={dismiss} supportedOrientations={['portrait', 'landscape']}>
      <View style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }}>
        <ModalCard key={req.id} onDismiss={dismiss}>
          <DialogBody label={label}>
            {req.icon ? (
              <View
                importantForAccessibility="no-hide-descendants"
                accessibilityElementsHidden
                style={{ alignSelf: 'center', width: 64, height: 64, borderRadius: 32, backgroundColor: tone.bg, alignItems: 'center', justifyContent: 'center' }}
              >
                <Icon name={req.icon} size={28} color={tone.fg} />
              </View>
            ) : null}
            <View style={{ alignItems: 'center', gap: 8 }}>
              <DialogTitle>{req.title}</DialogTitle>
              {req.message ? (
                <T size={14} color={colors.textSecondary} align="center" lineHeight={20}>
                  {req.message}
                </T>
              ) : null}
            </View>
            {req.facts?.length ? (
              <View style={{ gap: 12 }}>
                {req.facts.map((f) => (
                  <FactRow key={f.text} icon={f.icon} text={f.text} />
                ))}
              </View>
            ) : null}
            <View style={{ flexDirection: sideBySide ? 'row' : 'column', gap: 10 }}>
              {ordered.map((a) => (
                <DialogButton key={a.label} label={a.label} kind={kindFor(a)} flex={sideBySide} onPress={() => settleDialog(req.id, a.label)} />
              ))}
            </View>
          </DialogBody>
        </ModalCard>
      </View>
    </Modal>
  );
}
