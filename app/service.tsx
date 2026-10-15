import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { EmptyState, LoadingState, SectionTitle, StudioHeader } from "@/components/studio-ui";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { OnPrimary, Radius, Type } from "@/lib/design-tokens";
import { downloadOrShareFile } from "@/lib/download-and-share";
import {
  cancelServiceJob, completedBackups, confirmServiceRestore, createServiceUser, formatBytes,
  listServiceJobs, listServiceUsers, prepareServiceRestore, startServiceBackup,
  type ServiceJob, type ServiceUser,
} from "@/lib/service-console";

/**
 * Servisní konzole. Dostane se sem jen účet z tabulky sc_service_accounts —
 * funkce to ověřuje a nepovolenému účtu vrátí 403. Obrazovka proto sama nic
 * neautentizuje, jen kreslí co funkce vrátila.
 */
export default function ServiceConsoleScreen() {
  const colors = useColors();
  const router = useRouter();
  const { isAuthenticated, user } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState<string | null>(null);
  const [users, setUsers] = useState<ServiceUser[]>([]);
  const [jobs, setJobs] = useState<ServiceJob[]>([]);
  const [neverExported, setNeverExported] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  // Obnova je dvoukroková: prepare vrátí token a teprve jeho vložení ji spustí.
  const [pending, setPending] = useState<{ jobId: string; token: string; message: string; warnings: string[] } | null>(null);
  const [tokenInput, setTokenInput] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [userList, jobList] = await Promise.all([listServiceUsers(), listServiceJobs()]);
      setUsers(userList.users);
      setNeverExported(userList.neverExported);
      setJobs(jobList.jobs);
      setForbidden(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Konzole neodpověděla.";
      // 403 není chyba, je to jen "tento účet nemá služební práva".
      setForbidden(message.includes("služební") || message.includes("oprávnění") || message.includes("allowlist") ? message : null);
      if (!forbidden) Alert.alert("Konzole selhala", message);
    }
  }, [forbidden]);

  useEffect(() => {
    if (isAuthenticated) void refresh();
  }, [isAuthenticated, refresh]);

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    try {
      await task();
      await refresh();
    } catch (error) {
      Alert.alert("Operace se nepodařila", error instanceof Error ? error.message : "Zkus to prosím znovu.");
    } finally {
      setBusy(null);
    }
  };

  const createUser = () =>
    run("create", async () => {
      if (password.length < 8) throw new Error("Heslo musí mít alespoň 8 znaků.");
      const result = await createServiceUser({ email, password, displayName });
      setEmail(""); setDisplayName(""); setPassword("");
      Alert.alert("Účet založený", [result.message, ...result.warnings].join("\n\n"));
    });

  const runBackup = () =>
    run("backup", async () => {
      const result = await startServiceBackup();
      Alert.alert("Záloha spuštěná", result.message);
    });

  const restore = (job: ServiceJob, target: ServiceUser) => {
    Alert.alert(
      `Obnovit data účtu ${target.email ?? target.id}?`,
      "Jeho současná data se smažou a nahradí tím ze zálohy. Bez potvrzovacího tokenu se nic nespustí.",
      [
        { text: "Zpět", style: "cancel" },
        {
          text: "Připravit obnovu",
          style: "destructive",
          onPress: () =>
            run(`restore:${job.id}`, async () => {
              const prepared = await prepareServiceRestore({ sourceBackupId: job.id, targetUserId: target.id, mode: "restore_existing" });
              setTokenInput(prepared.confirmationToken);
              setPending({
                jobId: prepared.job.id,
                token: prepared.confirmationToken,
                message: prepared.message,
                warnings: prepared.warnings,
              });
            }),
        },
      ],
    );
  };

  const confirmRestore = () =>
    run("confirm", async () => {
      if (!pending) return;
      if (tokenInput.trim() !== pending.token) throw new Error("Token nesouhlasí s tím, který funkce vydala.");
      await confirmServiceRestore(pending.jobId, tokenInput.trim());
      setPending(null);
      setTokenInput("");
      Alert.alert("Obnova potvrzena", "Běží na rendereru. Průběh uvidíš v seznamu úloh.");
    });

  const backups = completedBackups(jobs);
  const active = jobs.filter((job) => job.status === "queued" || job.status === "running" || job.status === "awaiting_confirmation");

  if (!isAuthenticated) {
    return <ScreenContainer className="p-5 justify-center"><EmptyState icon="lock" title="Servisní konzole" text="Přihlas se jako služební účet." /></ScreenContainer>;
  }
  if (forbidden) {
    return <ScreenContainer className="p-5 justify-center"><EmptyState icon="lock" title="Bez oprávnění" text={forbidden} action={<Pressable onPress={() => router.back()} style={[styles.primary, { backgroundColor: colors.primary }]}><Text style={styles.primaryText}>Zpět</Text></Pressable>} /></ScreenContainer>;
  }
  if (busy === null && users.length === 0 && jobs.length === 0) {
    return <ScreenContainer><LoadingState /></ScreenContainer>;
  }

  return <ScreenContainer className="px-5"><ScrollView contentContainerStyle={styles.content}>
    <StudioHeader eyebrow={`Servis · ${user?.email ?? ""}`} title="Servisní konzole" />
    <Pressable onPress={() => router.back()} style={({ pressed }) => [styles.back, { borderColor: colors.border, opacity: pressed ? 0.6 : 1 }]}>
      <MaterialIcons name="arrow-back" size={18} color={colors.muted} /><Text style={[styles.backText, { color: colors.muted }]}>Zpět do aplikace</Text>
    </Pressable>

    <SectionTitle title="Záloha" />
    <Pressable onPress={() => void runBackup()} disabled={busy !== null || active.length > 0} style={({ pressed }) => [styles.primary, { backgroundColor: colors.primary, opacity: busy !== null || active.length > 0 || pressed ? 0.6 : 1 }]}>
      <MaterialIcons name="backup" size={20} color={OnPrimary} /><Text style={styles.primaryText}>
        {active.length > 0 ? "Pracuji…" : "Zálohat všechny účty"}
      </Text>
    </Pressable>
    <Text style={[styles.note, { color: colors.muted }]}>
      Texty, alba, obálky, MP3 i videa všech účtů do jednoho archivu. {neverExported.length > 0 ? `Záměrně bez: ${neverExported.join(", ")}.` : ""}
    </Text>

    {jobs.length > 0 ? <>
      <SectionTitle title="Úlohy" />
      {jobs.slice(0, 8).map((job) => <View key={job.id} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.cardHead}>
          <MaterialIcons name={job.kind === "backup" ? "backup" : "restore"} size={19} color={job.status === "failed" ? colors.error : job.status === "done" ? colors.success : colors.primary} />
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>{job.kind === "backup" ? "Záloha" : "Obnova"} · {job.status}</Text>
          <Text style={[styles.cardMeta, { color: colors.muted }]}>{new Date(job.created_at).toLocaleString("cs-CZ")}</Text>
        </View>
        {job.status === "running" || job.status === "queued" ? <Text style={[styles.note, { color: colors.muted }]}>{String(job.progress?.stage ?? "čeká na renderer")}</Text> : null}
        {job.error_message ? <Text style={[styles.note, { color: colors.error }]}>{job.error_message}</Text> : null}
        {job.status === "done" && job.kind === "backup" ? <View style={styles.cardActions}>
          <Text style={[styles.note, { color: colors.muted }]}>{formatBytes(job.archive_bytes)}</Text>
          {job.downloadUrl ? <Pressable onPress={() => void downloadOrShareFile(job.downloadUrl!, `${job.id}.tar.zst`, "application/zstd", "Záloha SongCraft Studio")}><Text style={[styles.link, { color: colors.primary }]}>Stáhnout</Text></Pressable> : null}
        </View> : null}
        {["queued", "running", "awaiting_confirmation"].includes(job.status) ? <Pressable onPress={() => void run(`cancel:${job.id}`, async () => { await cancelServiceJob(job.id); })}><Text style={[styles.link, { color: colors.error }]}>Zrušit</Text></Pressable> : null}
      </View>)}
    </> : null}

    <SectionTitle title="Účty" />
    {pending ? <View style={[styles.card, { backgroundColor: `${colors.warning}12`, borderColor: `${colors.warning}55` }]}>
      <Text style={[styles.cardTitle, { color: colors.foreground }]}>Potvrzení obnovy</Text>
      <Text style={[styles.note, { color: colors.muted }]}>{pending.message}</Text>
      <Text selectable style={[styles.token, { color: colors.warning }]}>{pending.token}</Text>
      <Text style={[styles.note, { color: colors.muted }]}>{pending.warnings.join(" ")}</Text>
      <TextInput value={tokenInput} onChangeText={setTokenInput} placeholder="vlož potvrzovací token" autoCapitalize="none" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} />
      <View style={styles.row}>
        <Pressable onPress={() => { setPending(null); setTokenInput(""); }} style={[styles.secondary, { borderColor: colors.border, flex: 1 }]}><Text style={[styles.secondaryText, { color: colors.muted }]}>Zrušit</Text></Pressable>
        <Pressable onPress={() => void confirmRestore()} disabled={busy === "confirm"} style={[styles.secondary, { borderColor: colors.error, flex: 1 }]}>
          {busy === "confirm" ? <ActivityIndicator size="small" color={colors.error} /> : <MaterialIcons name="warning" size={18} color={colors.error} />}
          <Text style={[styles.secondaryText, { color: colors.error }]}>Potvrdit a obnovit</Text>
        </Pressable>
      </View>
    </View> : null}
    {users.map((account) => <View key={account.id} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.cardHead}>
        <MaterialIcons name={account.isService ? "verified-user" : "person"} size={19} color={account.isService ? colors.primary : colors.muted} />
        <Text style={[styles.cardTitle, { color: colors.foreground }]}>{account.displayName ?? account.email ?? account.id}</Text>
        {account.isService ? <Text style={[styles.badge, { color: colors.primary }]}>služba</Text> : null}
      </View>
      <Text style={[styles.note, { color: colors.muted }]}>{account.email} · {account.totalRows} řádků · {account.files} souborů</Text>
      {backups.length > 0 ? <Pressable onPress={() => restore(backups[0], account)} style={({ pressed }) => [styles.secondary, { borderColor: colors.primary, opacity: pressed ? 0.6 : 1 }]}>
        <MaterialIcons name="restore" size={17} color={colors.primary} /><Text style={[styles.secondaryText, { color: colors.primary }]}>Obnovit z poslední zálohy</Text>
      </Pressable> : null}
    </View>)}

    <SectionTitle title="Založit účet" />
    <TextInput value={displayName} onChangeText={setDisplayName} placeholder="Jméno" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} />
    <TextInput value={email} onChangeText={setEmail} placeholder="e-mail" autoCapitalize="none" keyboardType="email-address" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} />
    <TextInput value={password} onChangeText={setPassword} placeholder="heslo (min. 8 znaků)" secureTextEntry placeholderTextColor={colors.muted} style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} />
    <Pressable onPress={() => void createUser()} disabled={busy === "create"} style={({ pressed }) => [styles.primary, { backgroundColor: colors.primary, opacity: busy === "create" || pressed ? 0.6 : 1 }]}>
      {busy === "create" ? <ActivityIndicator size="small" color={OnPrimary} /> : <MaterialIcons name="person-add" size={19} color={OnPrimary} />}
      <Text style={styles.primaryText}>Založit</Text>
    </Pressable>
    <Text style={[styles.note, { color: colors.muted }]}>
      Nový účet se musí objevit i na přihlašovací obrazovce aplikace (app/auth.tsx), jinak se v něm nelze vybrat.
    </Text>
  </ScrollView></ScreenContainer>;
}

const styles = StyleSheet.create({
  content: { paddingTop: 14, paddingBottom: 33, gap: 0 },
  back: { flexDirection: "row", alignItems: "center", gap: 7, alignSelf: "flex-start", borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 8 },
  backText: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "700" },
  primary: { minHeight: 48, borderRadius: Radius.sm, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9 },
  primaryText: { color: OnPrimary, fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "900" },
  secondary: { minHeight: 42, borderWidth: 1, borderRadius: Radius.sm, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 10 },
  secondaryText: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "800" },
  input: { borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 13, paddingVertical: 12, marginBottom: 9, fontSize: 15 },
  card: { borderWidth: 1, borderRadius: Radius.md, padding: 13, gap: 6, marginBottom: 9 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 9 },
  cardTitle: { flex: 1, fontSize: 15, fontWeight: "800" },
  cardMeta: { ...Type.caption },
  cardActions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  badge: { ...Type.caption, fontWeight: "800" },
  note: { ...Type.caption, lineHeight: 16 },
  token: { fontSize: 13, fontWeight: "800", letterSpacing: 0.6, paddingVertical: 6 },
  row: { flexDirection: "row", gap: 9, marginTop: 4 },
  link: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "800" },
});