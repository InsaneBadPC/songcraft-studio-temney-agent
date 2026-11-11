import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { askSongCraftAgent } from "@/lib/agent-api";
import type { StudioAssistantMessage } from "@/lib/assistant-chat";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { Hairline, OnPrimary, Radius, Type, alpha } from "@/lib/design-tokens";

export type WritingMode = "lyrics" | "prompt";

const QUICK_PROMPTS: Record<WritingMode, { label: string; message: string }[]> = {
  lyrics: [
    { label: "Pokračuj v textu", message: "Navrhni přirozené pokračování textu. Odpověz pouze textem k vložení, bez vysvětlování." },
    { label: "Nový refrén", message: "Navrhni nový refrén, který sedí k náladě a rytmu textu. Odpověz pouze textem k vložení." },
    { label: "Vylepši rýmy", message: "Projdi rýmy a rytmus. Navrhni konkrétní úpravy a stručně vysvětli proč." },
    { label: "Zkrať text", message: "Zkrať text tak, aby zůstala hlavní myšlenka a rytmus. Odpověz pouze upraveným textem." },
    { label: "Najdi slabá místa", message: "Najdi slabá místa v textu a navrhni konkrétní zlepšení." },
  ],
  prompt: [
    { label: "Žánr a tempo", message: "Navrhni žánr, tempo a produkční směr pro tuto skladbu. Odpověz stručně a konkrétně." },
    { label: "Nástroje a nálada", message: "Doplň do promptu nástroje, náladu a zvukovou atmosféru. Odpověz pouze upraveným promptem." },
    { label: "Vylepši prompt", message: "Vylepši prompt pro hudební generátor tak, aby byl konkrétnější a použitelnější. Odpověz pouze upraveným promptem." },
    { label: "Zkrať prompt", message: "Zkrať prompt na nejdůležitější prvky, ale zachovej žánr, tempo a náladu. Odpověz pouze upraveným promptem." },
  ],
};

function buildContext(mode: WritingMode, title: string, text: string) {
  const cleanTitle = title.trim().slice(0, 80);
  const trimmed = text.trim();
  const snippet = trimmed.length > 620 ? `…${trimmed.slice(-620)}` : trimmed;
  const label = mode === "lyrics" ? "textu písně" : "promptu stylu";
  return `Jsem v editoru ${label}${cleanTitle ? ` „${cleanTitle}“` : ""}. Aktuální obsah:\n"""\n${snippet || "(zatím prázdné)"}\n"""`;
}

function buildMessage(context: string, request: string) {
  const available = Math.max(0, 1000 - context.length - 2);
  return `${context}\n\n${request.trim().slice(0, available)}`;
}

