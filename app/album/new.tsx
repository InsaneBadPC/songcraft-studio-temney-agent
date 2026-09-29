import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { IconButton, PrimaryButton, resolveAssetUrl } from "@/components/studio-ui";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { pickImage } from "@/lib/pick-media";
import { trpc } from "@/lib/trpc";

export default function NewAlbumScreen() {
  const colors = useColors();
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [releaseYear, setReleaseYear] = useState("");
  const [description, setDescription] = useState("");
  const [cover, setCover] = useState<{ key: string; url: string } | null>(null);
  const upload = trpc.studio.upload.useMutation();
  const create = trpc.studio.createAlbum.useMutation();
  const saving = useRef(false);
  const uploadCover = async () => { try { const picked = await pickImage(); if (!picked) return; const uploaded = await upload.mutateAsync({ folder: "covers", fileName: picked.fileName, contentType: picked.mimeType, bytes: picked.bytes }); setCover({ key: uploaded.key, url: uploaded.url }); } catch (error) { Alert.alert("Obal se nepodařilo nahrát", error instanceof Error ? error.message : "Zkus jiný obrázek."); } };
  const save = async () => { if (saving.current) return; saving.current = true; if (!name.trim()) { saving.current = false; Alert.alert("Chybí název alba", "Doplň název, pod kterým chceš tvoji tvorbu třídit."); return; } try { await create.mutateAsync({ name: name.trim(), releaseYear: releaseYear ? Number(releaseYear) : null, description: description || null, coverStorageKey: cover?.key ?? null, coverUrl: cover?.url ?? null }); await utils.studio.snapshot.invalidate(); router.back(); } catch (error) { Alert.alert("Album se nepodařilo vytvořit", error instanceof Error ? error.message : "Zkus to znovu."); } saving.current = false; };
  return <ScreenContainer edges={["top", "bottom", "left", "right"]}><ScrollView contentContainerStyle={styles.content}><View style={styles.topbar}><IconButton label="Zpět" icon="arrow-back" onPress={() => router.back()} /><Text style={[styles.title, { color: colors.foreground }]}>Nové album</Text><View style={styles.spacer} /></View><Pressable onPress={() => void uploadCover()} style={({ pressed }) => [styles.cover, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}>{cover ? <Image source={{ uri: resolveAssetUrl(cover.url) ?? cover.url }} style={styles.coverImage} resizeMode="contain" /> : <><MaterialIcons name="add-photo-alternate" size={30} color={colors.primary} /><Text style={[styles.coverText, { color: colors.foreground }]}>Přidat obal alba</Text></>}</Pressable><Field label="Název alba" value={name} onChangeText={setName} placeholder="Např. 2026" colors={colors} /><Field label="Rok" value={releaseYear} onChangeText={setReleaseYear} placeholder="2026" keyboardType="number-pad" colors={colors} /><Field label="Poznámka k albu" value={description} onChangeText={setDescription} placeholder="Zvuk, koncept nebo termín…" multiline colors={colors} /><PrimaryButton label={create.isPending ? "Vytvářím album" : "Vytvořit album"} icon="album" onPress={() => void save()} disabled={create.isPending} /></ScrollView></ScreenContainer>;
}
function Field({ label, value, onChangeText, placeholder, multiline, keyboardType, colors }: { label: string; value: string; onChangeText: (value: string) => void; placeholder: string; multiline?: boolean; keyboardType?: "number-pad"; colors: ReturnType<typeof useColors> }) { return <View style={styles.field}><Text style={[styles.label, { color: colors.foreground }]}>{label}</Text><TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.muted} multiline={multiline} keyboardType={keyboardType} textAlignVertical={multiline ? "top" : "center"} style={[styles.input, multiline && styles.multiline, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} /></View>; }
const styles = StyleSheet.create({ content: { padding: 20, paddingTop: 14, paddingBottom: 38, gap: 20 }, topbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, title: { fontSize: 17, fontWeight: "800" }, spacer: { width: 44 }, cover: { height: 180, borderWidth: 1, borderRadius: 22, alignItems: "center", justifyContent: "center", gap: 9, overflow: "hidden" }, coverImage: { width: "100%", height: "100%" }, coverText: { fontSize: 15, fontWeight: "800" }, field: { gap: 7 }, label: { fontSize: 15, fontWeight: "800" }, input: { minHeight: 49, borderWidth: 1, borderRadius: 15, paddingHorizontal: 14, fontSize: 15 }, multiline: { minHeight: 118, paddingVertical: 13, lineHeight: 21 } });
