import { Tabs } from "expo-router";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";

import { HapticTab } from "@/components/haptic-tab";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { UpdateBanner } from "@/components/update-banner";
import { useColors } from "@/hooks/use-colors";

export default function TabLayout() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const bottomPadding = Platform.OS === "web" ? 12 : Math.max(insets.bottom, 12);

  return (
    <>
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarButton: HapticTab,
        tabBarBackground: () => (
          <View style={{ flex: 1, backgroundColor: colors.background, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.08)" }}>
            <View style={{ flex: 1, backgroundColor: "rgba(22,28,40,0.85)" }} />
          </View>
        ),
        tabBarStyle: {
          height: 64 + bottomPadding,
          paddingTop: 8,
          paddingBottom: bottomPadding,
          paddingHorizontal: 8,
          backgroundColor: colors.background,
          borderTopWidth: 1,
          borderTopColor: "rgba(255,255,255,0.08)",
          shadowColor: "#000",
          shadowOpacity: 0.22,
          shadowRadius: 24,
          shadowOffset: { width: 0, height: -8 },
          elevation: 16,
        },
        tabBarLabelStyle: { fontSize: 10, fontWeight: "700", letterSpacing: 0.3, marginTop: 2 },
        tabBarItemStyle: { minHeight: 44, minWidth: 44, paddingVertical: 4 },
        tabBarIconStyle: { marginBottom: 0 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Přehled", tabBarIcon: ({ color, focused }) => <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: focused ? `${colors.primary}18` : "transparent", alignItems: "center", justifyContent: "center", borderWidth: focused ? 1 : 0, borderColor: focused ? "rgba(255,255,255,0.08)" : "transparent" }}><IconSymbol size={20} name="house.fill" color={color} /></View> }} />
      <Tabs.Screen name="texts" options={{ title: "Texty", tabBarIcon: ({ color, focused }) => <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: focused ? `${colors.primary}18` : "transparent", alignItems: "center", justifyContent: "center", borderWidth: focused ? 1 : 0, borderColor: focused ? "rgba(255,255,255,0.08)" : "transparent" }}><IconSymbol size={20} name="square.and.pencil" color={color} /></View> }} />
      <Tabs.Screen name="albums" options={{ title: "Alba", tabBarIcon: ({ color, focused }) => <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: focused ? `${colors.primary}18` : "transparent", alignItems: "center", justifyContent: "center", borderWidth: focused ? 1 : 0, borderColor: focused ? "rgba(255,255,255,0.08)" : "transparent" }}><IconSymbol size={20} name="rectangle.stack.fill" color={color} /></View> }} />
      <Tabs.Screen name="library" options={{ title: "Knihovna", tabBarIcon: ({ color, focused }) => <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: focused ? `${colors.primary}18` : "transparent", alignItems: "center", justifyContent: "center", borderWidth: focused ? 1 : 0, borderColor: focused ? "rgba(255,255,255,0.08)" : "transparent" }}><IconSymbol size={20} name="music.note.list" color={color} /></View> }} />
      <Tabs.Screen name="assistant" options={{ title: "Temney Agent", tabBarIcon: ({ color, focused }) => <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: focused ? `${colors.primary}18` : "transparent", alignItems: "center", justifyContent: "center", borderWidth: focused ? 1 : 0, borderColor: focused ? "rgba(255,255,255,0.08)" : "transparent" }}><IconSymbol size={20} name="sparkles" color={color} /></View> }} />
      <Tabs.Screen name="settings" options={{ title: "Nastavení", tabBarIcon: ({ color, focused }) => <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: focused ? `${colors.primary}18` : "transparent", alignItems: "center", justifyContent: "center", borderWidth: focused ? 1 : 0, borderColor: focused ? "rgba(255,255,255,0.08)" : "transparent" }}><IconSymbol size={20} name="gearshape.fill" color={color} /></View> }} />
    </Tabs>
    <UpdateBanner />
    </>
  );
}
