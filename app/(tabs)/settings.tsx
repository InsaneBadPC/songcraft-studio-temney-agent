import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useEffect, useState } from "react";

import { EmptyState, LoadingState, SectionTitle, StudioHeader } from "@/components/studio-ui";
import { ScreenContainer } from "@/components/screen-container";
import { startPrivateLogin } from "@/constants/oauth";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { checkForUpdate, installUpdate, CURRENT_VERSION, type AppUpdate } from "@/lib/app-update";
import { downloadOrShareFile } from "@/lib/download-and-share";
import { trpc } from "@/lib/trpc";
import { getTemneyAgentOverview, setTemneyAutoPublish, updateRecommendation, type AgentOverview } from "@/lib/temney-agent";

export default function SettingsScreen() {
  const colors = useColors();
  const { user, isAuthenticated, loading, logout } = useAuth();
  const snapshot = trpc.studio.snapshot.useQuery(undefined, { enabled: isAuthenticated });
  const authLogout = trpc.auth.logout.useMutation();
  const exportWholeLibrary = trpc.studio.exportWholeLibrary.useMutation();
  const exportLyricsTxt = trpc.studio.exportLyricsTxt.useMutation();
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [updateProgress, setUpdateProgress] = useState(0);
  const [agentOverview, setAgentOverview] = useState<AgentOverview | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [autoPublish, setAutoPublish] = useState(false);

  const changeRecommendation = async (id: string, status: "accepted" | "rejected" | "applied") => {
    try {
      await updateRecommendation(id, status);
      setAgentOverview((current) => current ? { ...current, recommendations: current.recommendations.filter((item) => item.id !== id) } : current);
    } catch (error) {
      Alert.alert("Doporučení se nepodařilo změnit", error instanceof Error ? error.message : "Zkus to znovu.");
    }
  };

  useEffect(() => {
    if (!isAuthenticated) return;
    setAgentLoading(true);
    void getTemneyAgentOverview().then((overview) => { setAgentOverview(overview); setAutoPublish(overview.autoPublish); }).catch(() => {}).finally(() => setAgentLoading(false));
  }, [isAuthenticated]);

  const runUpdateCheck = async () => {
    setChecking(true);
    try {
      const found = await checkForUpdate();
      setUpdate(found);
      if (!found) Alert.alert("Máš nejnovější verzi", `SongCraft Studio ${CURRENT_VERSION} je aktuální.`);
    } catch (error) {
      Alert.alert("Kontrolu se nepodařilo dokončit", error instanceof Error ? error.message : "Zkontroluj připojení a zkus to znovu.");
    } finally {
      setChecking(false);
    }
  };
  const applyUpdate = async (target: AppUpdate) => {
    setInstalling(true);
    setUpdateProgress(0);
    try {
      await installUpdate(target, setUpdateProgress);
      Alert.alert("Dokonči instalaci", "V systémovém okně potvrď instalaci nové verze SongCraft Studio.");
    } catch (error) {
      Alert.alert("Aktualizace se nezdařila", error instanceof Error ? error.message : "Zkus to znovu.");
    } finally {
      setInstalling(false);
      setUpdateProgress(0);
    }
  };

  if (loading || (isAuthenticated && snapshot.isLoading)) return <ScreenContainer><LoadingState /></ScreenContainer>;
  if (!isAuthenticated) return <ScreenContainer className="p-5 justify-center"><EmptyState icon="lock" title="Připoj své studio" text="Přihlášení vytváří soukromé úložiště pro tvé texty, přebaly a MP3." action={<Pressable onPress={() => void startPrivateLogin()} style={[styles.login, { backgroundColor: colors.primary }]}><Text style={styles.loginText}>Přihlásit se</Text></Pressable>} /></ScreenContainer>;

  const albums = snapshot.data?.albums ?? [];
  const versions = snapshot.data?.versions.length ?? 0;
  const exporting = exportWholeLibrary.isPending;
  const showLogout = () => Alert.alert("Odhlásit SongCraft Studio?", "Lokální obrazovka se odhlásí, data zůstanou bezpečně v cloudu.", [{ text: "Zrušit", style: "cancel" }, { text: "Odhlásit", style: "destructive", onPress: async () => { await authLogout.mutateAsync(); await logout(); } }]);
  const exportLibrary = async (album?: { id: string; name: string }) => {
    setExportStatus(album ? `Sbírám texty, obrázky a MP3 z alba „${album.name}“…` : "Sbírám texty, obrázky, MP3 a metadata z celé knihovny…");
    try {
      const archive = await exportWholeLibrary.mutateAsync(album ? { albumId: album.id } : {});
      setExportStatus("Archiv je připraven. Otevírám uložení do telefonu…");
      await downloadOrShareFile(archive.url, archive.fileName, "application/zip", album ? `Uložit album ${album.name}` : "Uložit kompletní archiv SongCraft Studio");
      Alert.alert("Export je připraven", album ? `Archiv alba „${album.name}“ je připravený k uložení.` : "Archiv obsahuje texty, prompty, alba, obrázky, MP3 i metadata.");
    } catch (error) {
      Alert.alert("Export se nezdařil", error instanceof Error ? error.message : "Zkus to znovu.");
    } finally {
      setExportStatus(null);
    }
  };

  return <ScreenContainer className="px-5"><ScrollView contentContainerStyle={styles.content}><StudioHeader eyebrow="Osobní pracovní prostor" title="Nastavení" />
    <View style={[styles.profile, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={[styles.avatar, { backgroundColor: `${colors.primary}26` }]}><Text style={[styles.avatarText, { color: colors.primary }]}>{(user?.name ?? "S").slice(0, 1).toUpperCase()}</Text></View><View style={styles.profileCopy}><Text style={[styles.profileName, { color: colors.foreground }]}>{user?.name ?? "SongCraft autor"}</Text><Text numberOfLines={1} style={[styles.profileMail, { color: colors.muted }]}>{user?.email ?? "Soukromý cloudový účet"}</Text></View><MaterialIcons name="verified-user" size={22} color={colors.success} /></View>
    <SectionTitle title="Synchronizace" /><View style={[styles.syncCard, { backgroundColor: `${colors.success}15`, borderColor: `${colors.success}55` }]}><MaterialIcons name="cloud-done" size={25} color={colors.success} /><View style={styles.syncCopy}><Text style={[styles.syncTitle, { color: colors.foreground }]}>Cloudové studio je propojeno</Text><Text style={[styles.syncText, { color: colors.muted }]}>Obsah se načítá z tvého zabezpečeného prostoru. Soubory zůstávají oddělené od katalogu.</Text></View></View>
    <View style={styles.statRow}><Stat value={albums.length} label="alb" /><Stat value={snapshot.data?.documents.length ?? 0} label="textů" /><Stat value={versions} label="MP3 verzí" /></View>
    <SectionTitle title="Kompletní záloha" /><Pressable onPress={() => void exportLibrary()} style={({ pressed }) => [styles.libraryExport, { backgroundColor: colors.primary, opacity: exporting || pressed ? 0.68 : 1 }]} disabled={exporting}><MaterialIcons name="archive" size={21} color="#141317" /><View style={styles.libraryExportCopy}><Text style={styles.libraryExportTitle}>{exporting ? "Vytvářím archiv…" : "Exportovat celou knihovnu"}</Text><Text style={styles.libraryExportText}>Texty, prompty, alba, obrázky, MP3 i metadata v jednom ZIP souboru.</Text></View></Pressable>
    {exportStatus ? <View style={[styles.exportProgress, { backgroundColor: `${colors.primary}16`, borderColor: `${colors.primary}4A` }]}><ActivityIndicator size="small" color={colors.primary} /><Text style={[styles.exportProgressText, { color: colors.foreground }]}>{exportStatus}</Text></View> : null}
    <SectionTitle title="Zálohy jednotlivých alb" />{albums.length ? albums.map((album) => <Pressable key={album.id} disabled={exporting} onPress={() => void exportLibrary(album)} style={({ pressed }) => [styles.albumExport, { backgroundColor: colors.surface, borderColor: colors.border, opacity: exporting || pressed ? 0.65 : 1 }]}><View style={[styles.albumExportIcon, { backgroundColor: `${colors.primary}1C` }]}><MaterialIcons name="folder-zip" size={21} color={colors.primary} /></View><View style={styles.albumExportCopy}><Text numberOfLines={1} style={[styles.albumExportTitle, { color: colors.foreground }]}>{album.name}</Text><Text style={[styles.albumExportText, { color: colors.muted }]}>Exportovat toto album samostatně</Text></View><MaterialIcons name="download" size={20} color={colors.primary} /></Pressable>) : <Text style={[styles.emptyAlbumNote, { color: colors.muted }]}>Založ album, aby šlo stáhnout samostatnou zálohu.</Text>}
    <SectionTitle title="Jak systém pracuje" /><Info icon="edit-note" title="Koncept → skladba" text="Označením textu jako hotového zůstane koncept zachován a vznikne samostatná katalogová položka." /><Info icon="content-copy" title="Bezpečná práce s MP3" text="Při exportu ID3 tagů vzniká nová kopie. Původně nahraná verze se nikdy nepřepisuje." /><Info icon="storage" title="Rozdělené uložení" text="Texty a vazby alb jsou v databázi; přebaly a MP3 jsou v souborovém úložišti." />
    <SectionTitle title="Temney Agent 3.0" /><View style={[styles.agentCard, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={styles.agentHead}><View style={[styles.agentIcon, { backgroundColor: `${colors.primary}1C` }]}><MaterialIcons name="auto-awesome" size={22} color={colors.primary} /></View><View style={styles.agentCopy}><Text style={[styles.agentTitle, { color: colors.foreground }]}>Automatizace kanálu</Text><Text style={[styles.agentText, { color: colors.muted }]}>Publikace zůstává standardně jako draft. Plnou automatizaci zapínej jen pokud chceš, aby server mohl provádět veřejné akce.</Text></View></View><View style={[styles.autoRow, { borderTopColor: colors.border }]}><View style={{ flex: 1 }}><Text style={[styles.autoTitle, { color: colors.foreground }]}>Automatické publikování</Text><Text style={[styles.autoText, { color: colors.muted }]}>{autoPublish ? "Zapnuto — citlivé akce mohou pokračovat po serverové validaci." : "Vypnuto — veřejné akce vždy čekají na potvrzení."}</Text></View><Switch value={autoPublish} disabled={agentLoading} onValueChange={(value) => { setAutoPublish(value); void setTemneyAutoPublish(value).catch((error) => { setAutoPublish(!value); Alert.alert("Nastavení se nepodařilo uložit", error instanceof Error ? error.message : "Zkus to znovu."); }); }} trackColor={{ false: `${colors.muted}44`, true: `${colors.primary}88` }} thumbColor={autoPublish ? colors.primary : colors.muted} /></View>{agentOverview ? <View style={styles.agentStats}><Stat value={agentOverview.recommendations.length} label="doporučení" /><Stat value={agentOverview.publications.length} label="draftů" /><Stat value={agentOverview.videos.length} label="ve frontě" /></View> : null}{agentOverview?.recommendations.map((item) => <View key={item.id} style={[styles.recommendation, { borderColor: colors.border }]}><Text style={[styles.recommendationCategory, { color: colors.primary }]}>{item.category.toUpperCase()}</Text><Text style={[styles.recommendationText, { color: colors.foreground }]}>{item.recommendation}</Text>{item.reasoning ? <Text style={[styles.recommendationReason, { color: colors.muted }]}>{item.reasoning}</Text> : null}<View style={styles.recommendationActions}><Pressable onPress={() => void changeRecommendation(item.id, "accepted")}><Text style={[styles.actionText, { color: colors.primary }]}>Přijmout</Text></Pressable><Pressable onPress={() => void changeRecommendation(item.id, "applied")}><Text style={[styles.actionText, { color: colors.success }]}>Použít</Text></Pressable><Pressable onPress={() => void changeRecommendation(item.id, "rejected")}><Text style={[styles.actionText, { color: colors.error }]}>Odmítnout</Text></Pressable></View></View>)}</View>
    <SectionTitle title="Aplikace" /><View style={{ borderWidth: 1, borderRadius: 19, padding: 14, gap: 11, backgroundColor: colors.surface, borderColor: colors.border }}><View style={{ flexDirection: "row", alignItems: "center", gap: 11 }}><View style={{ width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: `${colors.primary}1C` }}><MaterialIcons name="system-update" size={22} color={colors.primary} /></View><View style={{ flex: 1, gap: 3 }}><Text style={{ fontSize: 15, fontWeight: "800", color: colors.foreground }}>Verze {CURRENT_VERSION}</Text><Text style={{ fontSize: 12, lineHeight: 17, color: colors.muted }}>{update ? `Je dostupná nová verze ${update.version}.` : "Zkontroluj, jestli máš nejnovější sestavení."}</Text></View></View>{installing ? <View style={{ gap: 7 }}><View style={{ height: 8, borderRadius: 4, overflow: "hidden", backgroundColor: `${colors.primary}1F` }}><View style={{ height: "100%", width: `${Math.round(updateProgress * 100)}%`, backgroundColor: colors.primary }} /></View><Text style={{ fontSize: 12, color: colors.muted }}>Stahuji aktualizaci… {Math.round(updateProgress * 100)} %</Text></View> : update ? <Pressable onPress={() => void applyUpdate(update)} style={({ pressed }) => [{ minHeight: 46, borderRadius: 14, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.primary, transform: [{ scale: pressed ? 0.97 : 1 }], opacity: pressed ? 0.9 : 1 }]}><MaterialIcons name="download" size={18} color="#141317" /><Text style={{ color: "#141317", fontSize: 14, fontWeight: "900" }}>Aktualizovat na {update.version}</Text></Pressable> : <Pressable onPress={() => void runUpdateCheck()} disabled={checking} style={({ pressed }) => [{ minHeight: 46, borderRadius: 14, borderWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderColor: colors.border, opacity: checking || pressed ? 0.65 : 1 }]}>{checking ? <ActivityIndicator size="small" color={colors.primary} /> : <MaterialIcons name="refresh" size={18} color={colors.foreground} />}<Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "800" }}>{checking ? "Kontroluji…" : "Zkontrolovat aktualizace"}</Text></Pressable>}</View>
    <Pressable onPress={showLogout} style={({ pressed }) => [styles.logout, { borderColor: colors.border, opacity: pressed ? 0.65 : 1 }]}><MaterialIcons name="logout" size={20} color={colors.error} /><Text style={[styles.logoutText, { color: colors.error }]}>Odhlásit se</Text></Pressable>
  </ScrollView></ScreenContainer>;
}

function Stat({ value, label }: { value: number; label: string }) { const colors = useColors(); return <View style={[styles.stat, { backgroundColor: colors.surface, borderColor: colors.border }]}><Text style={[styles.statValue, { color: colors.foreground }]}>{value}</Text><Text style={[styles.statLabel, { color: colors.muted }]}>{label}</Text></View>; }
function Info({ icon, title, text }: { icon: React.ComponentProps<typeof MaterialIcons>["name"]; title: string; text: string }) { const colors = useColors(); return <View style={styles.info}><View style={[styles.infoIcon, { backgroundColor: `${colors.primary}1C` }]}><MaterialIcons name={icon} size={20} color={colors.primary} /></View><View style={styles.infoCopy}><Text style={[styles.infoTitle, { color: colors.foreground }]}>{title}</Text><Text style={[styles.infoText, { color: colors.muted }]}>{text}</Text></View></View>; }
const styles = StyleSheet.create({ content: { paddingTop: 14, paddingBottom: 33 }, profile: { borderWidth: 1, borderRadius: 20, padding: 15, flexDirection: "row", alignItems: "center", gap: 12 }, avatar: { width: 45, height: 45, borderRadius: 15, alignItems: "center", justifyContent: "center" }, avatarText: { fontSize: 19, fontWeight: "900" }, profileCopy: { flex: 1, gap: 3 }, profileName: { fontSize: 15, fontWeight: "800" }, profileMail: { fontSize: 12 }, syncCard: { borderWidth: 1, padding: 15, borderRadius: 19, flexDirection: "row", gap: 11 }, syncCopy: { flex: 1, gap: 3 }, syncTitle: { fontSize: 14, fontWeight: "800" }, syncText: { fontSize: 12, lineHeight: 17 }, statRow: { flexDirection: "row", gap: 9, marginTop: 10 }, stat: { flex: 1, minHeight: 68, borderWidth: 1, borderRadius: 17, padding: 10, justifyContent: "center" }, statValue: { fontSize: 20, fontWeight: "900" }, statLabel: { fontSize: 11, fontWeight: "700" }, agentCard: { borderWidth: 1, borderRadius: 19, padding: 14, gap: 14 }, agentHead: { flexDirection: "row", gap: 11 }, agentIcon: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center" }, agentCopy: { flex: 1, gap: 3 }, agentTitle: { fontSize: 15, fontWeight: "800" }, agentText: { fontSize: 12, lineHeight: 17 }, autoRow: { borderTopWidth: 1, paddingTop: 13, flexDirection: "row", alignItems: "center", gap: 12 }, autoTitle: { fontSize: 13, fontWeight: "800" }, autoText: { fontSize: 11, lineHeight: 15, marginTop: 2 }, agentStats: { flexDirection: "row", gap: 8 }, recommendation: { borderWidth: 1, borderRadius: 15, padding: 12, gap: 5 }, recommendationCategory: { fontSize: 10, fontWeight: "900", letterSpacing: 1 }, recommendationText: { fontSize: 13, lineHeight: 18, fontWeight: "700" }, recommendationReason: { fontSize: 11, lineHeight: 16 }, recommendationActions: { flexDirection: "row", gap: 16, marginTop: 5 }, actionText: { fontSize: 12, fontWeight: "900" }, libraryExport: { minHeight: 76, borderRadius: 18, padding: 14, flexDirection: "row", alignItems: "center", gap: 11 }, libraryExportCopy: { flex: 1, gap: 3 }, libraryExportTitle: { color: "#141317", fontSize: 14, fontWeight: "900" }, libraryExportText: { color: "#141317", fontSize: 11, lineHeight: 15 }, exportProgress: { borderWidth: 1, borderRadius: 14, padding: 12, marginTop: 10, flexDirection: "row", alignItems: "center", gap: 10 }, exportProgressText: { flex: 1, fontSize: 12, lineHeight: 17, fontWeight: "700" }, albumExport: { minHeight: 64, borderWidth: 1, borderRadius: 16, padding: 11, marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 10 }, albumExportIcon: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center" }, albumExportCopy: { flex: 1, gap: 3 }, albumExportTitle: { fontSize: 14, fontWeight: "900" }, albumExportText: { fontSize: 11 }, emptyAlbumNote: { fontSize: 12, lineHeight: 17, marginBottom: 10 }, info: { flexDirection: "row", gap: 11, marginBottom: 16 }, infoIcon: { width: 39, height: 39, borderRadius: 13, alignItems: "center", justifyContent: "center" }, infoCopy: { flex: 1, gap: 3 }, infoTitle: { fontSize: 14, fontWeight: "800" }, infoText: { fontSize: 12, lineHeight: 17 }, logout: { marginTop: 15, height: 50, borderRadius: 15, borderWidth: 1, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" }, logoutText: { fontSize: 14, fontWeight: "800" }, login: { minHeight: 48, borderRadius: 14, alignItems: "center", justifyContent: "center" }, loginText: { color: "#141317", fontWeight: "800" } });
