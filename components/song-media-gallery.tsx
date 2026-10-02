import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Image } from "expo-image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
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

/** Kolik posune dlaždička, když se posune o jedno místo v řadě. */
const STEP = TILE + GAP;
/** Pod tuto vzdálenost považujeme dotyk za kliknutí, ne za tah. */
const DEAD_ZONE = 8;

/**
 * Mřížka s přetahováním prstem.
 *
 * Tah nese stav grid, ne dlaždičky: když uživatel táhne, dlaždička, kterou
 * bere, letí s prstem a ty mezi ní a cílem se odsunou, aby viděl kam
 * přijde. Po puštění se pořadí uloží. Tap bez tahu (pod DEAD_ZONE) maže.
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
  const dragX = useRef(new Animated.Value(0)).current;
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);

  const finish = useCallback(
    (moved: boolean) => {
      if (moved && from !== null && to !== null && from !== to) {
        onReorder(moveMedia(items, from, to));
      }
      dragX.setValue(0);
      setFrom(null);
      setTo(null);
    },
    [from, to, items, onReorder, dragX],
  );

  return (
    <View style={styles.rows}>
      {items.map((item, index) => (
        <DraggableTile
          key={item.id}
          item={item}
          index={index}
          total={items.length}
          dragX={dragX}
          dragging={from === index}
          // kam dlaždička ustoupí, když se beru jina a posune se za ni
          shiftFor={from === null || to === null ? 0 : shiftOf(index, from, to)}
          onPickUp={() => {
            setFrom(index);
            setTo(index);
          }}
          onDragMove={(dx) => {
            dragX.setValue(dx);
            const next = clamp(index + Math.round(dx / STEP), 0, items.length - 1);
            setTo(next);
          }}
          onRelease={finish}
          onRemove={onRemove}
        />
      ))}
    </View>
  );
}

/**
 * Odsun pro dlaždičku, která se nepohybuje, ale uvolní místo táhnuté.
 * Při tahu doprava (to > from) se posunou ty mezi nimi doleva.
 */
function shiftOf(index: number, from: number, to: number): number {
  if (from === to) return 0;
  if (to > from && index > from && index <= to) return -STEP;
  if (to < from && index >= to && index < from) return STEP;
  return 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function DraggableTile({
  item,
  index,
  total,
  dragX,
  dragging,
  shiftFor,
  onPickUp,
  onDragMove,
  onRelease,
  onRemove,
}: {
  item: SongMediaItem;
  index: number;
  total: number;
  dragX: Animated.Value;
  dragging: boolean;
  shiftFor: number;
  onPickUp: () => void;
  onDragMove: (dx: number) => void;
  onRelease: (moved: boolean) => void;
  onRemove: (id: string) => void;
}) {
  const colors = useColors();
  const lift = useRef(new Animated.Value(0)).current;
  const settle = useRef(new Animated.Value(shiftFor)).current;
  const travelled = useRef(0);

  useEffect(() => {
    Animated.spring(settle, { toValue: shiftFor, useNativeDriver: false, friction: 8 }).start();
  }, [settle, shiftFor]);

  const confirmRemove = useCallback(() => {
    onRemove(item.id);
  }, [onRemove, item.id]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          travelled.current = 0;
          onPickUp();
          // Stín a elevation native driver nezvládne, proto JS driver.
          Animated.spring(lift, { toValue: 1, useNativeDriver: false, friction: 7 }).start();
        },
        onPanResponderMove: (_e, g) => {
          travelled.current = Math.abs(g.dx);
          onDragMove(g.dx);
        },
        onPanResponderRelease: () => {
          Animated.spring(lift, { toValue: 0, useNativeDriver: false, friction: 7 }).start();
          onRelease(travelled.current >= DEAD_ZONE);
        },
        onPanResponderTerminate: () => {
          Animated.spring(lift, { toValue: 0, useNativeDriver: false, friction: 7 }).start();
          onRelease(false);
        },
      }),
    [lift, onPickUp, onDragMove, onRelease],
  );

  return (
    <Animated.View
      {...pan.panHandlers}
      accessibilityRole="button"
      accessibilityLabel={
        dragging
          ? `Přesouváš ${item.kind === "video" ? "video" : "obrázek"} ${index + 1} z ${total}`
          : `${item.kind === "video" ? "Video" : "Obrázek"} ${index + 1} z ${total}. Přetáhni pro změnu pořadí, klepni pro smazání.`
      }
      style={[
        styles.tile,
        {
          borderColor: dragging ? colors.primary : Hairline,
          backgroundColor: colors.surface,
          zIndex: dragging ? 20 : 1,
          transform: [
            { translateX: dragging ? dragX : settle },
            { scale: lift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }) },
            { translateY: lift.interpolate({ inputRange: [0, 1], outputRange: [0, -8] }) },
          ],
          shadowColor: "#000000",
          shadowOpacity: lift.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.45] }),
          shadowRadius: lift.interpolate({ inputRange: [0, 1], outputRange: [8, 22] }),
          shadowOffset: { width: 0, height: 6 },
          elevation: lift.interpolate({ inputRange: [0, 1], outputRange: [2, 16] }),
        },
      ]}
    >
      {item.url ? (
        <Image source={{ uri: item.url }} style={styles.thumb} contentFit="cover" transition={120} />
      ) : (
        <View style={[styles.thumb, { backgroundColor: colors.surfaceElevated }]}>
          <MaterialIcons name="image-not-supported" size={20} color={colors.mutedSubtle} />
        </View>
      )}

      <View style={[styles.badge, dragging ? { backgroundColor: colors.primary } : null]}>
        <MaterialIcons
          name={item.kind === "video" ? "videocam" : "photo-camera"}
          size={12}
          color={dragging ? colors.onPrimary : "#FFFFFF"}
        />
      </View>
      <View style={[styles.orderBadge, dragging ? { backgroundColor: colors.primary } : null]}>
        <Text style={[Type.caption, { color: dragging ? colors.onPrimary : colors.foreground }]}>
          {index + 1}
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Odebrat ${item.originalFileName || "médium"}`}
        onPress={confirmRemove}
        hitSlop={6}
        disabled={dragging}
        style={({ pressed }) => [
          styles.remove,
          { backgroundColor: colors.scrim, opacity: pressed || dragging ? 0.5 : 1 },
        ]}
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
  rows: { flexDirection: "row", flexWrap: "wrap", gap: GAP },
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