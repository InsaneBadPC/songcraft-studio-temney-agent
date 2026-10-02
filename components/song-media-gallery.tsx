import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Image } from "expo-image";
import { useMemo, useRef } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useColors } from "@/hooks/use-colors";
import { Hairline, Radius, Space, Type } from "@/lib/design-tokens";
import type { SongMediaItem, SongMediaKind } from "@/lib/song-media-types";

const TILE = 104;
const GAP = Space.sm;

/**
 * Panel doprovodných médií: obrázky a krátká videa, ze kterých se pak skládá
 * video k písni. Pořadí se měří tážením prstem - to je to, co uživatel chce
 * vidět a upravovat, ne číslované pole.
 */
export function SongMediaGallery({
  visible,
  items,
  busy,
  onClose,
  onAddImage,
  onAddVideo,
  onRemove,
  onReorder,
}: {
  visible: boolean;
  items: SongMediaItem[];
  busy: boolean;
  onClose: () => void;
  onAddImage: () => void;
  onAddVideo: () => void;
  onRemove: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
}) {
  const colors = useColors();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.shade, { backgroundColor: colors.scrim }]}>
        <View style={[styles.sheet, { backgroundColor: colors.background, borderColor: Hairline }]}>
          <View style={[styles.handle, { backgroundColor: colors.border }]} />
          <View style={styles.top}>
            <View style={styles.topCopy}>
              <Text style={[Type.heading, { color: colors.foreground }]}>Doprovodná média</Text>
              <Text style={[Type.caption, styles.subtitle, { color: colors.muted }]}>
                {items.length === 0
                  ? "Z těchto souborů se složí video: obrázek písně bude 5 s na začátku a 5 s na konci, mezi nimi se scény střídají po 8 s."
                  : `${items.length} ${items.length === 1 ? "položka" : items.length < 5 ? "položky" : "položek"} · tažením změníš pořadí`}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Zavřít"
              onPress={onClose}
              style={({ pressed }) => [styles.close, { backgroundColor: colors.surfaceElevated, opacity: pressed ? 0.7 : 1 }]}
            >
              <MaterialIcons name="close" size={19} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {items.length > 0 ? (
              <ReorderableGrid items={items} onReorder={onReorder} onRemove={onRemove} />
            ) : (
              <View style={[styles.empty, { borderColor: Hairline, backgroundColor: colors.surface }]}>
                <MaterialIcons name="perm-media" size={26} color={colors.primary} />
                <Text style={[Type.label, styles.emptyTitle, { color: colors.foreground }]}>
                  Zatím tu nic není
                </Text>
                <Text style={[Type.caption, styles.emptyText, { color: colors.muted }]}>
                  Přidej obrázky nebo krátká videa. Když tady bude jediný obrázek písně,
                  udělá se z něj smyčka stejně jako dnes.
                </Text>
              </View>
            )}
          </ScrollView>

          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onAddImage}
              style={({ pressed }) => [
                styles.action,
                { backgroundColor: colors.primary, opacity: busy || pressed ? 0.68 : 1 },
              ]}
            >
              {busy ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <MaterialIcons name="add-photo-alternate" size={19} color={colors.onPrimary} />
              )}
              <Text style={[Type.heading, { color: colors.onPrimary }]}>Přidat obrázek</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onAddVideo}
              style={({ pressed }) => [
                styles.actionOutline,
                { borderColor: colors.border, backgroundColor: colors.surface, opacity: busy || pressed ? 0.68 : 1 },
              ]}
            >
              <MaterialIcons name="video-library" size={19} color={colors.muted} />
              <Text style={[Type.heading, { color: colors.foregroundMuted }]}>Přidat video</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * Mřížka s přetahováním. Řádky po třech; položka se zvedne a po přesunu
 * nad sousední se místo vymění. Bez externí knihovny - PanResponder z
 * React Native stačí a nepřidává závislost.
 */
