import { View, type ViewProps } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";

import { cn } from "@/lib/utils";
import { useColors } from "@/hooks/use-colors";
import { Hairline, alpha } from "@/lib/design-tokens";

export interface ScreenContainerProps extends ViewProps {
  edges?: Edge[];
  className?: string;
  containerClassName?: string;
  safeAreaClassName?: string;
}

export function ScreenContainer({
  children,
  edges = ["top", "left", "right"],
  className,
  containerClassName,
  safeAreaClassName,
  style,
  ...props
}: ScreenContainerProps) {
  const colors = useColors();
  return (
    <View className={cn("flex-1", containerClassName)} style={[{ backgroundColor: colors.background }, style]} {...props}>
      {/* Jeden zklidneny akcentovy glow odev, ne plocha. */}
      <LinearGradient
        colors={[alpha(colors.primary, 0.13), alpha(colors.primary, 0.04), "transparent"]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={{ position: "absolute", top: 0, left: 0, right: 0, height: 380 }}
        pointerEvents="none"
      />
      {/* Tepla stopa, ktera odlise stranku od sousedni. */}
      <View
        style={{
          position: "absolute",
          top: -60,
          right: -50,
          width: 220,
          height: 220,
          borderRadius: 110,
          backgroundColor: alpha(colors.secondary, 0.07),
        }}
        pointerEvents="none"
      />
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1, backgroundColor: Hairline }} pointerEvents="none" />
      <SafeAreaView edges={edges} className={cn("flex-1", safeAreaClassName)} style={{ flex: 1 }}>
        <View className={cn("flex-1", className)}>{children}</View>
      </SafeAreaView>
    </View>
  );
}