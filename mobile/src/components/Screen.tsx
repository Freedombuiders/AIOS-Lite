import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/theme';
import { Text } from './Text';

/** A screen with the app background and, optionally, a big title. `top` pads for the status bar (tab screens have no native header). */
export function Screen({ title, children, top = false, style }: { title?: string; children: ReactNode; top?: boolean; style?: StyleProp<ViewStyle> }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, top && { paddingTop: insets.top }, style]}>
      {title ? <Text variant="title" accessibilityRole="header" style={styles.title}>{title}</Text> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  title: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
});