function ReorderableGrid({
  items,
  onReorder,
  onRemove,
}: {
  items: SongMediaItem[];
  onReorder: (orderedIds: string[]) => void;
  onRemove: (id: string) => void;
}) {
  const rows = useMemo(() => {
    const out: SongMediaItem[][] = [];
    for (let i = 0; i < items.length; i += 3) out.push(items.slice(i, i + 3));
    return out;
  }, [items]);

  return (
    <View style={styles.rows}>
      {rows.map((row, rowIndex) => (
        <View key={`row-${rowIndex}`} style={styles.row}>
          {row.map((item) => (
            <DraggableTile
              key={item.id}
              item={item}
              siblings={items}
              onReorder={onReorder}
              onRemove={onRemove}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

function DraggableTile({
  item,
  siblings,
  onReorder,
  onRemove,
}: {
  item: SongMediaItem;
  siblings: SongMediaItem[];
  onReorder: (orderedIds: string[]) => void;
  onRemove: (id: string) => void;
}) {
  const colors = useColors();
  const lift = useRef(new Animated.Value(0)).current;
  const dragging = useRef(false);
  const startX = useRef(0);

  const confirmRemove = () => {
    Alert.alert("Odebrat toto médium?", item.originalFileName || "Soubor zůstane v paměti telefonu, ale nebude ve videu.", [
      { text: "Zrušit", style: "cancel" },
      { text: "Odebrat", style: "destructive", onPress: () => onRemove(item.id) },
    ]);
  };

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6,
        onPanResponderGrant: () => {
          dragging.current = true;
          startX.current = Date.now();
          Animated.spring(lift, { toValue: 1, useNativeDriver: true, friction: 7 }).start();
        },
        onPanResponderRelease: (_e, g) => {
          Animated.spring(lift, { toValue: 0, useNativeDriver: true, friction: 7 }).start();
          // Krátký dotyk bez posunu = otevřít nabídku smazání.
          const moved = Math.abs(g.dx) + Math.abs(g.dy);
          if (!dragging.current || (moved < 8 && Date.now() - startX.current < 400)) {
            confirmRemove();
          }
          dragging.current = false;
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [item.id],
  );

  const shift = siblings.findIndex((s) => s.id === item.id);

  return (
    <Animated.View
      {...pan.panHandlers}
      accessibilityRole="button"
      accessibilityLabel={`${item.kind === "video" ? "Video" : "Obrázek"} ${shift + 1} z ${siblings.length}`}
      style={[
        styles.tile,
        {
          borderColor: Hairline,
          backgroundColor: colors.surface,
          transform: [
            { scale: lift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }) },
            { translateY: lift.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) },
          ],
          zIndex: lift.interpolate({ inputRange: [0, 1], outputRange: [0, 20] }),
        },
      ]}
    >
      {item.url ? (
        <Image
          source={{ uri: item.url }}
          style={styles.thumb}
          contentFit="cover"
          transition={120}
        />
      ) : (
        <View style={[styles.thumb, { backgroundColor: colors.surfaceElevated }]}>
          <MaterialIcons name="image-not-supported" size={20} color={colors.mutedSubtle} />
        </View>
      )}

      <View style={styles.badge}>
        <MaterialIcons
          name={item.kind === "video" ? "videocam" : "photo-camera"}
          size={12}
          color={colors.onPrimary}
        />
      </View>
      <View style={styles.orderBadge}>
        <Text style={[Type.caption, { color: colors.foreground }]}>{shift + 1}</Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Odebrat ${item.originalFileName || "médium"}`}
        onPress={confirmRemove}
        hitSlop={8}
        style={({ pressed }) => [styles.remove, { backgroundColor: colors.scrim, opacity: pressed ? 0.7 : 1 }]}
      >
        <MaterialIcons name="close" size={14} color="#FFFFFF" />
      </Pressable>
    </Animated.View>
  );
}

/** Posun na zvolenou pozici a uložení do DB. */
export function moveMedia(ordered: SongMediaItem[], from: number, to: number): string[] {
  const next = ordered.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next.map((entry) => entry.id);
}

const styles = StyleSheet.create({
  shade: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    maxHeight: "92%",
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    borderTopWidth: 1,
    paddingTop: Space.sm,
  },
  handle: { height: 4, width: 40, borderRadius: 3, alignSelf: "center", marginBottom: Space.md },
  top: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: Space.md,
    paddingHorizontal: Space.xl,
    paddingBottom: Space.md,
  },
  topCopy: { flex: 1, gap: 2 },
  subtitle: { lineHeight: 15 },
  close: { width: 38, height: 38, borderRadius: Radius.md, alignItems: "center", justifyContent: "center" },
  content: { paddingHorizontal: Space.xl, paddingBottom: Space.lg, gap: Space.md },
  rows: { gap: GAP },
  row: { flexDirection: "row", gap: GAP },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: Radius.md,
    borderWidth: 1,
    overflow: "hidden",
  },
  thumb: { width: "100%", height: "100%", backgroundColor: "#00000022" },
  badge: {
    position: "absolute",
    left: Space.xs,
    bottom: Space.xs,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: Radius.sm,
    backgroundColor: "rgba(0,0,0,0.62)",
  },
  orderBadge: {
    position: "absolute",
    right: Space.xs,
    top: Space.xs,
    minWidth: 20,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: Radius.sm,
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.62)",
  },
  remove: {
    position: "absolute",
    right: Space.xs,
    bottom: Space.xs,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  empty: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    padding: Space.xl,
    alignItems: "center",
    gap: Space.sm,
  },
  emptyTitle: { marginTop: Space.xs },
  emptyText: { textAlign: "center", lineHeight: 16 },
  actions: { flexDirection: "row", gap: Space.sm, paddingHorizontal: Space.xl, paddingTop: Space.md, paddingBottom: Space.xxl },
  action: {
    flex: 1,
    minHeight: 52,
    borderRadius: Radius.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Space.sm,
  },
  actionOutline: {
    flex: 1,
    minHeight: 52,
    borderRadius: Radius.md,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Space.sm,
  },
});

export type { SongMediaItem, SongMediaKind };