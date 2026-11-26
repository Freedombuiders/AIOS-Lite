import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { useT } from '@/i18n';
import { colors, fontFamily } from '@/theme';

type IconName = keyof typeof Ionicons.glyphMap;

const icon = (name: IconName, focusedName: IconName) =>
  function TabIcon({ color, size, focused }: { color: ColorValue; size: number; focused: boolean }) {
    return <Ionicons name={focused ? focusedName : name} size={size} color={color as string} />;
  };

export default function TabsLayout() {
  const t = useT();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accentHover,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { backgroundColor: colors.sidebar, borderTopColor: colors.border },
        tabBarLabelStyle: { fontFamily: fontFamily.medium, fontSize: 12 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: t('tabs.attention'), tabBarIcon: icon('notifications-outline', 'notifications') }} />
      <Tabs.Screen name="inbox" options={{ title: t('tabs.inbox'), tabBarIcon: icon('chatbubbles-outline', 'chatbubbles') }} />
      <Tabs.Screen name="store" options={{ title: t('tabs.store'), tabBarIcon: icon('library-outline', 'library') }} />
      <Tabs.Screen name="settings" options={{ title: t('tabs.settings'), tabBarIcon: icon('settings-outline', 'settings') }} />
    </Tabs>
  );
}
