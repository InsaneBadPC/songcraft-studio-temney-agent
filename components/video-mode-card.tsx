import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Haptics from "expo-haptics";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Hairline, Radius, Space, Type } from "@/lib/design-tokens";
import { useColors } from "@/hooks/use-colors";

/**
 * Karta režimu videa v tabu Videa.
 *
 * Dvě úrovně: hlavní karta (typ 1 nebo typ 2) a podkarta (2a/2b/2c). Jedna
 * komponenta, protože vizuálně jsou stejné a rozdíl je jen v odsazení.
 */
export function VideoModeCard({
  icon,
  label,
  detail,
  selected,
  expanded,
  disabled,
  disabledLabel,
  onPress,
  nested = false,
}: {
  icon: string;
  label: string;
  detail: string;
  selected: boolean;
  /** U hlavní karty, která má podkarty: šipka dolů nahoru. */
  expanded?: boolean;
  disabled?: boolean;
  /** Proč je karta nedostupná - ukážeme místo detalu. */
  disabledLabel?: string;
  onPress: () => void;
  nested?: boolean;
}) {
  const colors = useColors();
  const unavailable = Boolean(disabled);

  const tint = unavailable ? colors.mutedSubtle : selected ? colors.primary : colors.foreground;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled: unavailable }}
      accessibilityLabel={label}
      accessibilityHint={detail}
      disabled={unavailable}
      onPress={() => {
        Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      style={({ pressed }) => [
        styles.card,
        nested && styles.nested,
        {
          backgroundColor: selected ? `${colors.primary}14` : colors.surface,
          borderColor: selected ? colors.primary : Hairline,
          borderLeftWidth: nested ? 3 : StyleSheet.hairlineWidth,
          borderLeftColor: selected ? colors.primary : Hairline,
          opacity: unavailable ? 0.55 : pressed ? 0.75 : 1,
        },
      ]}
    >
      <View
        style={[
          styles.icon,
          { backgroundColor: selected ? colors.primary : colors.surfaceElevated },
        ]}
      >
        <MaterialIcons
          name={icon as never}
          size={22}
          color={selected ? colors.onPrimary : unavailable ? colors.mutedSubtle : colors.primary}
        />
      </View>

      <View style={styles.copy}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={[Type.heading, styles.title, { color: tint }]}>
            {label}
          </Text>
          {expanded !== undefined ? (
            <MaterialIcons
              name={expanded ? "keyboard-arrow-up" : "keyboard-arrow-down"}
              size={20}
              color={colors.muted}
            />
          ) : selected ? (
            <MaterialIcons name="check-circle" size={19} color={colors.primary} />
          ) : null}
        </View>
        <Text numberOfLines={2} style={[Type.caption, { color: colors.muted }]}>
          {unavailable && disabledLabel ? disabledLabel : detail}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * Vodorovná lišta, která ukazuje složení videa.
 *
 * Obál alba → scény → obál alba. Není to náhled videa, je to přesně popis,
 * který renderer dostane. Když se to liší od toho, co renderer vyrobí, je to
 * podklad pro hlášení chyby.
 */
export function VideoCompositionStrip({
  coverSeconds,
  sceneSeconds,
  sceneLabels,
  note,
}: {
  coverSeconds: number;
  sceneSeconds: number | null;
  /** Popisky scén, které se opakují: "3 obrázky", "2 scény", "obrázky i scény". */
  sceneLabels: string;
  note?: string | null;
}) {
  const colors = useColors();
  const chip = (label: string, icon: string, strong: boolean) => (
    <View
      style={[
        styles.chip,
        {
          backgroundColor: strong ? colors.primary : colors.surfaceElevated,
          borderColor: strong ? colors.primary : Hairline,
        },
      ]}
    >
      <MaterialIcons
        name={icon as never}
        size={13}
        color={strong ? colors.onPrimary : colors.muted}
      />
      <Text
        style={[
          Type.caption,
          { color: strong ? colors.onPrimary : colors.foreground, fontWeight: "700" },
        ]}
      >
        {label}
      </Text>
    </View>
  );

  return (
    <View style={styles.stripWrap}>
      <View style={styles.strip}>
        {chip(`Obál alba ${coverSeconds} s`, "album", true)}
        <MaterialIcons name="chevron-right" size={16} color={colors.mutedSubtle} />
        {sceneSeconds === null
          ? chip(sceneLabels, "loop", false)
          : chip(`${sceneLabels} · ${sceneSeconds} s`, "photo-library", false)}
        <MaterialIcons name="chevron-right" size={16} color={colors.mutedSubtle} />
        {chip(`Obál alba ${coverSeconds} s`, "album", true)}
      </View>
      {note ? (
        <Text style={[Type.caption, { color: colors.mutedSubtle }]}>{note}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: 72,
    borderRadius: Radius.md,
    borderWidth: 1,
    padding: Space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: Space.md,
  },
  nested: {
    minHeight: 64,
    paddingLeft: Space.sm,
  },
  icon: {
    width: 42,
    height: 42,
    borderRadius: Radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: {
    flex: 1,
    gap: 3,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Space.sm,
  },
  title: {
    flex: 1,
  },
  stripWrap: {
    gap: Space.xs,
  },
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: Space.xs,
    flexWrap: "wrap",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 30,
    paddingHorizontal: Space.md,
    borderRadius: Radius.pill,
    borderWidth: 1,
  },
});
