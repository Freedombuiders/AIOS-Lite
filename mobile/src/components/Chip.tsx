import { Pressable, StyleSheet } from 'react-native';
import { MIN_TARGET, colors, radius } from '@/theme';
import { Text } from './Text';

export interface ChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** 'radio' inside a single-choice group, 'button' otherwise (it still announces its selected state). */
  role?: 'radio' | 'button';
  testID?: string;
}

export function Chip({ label, selected, onPress, role = 'button', testID }: ChipProps) {
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={role === 'radio' ? { checked: selected } : { selected }}
      onPress={onPress}
      testID={testID}
      style={[styles.base, selected && styles.selected]}
    >
      <Text variant="small" weight="medium" color={selected ? 'accentHover' : 'textMuted'}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: MIN_TARGET,
    paddingHorizontal: 16,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  selected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
});
