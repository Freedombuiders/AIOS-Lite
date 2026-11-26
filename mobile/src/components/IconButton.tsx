import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { MIN_TARGET, colors, radius } from '@/theme';

type IconName = keyof typeof Ionicons.glyphMap;

export interface IconButtonProps {
  icon: IconName;
  /** Required: an icon alone says nothing to a screen reader. */
  label: string;
  onPress: () => void;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function IconButton({ icon, label, onPress, testID, style }: IconButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.base, pressed && { backgroundColor: colors.controlBg }, style]}
    >
      <Ionicons name={icon} size={22} color={colors.text} accessible={false} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { width: MIN_TARGET, height: MIN_TARGET, alignItems: 'center', justifyContent: 'center', borderRadius: radius.lg },
});
