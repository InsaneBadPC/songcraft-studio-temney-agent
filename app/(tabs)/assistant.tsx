import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Clipboard from "expo-clipboard";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, { FadeInDown, FadeInUp, Layout } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState, Shimmer, StudioHeader } from "@/components/studio-ui";
import { ScreenContainer } from "@/components/screen-container";
import { startPrivateLogin } from "@/constants/oauth";
import { askStudioAssistant, type StudioAssistantMessage } from "@/lib/assistant-chat";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";

const SUGGESTIONS = [
  { icon: "auto-awesome" as const, text: "Navrhni další krok pro můj kanál", sub: "Obsah, vydání a růst" },
  { icon: "album" as const, text: "Které album mám rozpracovat dál?", sub: "Přehled mých materiálů" },
  { icon: "image" as const, text: "Připrav artwork pro skladbu", sub: "Temney character bible + prompt" },
];

type Conversation = { id: string; title: string; messages: StudioAssistantMessage[]; createdAt: number; updatedAt: number };
const MAX_CONVERSATIONS = 5;
const storageKey = (userId: string) => `assistant_history_${userId}`;

function titleFromMessages(messages: StudioAssistantMessage[]): string {
  const first = messages.find((m) => m.role === "user")?.content.trim() ?? "";
  if (!first) return "Nová konverzace";
  return first.slice(0, 42) + (first.length > 42 ? "…" : "");
}

