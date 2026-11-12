import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, BackHandler, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { IconButton } from "@/components/studio-ui";
import { ScreenContainer } from "@/components/screen-container";
import { RhymeFinder } from "@/components/rhyme-finder";
import { WritingAssistant, type WritingMode } from "@/components/writing-assistant";
import { useColors } from "@/hooks/use-colors";
import { Hairline, OnPrimary, Radius, Type, alpha } from "@/lib/design-tokens";
import { formatTextStats } from "@/lib/text-stats";

export type EditorHistory = {
  value: string;
  canUndo: boolean;
  canRedo: boolean;
  change: (next: string, coalesce?: boolean) => void;
  undo: () => void;
  redo: () => void;
};

const SECTIONS = ["Intro", "Verse", "Pre-Chorus", "Chorus", "Bridge", "Outro"];
const PROMPT_TEMPLATE = "Žánr: \nTempo: \nNálada: \nNástroje: \nHlas: \nProdukce: ";
const SONG_STRUCTURE = `[Intro]\n\n\n[Verse 1]\n\n\n[Pre-Chorus]\n\n\n[Chorus]\n\n\n[Verse 2]\n\n\n[Chorus]\n\n\n[Bridge]\n\n\n[Chorus]\n\n\n[Outro]\n`;

export function WritingWorkspace({
  initialMode,
  title,
  status,
  lyrics,
  prompt,
  onClose,
  onSave,
  onComplete,
  saving,
  completing,
}: {
  initialMode: WritingMode;
  title: string;
  status?: string;
  lyrics: EditorHistory;
  prompt: EditorHistory;
  onClose: () => void;
  onSave: () => void | Promise<void>;
  onComplete?: () => void | Promise<void>;
  saving?: boolean;
  completing?: boolean;
}) {
  const colors = useColors();
  const [mode, setMode] = useState<WritingMode>(initialMode);
  const [selection, setSelection] = useState(() => {
    const value = initialMode === "lyrics" ? lyrics.value : prompt.value;
    return { start: value.length, end: value.length };
  });
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const inputRef = useRef<TextInput>(null);
  const active = mode === "lyrics" ? lyrics : prompt;

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);

  const switchMode = (next: WritingMode) => {
    if (next === mode) return;
    Haptics.selectionAsync().catch(() => {});
    setMode(next);
    const value = next === "lyrics" ? lyrics.value : prompt.value;
    setSelection({ start: value.length, end: value.length });
    setTimeout(() => inputRef.current?.focus(), 30);
  };

  const insertBlock = (text: string) => {
    const current = active.value;
    const start = Math.min(selection.start, current.length);
    const end = Math.min(selection.end, current.length);
    const before = current.slice(0, start);
    const after = current.slice(end);
    const prefix = before && !before.endsWith("\n") ? "\n" : "";
    const suffix = after && !after.startsWith("\n") ? "\n" : "";
    const next = `${before}${prefix}${text}${suffix}${after}`;
    active.change(next, false);
    const cursor = before.length + prefix.length + text.length;
    setSelection({ start: cursor, end: cursor });
    setTimeout(() => inputRef.current?.focus(), 30);
  };

  const insertInline = (text: string) => {
    const current = active.value;
    const start = Math.min(selection.start, current.length);
    const end = Math.min(selection.end, current.length);
    const before = current.slice(0, start);
    const after = current.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const next = `${before}${prefix}${text}${after}`;
    active.change(next, false);
    const cursor = before.length + prefix.length + text.length;
    setSelection({ start: cursor, end: cursor });
    setTimeout(() => inputRef.current?.focus(), 30);
  };

  const replaceSelection = (text: string) => {
    const current = active.value;
    const start = Math.min(selection.start, selection.end, current.length);
    const end = Math.min(Math.max(selection.start, selection.end), current.length);
    const next = `${current.slice(0, start)}${text}${current.slice(end)}`;
    active.change(next, false);
    const cursor = start + text.length;
    setSelection({ start: cursor, end: cursor });
    setTimeout(() => inputRef.current?.focus(), 30);
  };

  const selectAll = () => {
    if (!active.value) return;
    setSelection({ start: 0, end: active.value.length });
    setTimeout(() => inputRef.current?.focus(), 30);
  };

  const copyText = async () => {
    if (!active.value.trim()) return;
    const start = Math.min(selection.start, selection.end);
    const end = Math.max(selection.start, selection.end);
    const selected = active.value.slice(start, end);
    try {
      await Clipboard.setStringAsync(selected || active.value);
      Alert.alert("Zkopírováno", selected ? "Vybraný text je ve schránce." : mode === "lyrics" ? "Text písně je ve schránce." : "Prompt je ve schránce.");
    } catch {
      Alert.alert("Kopírování se nezdařilo", "Zkus to znovu.");
    }
  };

  const pasteText = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (!text) {
        Alert.alert("Schránka je prázdná", "Nejdřív zkopíruj text, který chceš vložit.");
        return;
      }
      replaceSelection(text);
    } catch {
      Alert.alert("Vložení se nezdařilo", "Zkus to znovu.");
    }
  };

  const clearText = () => {
    if (!active.value) return;
    Alert.alert(
      mode === "lyrics" ? "Vymazat text písně?" : "Vymazat prompt?",
      "Tuto akci můžeš vrátit tlačítkem Zpět.",
      [
        { text: "Zrušit", style: "cancel" },
        { text: "Vymazat", style: "destructive", onPress: () => active.change("", false) },
      ],
    );
  };

  const cleanBlankLines = () => {
    const next = active.value.replace(/\n{3,}/g, "\n\n").trim();
    active.change(next, false);
    setToolsOpen(false);
  };

  const insertStructure = () => {
    insertBlock(SONG_STRUCTURE.trim());
    setToolsOpen(false);
  };

  const findReplace = () => {
    if (!findText) return;
    const next = active.value.split(findText).join(replaceText);
    if (next !== active.value) active.change(next, false);
    setToolsOpen(false);
  };

  const statusLabel = status === "complete" ? "Hotová skladba" : "Rozpracovaný koncept";

  return (
    <ScreenContainer edges={["top", "bottom", "left", "right"]}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.keyboard}>
          <View style={styles.content}>
            <View style={styles.topbar}>
              <IconButton icon="close" label="Zavřít editor" onPress={onClose} />
              <View style={styles.titleBlock}>
                <Text style={[Type.overline, { color: colors.muted }]}>{statusLabel.toUpperCase()}</Text>
                <Text numberOfLines={1} style={[Type.heading, { color: colors.foreground }]}>{title.trim() || "Bez názvu"}</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Uložit text"
                disabled={saving}
                onPress={() => void onSave()}
                style={({ pressed }) => [styles.saveButton, { backgroundColor: colors.primary, opacity: saving || pressed ? 0.55 : 1 }]}
              >
                {saving ? <ActivityIndicator size="small" color={OnPrimary} /> : <MaterialIcons name="check" size={17} color={OnPrimary} />}
                <Text style={[Type.label, styles.saveText, { color: OnPrimary }]}>{saving ? "Ukládám" : "Uložit"}</Text>
              </Pressable>
            </View>

            <View style={[styles.modeSwitch, { backgroundColor: colors.surface, borderColor: Hairline }]}>
              <ModeButton active={mode === "lyrics"} icon="lyrics" label="Text písně" onPress={() => switchMode("lyrics")} colors={colors} />
              <ModeButton active={mode === "prompt"} icon="tune" label="Prompt stylu" onPress={() => switchMode("prompt")} colors={colors} />
            </View>

            <View style={[styles.editorCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={[styles.editorHead, { borderBottomColor: Hairline }]}>
                <Text style={[Type.label, styles.editorLabel, { color: colors.foreground }]}>{mode === "lyrics" ? "Text písně" : "Prompt stylu"}</Text>
                <Text style={[Type.caption, { color: colors.muted }]}>{formatTextStats(active.value)}</Text>
              </View>
              <TextInput
                ref={inputRef}
                value={active.value}
                selection={selection}
                onChangeText={(next) => active.change(next)}
                onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
                placeholder={mode === "lyrics" ? "[Verse]\nPíšu první řádek…" : "Žánr, tempo, nálada, nástroje, hlas…"}
                placeholderTextColor={colors.muted}
                multiline
                autoFocus
                textAlignVertical="top"
                disableFullscreenUI
                style={[styles.editorInput, { color: colors.foreground }]}
              />
            </View>

            <View style={styles.clipboardRow}>
              <ToolButton icon="select-all" label="Vybrat vše" disabled={!active.value} onPress={selectAll} colors={colors} />
              <ToolButton icon="content-copy" label="Kopírovat" disabled={!active.value.trim()} onPress={() => void copyText()} colors={colors} />
              <ToolButton icon="content-paste" label="Vložit" onPress={() => void pasteText()} colors={colors} />
            </View>

            {mode === "lyrics" ? (
              <View style={styles.sectionRow}>
                <Text style={[Type.caption, styles.sectionLabel, { color: colors.muted }]}>Vložit oddíl</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sectionChips} keyboardShouldPersistTaps="handled">
                  {SECTIONS.map((section) => (
                    <Pressable
                      key={section}
                      onPress={() => insertBlock(`[${section}]`)}
                      style={({ pressed }) => [styles.sectionChip, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
                    >
                      <Text style={[Type.caption, { color: colors.foreground }]}>[{section}]</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            ) : null}

            <View style={styles.toolbar}>
              <ToolButton icon="undo" label="Zpět" disabled={!active.canUndo} onPress={active.undo} colors={colors} />
              <ToolButton icon="redo" label="Vpřed" disabled={!active.canRedo} onPress={active.redo} colors={colors} />
              {mode === "lyrics" ? <RhymeFinder variant="toolbar" onInsert={insertInline} /> : null}
              <ToolButton icon="auto-awesome" label="AI asistent" tone="primary" onPress={() => setAssistantOpen(true)} colors={colors} />
              {mode === "prompt" ? <ToolButton icon="dashboard-customize" label="Šablona" onPress={() => insertBlock(PROMPT_TEMPLATE)} colors={colors} /> : null}
              {mode === "lyrics" ? <ToolButton icon="view-quilt" label="Struktura" onPress={insertStructure} colors={colors} /> : null}
              <ToolButton icon="build" label="Nástroje" onPress={() => setToolsOpen(true)} colors={colors} />
              <ToolButton icon="delete-outline" label="Vymazat" tone="danger" disabled={!active.value} onPress={clearText} colors={colors} />
            </View>
            {mode === "lyrics" && status !== "complete" && onComplete ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Označit jako hotové"
                disabled={saving || completing}
                onPress={() => void onComplete()}
                style={({ pressed }) => [styles.completeButton, { backgroundColor: colors.success, opacity: saving || completing || pressed ? 0.65 : 1 }]}
              >
                {completing ? <ActivityIndicator size="small" color={OnPrimary} /> : <MaterialIcons name="task-alt" size={18} color={OnPrimary} />}
                <Text style={[Type.label, styles.completeButtonText, { color: OnPrimary }]}>{completing ? "Dokončuji…" : "Označit jako hotové → Knihovna"}</Text>
              </Pressable>
            ) : null}
          </View>
        </KeyboardAvoidingView>
        <WritingAssistant
          visible={assistantOpen}
          mode={mode}
          title={title}
          text={active.value}
          onClose={() => setAssistantOpen(false)}
          onInsert={insertBlock}
        />
        <Modal visible={toolsOpen} transparent animationType="fade" onRequestClose={() => setToolsOpen(false)}>
          <Pressable style={styles.toolsShade} onPress={() => setToolsOpen(false)}>
            <Pressable style={[styles.toolsSheet, { backgroundColor: colors.background, borderColor: colors.border }]} onPress={(e) => e.stopPropagation()}>
              <Text style={[Type.heading, { color: colors.foreground }]}>Nástroje editoru</Text>
              <View style={styles.toolsGrid}>
                <ToolButton icon="format-line-spacing" label="Pročistit prázdné řádky" onPress={cleanBlankLines} colors={colors} />
                {mode === "lyrics" ? <ToolButton icon="view-quilt" label="Vložit strukturu písně" onPress={insertStructure} colors={colors} /> : null}
              </View>
              <View style={[styles.findBox, { borderColor: colors.border, backgroundColor: colors.surface }]}>
                <Text style={[Type.label, { color: colors.foreground }]}>Najít a nahradit</Text>
                <TextInput value={findText} onChangeText={setFindText} placeholder="Najít…" placeholderTextColor={colors.muted} style={[styles.findInput, { color: colors.foreground, borderColor: colors.border }]} />
                <TextInput value={replaceText} onChangeText={setReplaceText} placeholder="Nahradit…" placeholderTextColor={colors.muted} style={[styles.findInput, { color: colors.foreground, borderColor: colors.border }]} />
                <ToolButton icon="find-replace" label="Nahradit vše" disabled={!findText} onPress={findReplace} colors={colors} />
              </View>
            </Pressable>
          </Pressable>
        </Modal>
    </ScreenContainer>
  );
}

function ModeButton({
  active,
  icon,
  label,
  onPress,
  colors,
}: {
  active: boolean;
  icon: React.ComponentProps<typeof MaterialIcons>["name"];
  label: string;
  onPress: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [styles.modeButton, { backgroundColor: active ? colors.primary : "transparent", opacity: pressed ? 0.75 : 1 }]}
    >
      <MaterialIcons name={icon} size={17} color={active ? colors.onPrimary : colors.muted} />
      <Text style={[Type.label, { color: active ? colors.onPrimary : colors.muted }]}>{label}</Text>
    </Pressable>
  );
}

function ToolButton({
  icon,
  label,
  onPress,
  disabled,
  tone = "neutral",
  colors,
}: {
  icon: React.ComponentProps<typeof MaterialIcons>["name"];
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "neutral" | "primary" | "danger";
  colors: ReturnType<typeof useColors>;
}) {
  const tint = tone === "primary" ? colors.primary : tone === "danger" ? colors.error : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={() => {
        Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      style={({ pressed }) => [
        styles.toolButton,
        {
          backgroundColor: tone === "primary" ? alpha(colors.primary, 0.08) : tone === "danger" ? alpha(colors.error, 0.08) : colors.surface,
          borderColor: tone === "primary" ? alpha(colors.primary, 0.28) : tone === "danger" ? alpha(colors.error, 0.28) : colors.border,
          opacity: disabled ? 0.38 : pressed ? 0.7 : 1,
        },
      ]}
    >
      <MaterialIcons name={icon} size={17} color={tint} />
      <Text style={[Type.label, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  keyboard: { flex: 1 },
  content: { flex: 1, paddingHorizontal: 16, paddingTop: 8, gap: 11 },
  topbar: { flexDirection: "row", alignItems: "center", gap: 10 },
  titleBlock: { flex: 1, gap: 1 },
  saveButton: { minHeight: 40, borderRadius: Radius.pill, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 },
  saveText: { fontWeight: "800" },
  modeSwitch: { flexDirection: "row", borderRadius: Radius.pill, borderWidth: 1, padding: 4, gap: 4 },
  modeButton: { flex: 1, minHeight: 38, borderRadius: Radius.pill, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  editorCard: { flex: 1, minHeight: 200, borderWidth: 1, borderRadius: Radius.lg, overflow: "hidden" },
  editorHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  editorLabel: { fontWeight: "800" },
  editorInput: { flex: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, lineHeight: 24 },
  clipboardRow: { flexDirection: "row", gap: 8 },
  sectionRow: { gap: 5 },
  sectionLabel: { textTransform: "uppercase", letterSpacing: 0.5 },
  sectionChips: { gap: 6, paddingRight: 8 },
  sectionChip: { height: 31, borderRadius: Radius.pill, borderWidth: 1, paddingHorizontal: 10, alignItems: "center", justifyContent: "center" },
  toolbar: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingBottom: 4 },
  toolButton: { height: 40, borderRadius: Radius.pill, borderWidth: 1, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 6 },
  completeButton: { minHeight: 48, borderRadius: Radius.md, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 4 },
  completeButtonText: { fontWeight: "800" },
  toolsShade: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  toolsSheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, padding: 16, gap: 14, paddingBottom: 28 },
  toolsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  findBox: { borderWidth: 1, borderRadius: Radius.md, padding: 12, gap: 8 },
  findInput: { minHeight: 42, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 12, fontSize: 15 },
});
