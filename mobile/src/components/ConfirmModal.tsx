import { Modal, StyleSheet, View } from 'react-native';
import { colors, radius } from '@/theme';
import { Button } from './Button';
import { Text } from './Text';

export interface ConfirmModalProps {
  visible: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** An explicit yes/no for something that cannot be undone. The destructive button is never the default focus target. */
export function ConfirmModal({ visible, title, body, confirmLabel, cancelLabel, busy, error, onConfirm, onCancel }: ConfirmModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={busy ? undefined : onCancel} accessibilityViewIsModal>
      <View style={styles.backdrop}>
        <View style={styles.sheet} accessibilityViewIsModal testID="confirm-modal">
          <Text variant="heading" accessibilityRole="header">{title}</Text>
          <Text color="textMuted">{body}</Text>
          {error ? <Text color="danger" accessibilityRole="alert" testID="confirm-error">{error}</Text> : null}
          <View style={styles.actions}>
            <Button label={cancelLabel} variant="secondary" onPress={onCancel} disabled={busy} testID="confirm-cancel" style={styles.flex} />
            <Button label={confirmLabel} variant="danger" onPress={onConfirm} loading={busy} testID="confirm-ok" style={styles.flex} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
  sheet: { backgroundColor: colors.elevated, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.borderStrong, padding: 20, gap: 12 },
  actions: { flexDirection: 'row', gap: 12, marginTop: 4 },
  flex: { flex: 1 },
});
