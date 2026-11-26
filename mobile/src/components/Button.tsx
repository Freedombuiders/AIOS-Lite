import { ActivityIndicator, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { MIN_TARGET, colors, radius } from '@/theme';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  accessibilityHint?: string;
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

const palette = {
  primary: { bg: colors.accent, fg: colors.onAccent, border: colors.accent },
  danger: { bg: colors.danger, fg: colors.onAccent, border: colors.danger },
  secondary: { bg: colors.controlBg, fg: colors.text, border: colors.controlBorder },
  ghost: { bg: 'transparent', fg: colors.text, border: 'transparent' },
} as const;

export function Button({ label, onPress, variant = 'primary', disabled, loading, accessibilityHint, accessibilityLabel, testID, style }: ButtonProps) {
  const p = palette[variant];
  const inactive = !!disabled || !!loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: p.bg, borderColor: p.border },
        pressed && styles.pressed,
        disabled && !loading && styles.disabled,
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={p.fg} /> : null}
      <Text variant="body" weight="semibold" style={{ color: p.fg }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: MIN_TARGET + 4,
    minWidth: MIN_TARGET,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.55 },
});