export function WritingAssistant({
  visible,
  mode,
  title,
  text,
  onClose,
  onInsert,
}: {
  visible: boolean;
  mode: WritingMode;
  title: string;
  text: string;
  onClose: () => void;
  onInsert: (text: string) => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { isAuthenticated, loading } = useAuth();
  const [messages, setMessages] = useState<StudioAssistantMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [insertedId, setInsertedId] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const quickPrompts = QUICK_PROMPTS[mode];

  useEffect(() => {
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(timer);
  }, [messages, sending]);

  const startNewChat = () => {
    Haptics.selectionAsync().catch(() => {});
    setMessages([]);
    setDraft("");
    setError(null);
    setConversationId(null);
    setInsertedId(null);
  };

  async function send(raw = draft) {
    const request = raw.trim();
    if (!request || sending) return;
    if (!isAuthenticated) {
      setError("Pro AI asistenta se musíš přihlásit.");
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    const userMessage: StudioAssistantMessage = { id: `user-${Date.now()}`, role: "user", content: request };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setDraft("");
    setError(null);
    setInsertedId(null);
    setSending(true);
    try {
      const result = await askSongCraftAgent(buildMessage(buildContext(mode, title, text), request), messages, conversationId);
      const answer = result.pending.length
        ? `${result.answer}\n\nAkce s veřejným dopadem potvrdíš v záložce Asistent.`
        : result.answer;
      setMessages([...nextMessages, { id: `assistant-${Date.now()}`, role: "assistant", content: answer }]);
      if (result.conversationId) setConversationId(result.conversationId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI asistent nyní není dostupný.");
    } finally {
      setSending(false);
    }
  }

  const inputDisabled = sending || loading || !isAuthenticated;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.shade}>
        <Pressable accessibilityLabel="Zavřít AI asistenta" style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]} onPress={onClose} />
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.keyboard}>
          <View style={[styles.sheet, { backgroundColor: colors.background, paddingBottom: Math.max(insets.bottom, 14) }]}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
            <View style={styles.top}>
              <View style={styles.topCopy}>
                <View style={styles.titleRow}>
                  <MaterialIcons name="auto-awesome" size={18} color={colors.primary} />
                  <Text style={[Type.heading, { color: colors.foreground }]}>AI asistent</Text>
                </View>
                <Text style={[Type.caption, { color: colors.muted }]}>
                  {mode === "lyrics" ? "Píšeš text písně" : "Ladíš prompt stylu"} · vidí aktuální obsah
                </Text>
              </View>
              {messages.length ? (
                <Pressable onPress={startNewChat} style={({ pressed }) => [styles.iconButton, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}>
                  <MaterialIcons name="refresh" size={19} color={colors.foregroundMuted} />
                </Pressable>
              ) : null}
              <Pressable onPress={onClose} style={({ pressed }) => [styles.iconButton, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}>
                <MaterialIcons name="close" size={20} color={colors.foreground} />
              </Pressable>
            </View>

            <ScrollView ref={scrollRef} style={styles.messages} contentContainerStyle={styles.messagesContent} keyboardShouldPersistTaps="handled">
              {messages.length === 0 ? (
                <View style={styles.empty}>
                  <View style={[styles.emptyIcon, { backgroundColor: alpha(colors.primary, 0.12) }]}>
                    <MaterialIcons name="chat-bubble-outline" size={24} color={colors.primary} />
                  </View>
                  <Text style={[Type.label, styles.emptyTitle, { color: colors.foreground }]}>Zeptej se na cokoliv z psaní</Text>
                  <Text style={[Type.caption, styles.emptyText, { color: colors.muted }]}>
                    Můžeš chtít pokračování, nový refrén, lepší rýmy nebo úpravu promptu. Odpověď vložíš jedním klepnutím.
                  </Text>
                </View>
              ) : null}
              {messages.map((message) => {
                const isUser = message.role === "user";
                return (
                  <View key={message.id} style={[styles.bubble, isUser ? [styles.userBubble, { backgroundColor: colors.primary }] : [styles.assistantBubble, { backgroundColor: colors.surface, borderColor: colors.border }]]}>
                    <Text style={[styles.bubbleText, { color: isUser ? colors.onPrimary : colors.foreground }]}>{message.content}</Text>
                    {!isUser ? (
                      <Pressable
                        disabled={insertedId === message.id}
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                          onInsert(message.content);
                          setInsertedId(message.id);
                        }}
                        style={({ pressed }) => [styles.insertButton, { borderColor: insertedId === message.id ? colors.success : alpha(colors.primary, 0.32), backgroundColor: insertedId === message.id ? alpha(colors.success, 0.1) : alpha(colors.primary, 0.08), opacity: pressed ? 0.7 : 1 }]}
                      >
                        <MaterialIcons name={insertedId === message.id ? "check" : "content-paste"} size={15} color={insertedId === message.id ? colors.success : colors.primary} />
                        <Text style={[Type.caption, { color: insertedId === message.id ? colors.success : colors.primary }]}>
                          {insertedId === message.id ? "Vloženo" : "Vložit do textu"}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                );
              })}
              {sending ? (
                <View style={[styles.bubble, styles.assistantBubble, styles.thinking, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text style={[Type.caption, { color: colors.muted }]}>Přemýšlím…</Text>
                </View>
              ) : null}
            </ScrollView>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.quickRow} keyboardShouldPersistTaps="handled">
              {quickPrompts.map((prompt) => (
                <Pressable
                  key={prompt.label}
                  disabled={inputDisabled}
                  onPress={() => void send(prompt.message)}
                  style={({ pressed }) => [styles.quickChip, { backgroundColor: colors.surface, borderColor: colors.border, opacity: inputDisabled ? 0.4 : pressed ? 0.7 : 1 }]}
                >
                  <Text style={[Type.caption, { color: colors.foreground }]}>{prompt.label}</Text>
                </Pressable>
              ))}
            </ScrollView>

            {error ? (
              <View style={styles.errorRow}>
                <MaterialIcons name="error-outline" size={15} color={colors.error} />
                <Text style={[Type.caption, styles.errorText, { color: colors.error }]}>{error}</Text>
              </View>
            ) : null}

            {!loading && !isAuthenticated ? (
              <View style={[styles.authNotice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <MaterialIcons name="lock-outline" size={16} color={colors.muted} />
                <Text style={[Type.caption, styles.authText, { color: colors.muted }]}>Pro AI asistenta se přihlas v aplikaci.</Text>
              </View>
            ) : null}

            <View style={[styles.inputRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder="Napiš, co chceš vylepšit…"
                placeholderTextColor={colors.muted}
                multiline
                maxLength={1000}
                editable={!inputDisabled}
                style={[styles.input, { color: colors.foreground }]}
              />
              <Pressable
                disabled={!draft.trim() || inputDisabled}
                onPress={() => void send()}
                style={({ pressed }) => [styles.sendButton, { backgroundColor: colors.primary, opacity: !draft.trim() || inputDisabled || pressed ? 0.4 : 1 }]}
              >
                {sending ? <ActivityIndicator size="small" color={OnPrimary} /> : <MaterialIcons name="send" size={19} color={OnPrimary} />}
              </Pressable>
            </View>
            <Text style={[Type.caption, styles.disclaimer, { color: colors.muted }]}>AI může udělat chybu. Text před použitím zkontroluj.</Text>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  shade: { flex: 1 },
  keyboard: { flex: 1, justifyContent: "flex-end" },
  sheet: { maxHeight: "88%", minHeight: 340, borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl, paddingHorizontal: 18, borderWidth: 1, borderBottomWidth: 0, borderColor: Hairline },
  handle: { width: 42, height: 4, borderRadius: 3, alignSelf: "center", marginVertical: 10 },
  top: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  topCopy: { flex: 1, gap: 2 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  iconButton: { width: 38, height: 38, borderRadius: Radius.sm, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  messages: { flex: 1 },
  messagesContent: { gap: 10, paddingVertical: 8, paddingBottom: 12 },
  empty: { alignItems: "center", paddingHorizontal: 20, paddingVertical: 22, gap: 8 },
  emptyIcon: { width: 48, height: 48, borderRadius: Radius.md, alignItems: "center", justifyContent: "center" },
  emptyTitle: { fontWeight: "800", textAlign: "center" },
  emptyText: { textAlign: "center", lineHeight: 18 },
  bubble: { maxWidth: "92%", borderRadius: Radius.md, paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  userBubble: { alignSelf: "flex-end", borderBottomRightRadius: Radius.sm },
  assistantBubble: { alignSelf: "flex-start", borderWidth: 1, borderBottomLeftRadius: Radius.sm },
  bubbleText: { fontSize: 14, lineHeight: 21 },
  thinking: { flexDirection: "row", alignItems: "center", gap: 8 },
  insertButton: { alignSelf: "flex-start", minHeight: 30, borderRadius: Radius.pill, borderWidth: 1, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 5 },
  quickRow: { gap: 7, paddingVertical: 8 },
  quickChip: { height: 32, borderRadius: Radius.pill, borderWidth: 1, paddingHorizontal: 11, alignItems: "center", justifyContent: "center" },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6 },
  errorText: { flex: 1 },
  authNotice: { flexDirection: "row", alignItems: "center", gap: 7, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 8 },
  authText: { flex: 1 },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8, borderWidth: 1, borderRadius: Radius.md, padding: 6, paddingLeft: 12 },
  input: { flex: 1, minHeight: 40, maxHeight: 110, fontSize: 15, lineHeight: 21, paddingVertical: 8 },
  sendButton: { width: 42, height: 42, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" },
  disclaimer: { textAlign: "center", marginTop: 7 },
});