export default function AssistantScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, isAuthenticated, loading } = useAuth();
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<StudioAssistantMessage[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasMessages = messages.length > 0;
  const inputDisabled = sending || !isAuthenticated;
  const flatListRef = useRef<FlatList>(null);

  const loadHistory = useCallback(async (uid: string) => {
    try {
      const raw = await AsyncStorage.getItem(storageKey(uid));
      if (!raw) return;
      const parsed = JSON.parse(raw) as Conversation[];
      if (!Array.isArray(parsed) || !parsed.length) return;
      const sorted = parsed.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS);
      setConversations(sorted);
      setActiveId(sorted[0].id);
      setMessages(sorted[0].messages);
    } catch {}
  }, []);

  const persist = useCallback(async (uid: string, convs: Conversation[]) => {
    try { await AsyncStorage.setItem(storageKey(uid), JSON.stringify(convs.slice(0, MAX_CONVERSATIONS))); } catch {}
  }, []);

  useEffect(() => { if (user?.id) void loadHistory(user.id); else { setConversations([]); setActiveId(null); setMessages([]); } }, [user?.id, loadHistory]);

  const upsertCurrent = useCallback((nextMessages: StudioAssistantMessage[], currentId: string | null, convs: Conversation[]) => {
    const now = Date.now();
    if (!currentId) {
      const id = `conv-${now}`;
      const conv: Conversation = { id, title: titleFromMessages(nextMessages), messages: nextMessages, createdAt: now, updatedAt: now };
      return { convs: [conv, ...convs].slice(0, MAX_CONVERSATIONS), id };
    }
    const updated = convs.map((c) => (c.id === currentId ? { ...c, messages: nextMessages, title: titleFromMessages(nextMessages), updatedAt: now } : c));
    updated.sort((a, b) => b.updatedAt - a.updatedAt);
    return { convs: updated.slice(0, MAX_CONVERSATIONS), id: currentId };
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    if (messages.length === 0 && !activeId && conversations.length === 0) return;
    const timeout = setTimeout(() => {
      if (!user?.id) return;
      const { convs, id } = upsertCurrent(messages, activeId, conversations);
      const changed = JSON.stringify(convs) !== JSON.stringify(conversations) || id !== activeId;
      if (changed) { setConversations(convs); setActiveId(id); void persist(user.id, convs); }
    }, 300);
    return () => clearTimeout(timeout);
  }, [messages, activeId, conversations, persist, upsertCurrent, user?.id]);

  const startNewConversation = useCallback(async () => {
    if (!user?.id) return;
    Haptics.selectionAsync().catch(()=>{});
    let convs = conversations;
    if (messages.length) { const res = upsertCurrent(messages, activeId, conversations); convs = res.convs; await persist(user.id, convs); }
    setMessages([]); setActiveId(null); setError(null);
  }, [user?.id, messages, activeId, conversations, persist, upsertCurrent]);

  const switchConversation = useCallback((id: string) => {
    Haptics.selectionAsync().catch(()=>{});
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return;
    setActiveId(id); setMessages(conv.messages); setError(null);
  }, [conversations]);

  const listHeader = useMemo(() => (
    <>
      <StudioHeader eyebrow="Temney Agent · bezpečný režim" title="Temney Agent" />
      <View style={[styles.notice, { backgroundColor: colors.surface, borderColor: "rgba(255,255,255,0.08)", shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 4 }]}>
        <View style={[styles.noticeIcon, { backgroundColor: `${colors.primary}14`, borderColor: "rgba(255,255,255,0.08)" }]}><MaterialIcons name="privacy-tip" size={18} color={colors.primary} /></View>
        <Text style={[styles.noticeText, { color: colors.muted }]}>Pracuje jen s tvými texty, alby a skladbami. Artwork připravuje jako návrh; veřejné akce ani změny účtu nikdy neprovede bez tvého potvrzení.</Text>
      </View>
      {isAuthenticated && conversations.length > 0 ? (
        <Animated.View entering={FadeInUp.duration(380)} style={styles.historyBlock}>
          <View style={styles.historyHead}>
            <Text style={[styles.historyTitle, { color: colors.muted }]}>POSLEDNÍ KONVERZACE</Text>
            <Pressable onPress={() => void startNewConversation()} style={({ pressed }) => [styles.newConv, { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }]}>
              <MaterialIcons name="add" size={14} color="#FFFFFF" /><Text style={styles.newConvText}>Nová</Text>
            </Pressable>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.historyRow}>
            {conversations.map((c) => (
              <Pressable key={c.id} onPress={() => switchConversation(c.id)} style={({ pressed }) => [styles.historyChip, { backgroundColor: c.id === activeId ? colors.primary : colors.surface, borderColor: c.id === activeId ? colors.primary : "rgba(255,255,255,0.08)", opacity: pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }]}>
                <MaterialIcons name="chat-bubble-outline" size={13} color={c.id === activeId ? "#FFFFFF" : colors.muted} />
                <Text numberOfLines={1} style={[styles.historyChipText, { color: c.id === activeId ? "#FFFFFF" : colors.foreground }]}>{c.title}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </Animated.View>
      ) : null}
      {!hasMessages ? (
        <View style={styles.suggestions}>
          <Text style={[styles.suggestionTitle, { color: colors.foreground }]}>Začni třeba takto</Text>
          {SUGGESTIONS.map((s, i) => (
            <Animated.View key={s.text} entering={FadeInDown.delay(i * 80).duration(420)} layout={Layout.springify()}>
              <Pressable onPress={() => { Haptics.selectionAsync().catch(()=>{}); setDraft(s.text); }} disabled={inputDisabled} style={({ pressed }) => [styles.suggestion, { backgroundColor: colors.surface, borderColor: "rgba(255,255,255,0.08)", shadowColor: "#000", shadowOpacity: pressed ? 0.08 : 0.12, shadowRadius: 12, elevation: 3, opacity: pressed || inputDisabled ? 0.85 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] }]}>
                <LinearGradient colors={["rgba(59,130,246,0.12)", "rgba(139,92,246,0.10)"]} style={styles.suggestionIconBg}>
                  <MaterialIcons name={s.icon} size={18} color={colors.primary} />
                </LinearGradient>
                <View style={{ flex: 1, gap: 2 }}><Text style={[styles.suggestionText, { color: colors.foreground }]}>{s.text}</Text><Text style={[styles.suggestionSub, { color: colors.muted }]}>{s.sub}</Text></View>
                <MaterialIcons name="arrow-outward" size={16} color={colors.muted} />
              </Pressable>
            </Animated.View>
          ))}
          <Text style={[styles.disclaimer, { color: colors.muted }]}>Temney pipeline • motivy, artwork, metadata a publikační návrhy</Text>
        </View>
      ) : null}
    </>
  ), [colors, hasMessages, inputDisabled, conversations, activeId, startNewConversation, switchConversation, isAuthenticated]);

  async function send(text = draft) {
    const content = text.trim();
    if (!content || sending) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(()=>{});
    const userMessage: StudioAssistantMessage = { id: `user-${Date.now()}`, role: "user", content };
    const history = [...messages, userMessage];
    setMessages(history); setDraft(""); setError(null); setSending(true);
    try {
      const answer = await askStudioAssistant(content, messages);
      const withAnswer: StudioAssistantMessage[] = [...history, { id: `assistant-${Date.now()}`, role: "assistant", content: answer }];
      setMessages(withAnswer);
      if (user?.id) { const { convs, id } = upsertCurrent(withAnswer, activeId, conversations); setConversations(convs); setActiveId(id); await persist(user.id, convs); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Asistent nyní není dostupný."); } finally { setSending(false); }
  }

  async function copyMessage(content: string) {
    Haptics.selectionAsync().catch(()=>{});
    try { await Clipboard.setStringAsync(content); Alert.alert("Zkopírováno", "Odpověď je ve schránce."); } catch {}
  }
  const Alert = require("react-native").Alert;

  if (loading) return <ScreenContainer><View style={{ padding: 20, gap: 12 }}><Shimmer height={20} width="60%" /><Shimmer height={14} /><Shimmer height={14} width="80%" /></View></ScreenContainer>;
  if (!isAuthenticated) return <ScreenContainer className="p-5 justify-center"><View style={[styles.emptyCard, { backgroundColor: colors.surface, borderColor: "rgba(255,255,255,0.08)" }]}><View style={[styles.emptyIcon, { backgroundColor: `${colors.primary}14` }]}><MaterialIcons name="lock" size={28} color={colors.primary} /></View><Text style={[styles.emptyTitle, { color: colors.foreground }]}>Přihlášení je potřeba</Text><Text style={[styles.emptyText, { color: colors.muted }]}>Asistent pracuje jen s tvými materiály.</Text><Pressable onPress={() => void startPrivateLogin()} style={({ pressed }) => [styles.loginBtn, { opacity: pressed ? 0.9 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }]}><LinearGradient colors={["#3B82F6","#6366F1"]} style={StyleSheet.absoluteFill as any} /><Text style={styles.loginText}>Přihlásit se</Text></Pressable></View></ScreenContainer>;

  return (
    <ScreenContainer className="px-5" style={{ backgroundColor: colors.background }}>
      <KeyboardAvoidingView style={styles.grow} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={insets.top}>
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.content, { paddingBottom: 16 }]}
          ListHeaderComponent={listHeader}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
          renderItem={({ item, index }) => (
            <Animated.View entering={FadeInDown.delay(index * 20).duration(360)} layout={Layout.springify()} style={[styles.message, item.role === "user" ? [styles.userMessage, { backgroundColor: colors.primary, shadowColor: colors.primary, shadowOpacity: 0.22, shadowRadius: 12, elevation: 4 }] : [styles.assistantMessage, { backgroundColor: colors.surface, borderColor: "rgba(255,255,255,0.08)", shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 12, elevation: 3 }]]}>
              <View style={styles.messageHead}>
                <View style={styles.roleRow}>
                  <View style={[styles.roleDot, { backgroundColor: item.role === "user" ? "#FFFFFF" : colors.primary }]} />
                  <Text style={[styles.messageRole, { color: item.role === "user" ? "#FFFFFF" : colors.primary }]}>{item.role === "user" ? "Ty" : "Asistent"}</Text>
                </View>
                {item.role === "assistant" ? <Pressable onPress={() => void copyMessage(item.content)} hitSlop={8} style={({ pressed }) => [styles.copyChip, { opacity: pressed ? 0.6 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }]}><MaterialIcons name="content-copy" size={13} color={colors.muted} /><Text style={[styles.copyChipText, { color: colors.muted }]}>Kopírovat</Text></Pressable> : null}
              </View>
              <Text selectable style={[styles.messageText, { color: item.role === "user" ? "#FFFFFF" : colors.foreground }]}>{item.content}</Text>
            </Animated.View>
          )}
          ListFooterComponent={sending ? <Animated.View entering={FadeInUp.duration(300)} style={[styles.thinking, { backgroundColor: colors.surface, borderColor: "rgba(255,255,255,0.08)" }]}><View style={styles.thinkingDots}><View style={[styles.dot, { backgroundColor: colors.primary }]} /><View style={[styles.dot, { backgroundColor: colors.primary, opacity: 0.6 }]} /><View style={[styles.dot, { backgroundColor: colors.primary, opacity: 0.3 }]} /></View><Text style={[styles.thinkingText, { color: colors.muted }]}>Procházím tvé albumy…</Text></Animated.View> : null}
        />
        {error ? <Animated.View entering={FadeInDown.duration(300)} style={[styles.errorBox, { backgroundColor: "rgba(239,68,68,0.10)", borderColor: "rgba(239,68,68,0.22)" }]}><MaterialIcons name="error-outline" size={16} color={colors.error} /><Text style={[styles.errorText, { color: colors.error }]}>{error}</Text></Animated.View> : null}
        <View style={[styles.composer, { backgroundColor: colors.surface, borderColor: "rgba(255,255,255,0.08)", shadowColor: "#000", shadowOpacity: 0.16, shadowRadius: 16, elevation: 8, paddingBottom: insets.bottom ? 8 : 8 }]}>
          <TextInput value={draft} onChangeText={setDraft} editable={!inputDisabled} multiline maxLength={1000} placeholder="Zadej úkol pro Temney Agenta…" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.foreground }]} />
          <Pressable onPress={() => void send()} disabled={!draft.trim() || inputDisabled} style={({ pressed }) => [styles.send, { backgroundColor: !draft.trim() || inputDisabled ? "rgba(255,255,255,0.08)" : colors.primary, opacity: pressed ? 0.9 : 1, transform: [{ scale: pressed && draft.trim() ? 0.97 : 1 }] }]}>
            <MaterialIcons name="arrow-upward" size={20} color={!draft.trim() || inputDisabled ? colors.muted : "#FFFFFF"} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  content: { paddingTop: 14, paddingBottom: 14, gap: 12 },
  notice: { flexDirection: "row", gap: 12, borderRadius: 20, borderWidth: 1, padding: 14, marginBottom: 14, alignItems: "center" },
  noticeIcon: { width: 36, height: 36, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  noticeText: { flex: 1, fontSize: 12, lineHeight: 17, fontWeight: "500" },
  historyBlock: { gap: 10, marginBottom: 14 },
  historyHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  historyTitle: { fontSize: 10, fontWeight: "700", letterSpacing: 1 },
  newConv: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, height: 30, borderRadius: 15 },
  newConvText: { color: "#FFFFFF", fontSize: 12, fontWeight: "700" },
  historyRow: { gap: 8, paddingRight: 12, paddingVertical: 2 },
  historyChip: { flexDirection: "row", alignItems: "center", gap: 6, maxWidth: 220, paddingHorizontal: 12, height: 34, borderRadius: 17, borderWidth: 1 },
  historyChipText: { fontSize: 12, fontWeight: "600", flexShrink: 1 },
  suggestions: { gap: 10, marginBottom: 6 },
  suggestionTitle: { fontSize: 13, fontWeight: "700", marginBottom: 2, letterSpacing: -0.2 },
  suggestion: { minHeight: 62, borderRadius: 20, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  suggestionIconBg: { width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  suggestionText: { fontSize: 14, fontWeight: "600", letterSpacing: -0.2 },
  suggestionSub: { fontSize: 11, fontWeight: "500", marginTop: 1 },
  disclaimer: { fontSize: 11, lineHeight: 15, marginTop: 6, textAlign: "center", opacity: 0.7 },
  message: { maxWidth: "88%", borderRadius: 20, padding: 14, gap: 8, borderWidth: 1 },
  messageHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  roleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  roleDot: { width: 6, height: 6, borderRadius: 3 },
  copyChip: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, height: 26, borderRadius: 13, borderWidth: 1, borderColor: "rgba(255,255,255,0.10)", backgroundColor: "rgba(255,255,255,0.04)" },
  copyChipText: { fontSize: 11, fontWeight: "600" },
  userMessage: { alignSelf: "flex-end", borderBottomRightRadius: 6, borderWidth: 0 },
  assistantMessage: { alignSelf: "flex-start", borderBottomLeftRadius: 6 },
  messageRole: { fontSize: 11, fontWeight: "700", letterSpacing: 0.3 },
  messageText: { fontSize: 15, lineHeight: 22, fontWeight: "400" },
  thinking: { alignSelf: "flex-start", flexDirection: "row", gap: 10, alignItems: "center", borderWidth: 1, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  thinkingDots: { flexDirection: "row", gap: 4, alignItems: "center" },
  dot: { width: 6, height: 6, borderRadius: 3 },
  thinkingText: { fontSize: 12, fontWeight: "600" },
  errorBox: { flexDirection: "row", gap: 8, alignItems: "center", borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8 },
  errorText: { flex: 1, fontSize: 12, fontWeight: "500" },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 10, borderWidth: 1, borderRadius: 20, padding: 8, marginBottom: 8, marginTop: 4 },
  input: { flex: 1, minHeight: 42, maxHeight: 112, paddingHorizontal: 10, paddingVertical: 10, fontSize: 15, lineHeight: 20 },
  send: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  emptyCard: { borderWidth: 1, borderRadius: 24, padding: 28, alignItems: "center", gap: 10 },
  emptyIcon: { width: 64, height: 64, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  emptyTitle: { fontSize: 18, fontWeight: "700", textAlign: "center" },
  emptyText: { fontSize: 14, lineHeight: 20, textAlign: "center", opacity: 0.8 },
  loginBtn: { marginTop: 12, height: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", paddingHorizontal: 20, overflow: "hidden", minWidth: 160 },
  loginText: { color: "#FFFFFF", fontWeight: "700", zIndex: 1 },
});
