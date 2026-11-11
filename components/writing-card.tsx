import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/use-colors";
import { Hairline, Radius, Type, alpha } from "@/lib/design-tokens";
import { formatTextStats } from "@/lib/text-stats";

export function WritingCard({
  icon,
  label,
  helper,
  value,
  placeholder,
  onPress,
  lines = 4,
}: {
  icon: React.ComponentProps<typeof MaterialIcons>["name"];
  label: string;
  helper: string;
  value: string;
  placeholder: string;
  onPress: () => void;
  lines?: number;
}) {
  const colors = useColors();
  const empty = !value.trim();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. Otevřít editor.`}
      onPress={onPress}
      style={({ pressed }) => [styles.card, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.82 : 1 }]}
    >
      <View style={styles.top}>
        <View style={[styles.icon, { backgroundColor: alpha(colors.primary, 0.12) }]}>
          <MaterialIcons name={icon} size={20} color={colors.primary} />
        </View>
        <View style={styles.copy}>
          <Text style={[Type.heading, { color: colors.foreground }]}>{label}</Text>
          <Text style={[Type.caption, { color: colors.muted }]}>{helper}</Text>
        </View>
        <View style={[styles.open, { backgroundColor: alpha(colors.primary, 0.09), borderColor: alpha(colors.primary, 0.28) }]}>
          <Text style={[Type.caption, { color: colors.primary }]}>Otevřít</Text>
          <MaterialIcons name="arrow-forward" size={14} color={colors.primary} />
        </View>
      </View>
      <View style={[styles.preview, { backgroundColor: colors.background, borderColor: Hairline }]}>
        <Text numberOfLines={lines} style={[styles.previewText, { color: empty ? colors.muted : colors.foreground }]}>
          {empty ? placeholder : value}
        </Text>
      </View>
      <View style={styles.footer}>
        <Text style={[Type.caption, { color: colors.muted }]}>{formatTextStats(value)}</Text>
        <MaterialIcons name="edit-note" size={16} color={colors.muted} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: Radius.lg, padding: 14, gap: 10 },
  top: { flexDirection: "row", alignItems: "center", gap: 10 },
  icon: { width: 40, height: 40, borderRadius: Radius.md, alignItems: "center", justifyContent: "center" },
  copy: { flex: 1, gap: 2 },
  open: { minHeight: 28, borderRadius: Radius.pill, borderWidth: 1, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 4 },
  preview: { minHeight: 78, borderWidth: 1, borderRadius: Radius.md, padding: 12, justifyContent: "center" },
  previewText: { fontSize: 14, lineHeight: 21 },
  footer: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
});
