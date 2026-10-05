import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenContainer } from "@/components/screen-container";
import { CoverArt, EmptyState, PrimaryButton, SecondaryButton, Shimmer, StudioHeader } from "@/components/studio-ui";
import { VideoCompositionStrip, VideoModeCard } from "@/components/video-mode-card";
import { startPrivateLogin } from "@/constants/oauth";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import {
  albumCoverNote,
  checkVideoTabReadiness,
  listSongMediaCounts,
  type CenterEffect,
  type VideoTabMode,
} from "@/lib/external-studio";
import { downloadOrShareFile, saveFinishedVideoToDownloads } from "@/lib/download-and-share";
import { Hairline, Radius, Space, Type } from "@/lib/design-tokens";
import { trpc } from "@/lib/trpc";
import {
  CENTER_EFFECTS,
  findVideoMode,
  VIDEO_MODES,
  type VideoModeDefinition,
} from "@/lib/video-modes";
import { getVideoDownloadUrl, listVideoJobs, type StudioVideoJob } from "@/lib/video-jobs";

/** Obál alba nahoře i dole. Změna musí být v gallery-engine.mjs. */
const COVER_SECONDS = 3;
/** Které režimy se schovají pod hlavní kartou „Video s více médii". */
const GALLERY_IDS: VideoTabMode[] = ["gallery_images", "gallery_videos", "gallery_mixed"];

type Step = "mode" | "song" | "running";

export default function VideosScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { isAuthenticated, loading } = useAuth();
  const snapshot = trpc.studio.snapshot.useQuery(undefined, { enabled: isAuthenticated });

  const [step, setStep] = useState<Step>("mode");
  const [modeId, setModeId] = useState<VideoTabMode>("album_cover_intro");
  const [effect, setEffect] = useState<CenterEffect>("breathe");
  const [songId, setSongId] = useState<string | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /**
   * Počty doprovodných médií. Nejsou ve snapshotu - u písně s 30 scénami by
   * to byl zbytečně velký payload. Načítá se zvlášť, jen když je potřeba.
   */
  const [mediaCounts, setMediaCounts] = useState<Record<string, { images: number; videos: number }>>({});

  const createRender = trpc.studio.createVideoTabRender.useMutation();
  const [progress, setProgress] = useState<string | null>(null);
  const [jobs, setJobs] = useState<StudioVideoJob[]>([]);
  const [jobsError, setJobsError] = useState<string | null>(null);

  const mode: VideoModeDefinition = findVideoMode(modeId) ?? VIDEO_MODES[0];

  // Poll smyčka běží asynchronně a potřebuje číst aktuální stav úlohy. `jobs` ze
// state je ve chytací funkci zavřený z doby, kdy se smyčka vytvořila, takže
// držíme si i ref, který se aktualizuje při každém načtení.
const jobsRef = useRef<StudioVideoJob[]>([]);
useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  const loadJobs = useCallback(async () => {
    try {
      setJobsError(null);
      const next = await listVideoJobs(8);
      jobsRef.current = next;
      setJobs(next);
    } catch (caught) {
      setJobsError(caught instanceof Error ? caught.message : "Render joby se nepodařilo načíst.");
    }
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  // Když je ve frontě nebo se něco rendruje, hlídáme stav dál. Jinak by UI
  // tvrdilo „Hotovo" a nikdo by to nečekal.
  const hasActive = jobs.some((job) => job.renderStatus === "queued" || job.renderStatus === "rendering");
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void loadJobs(), 15_000);
    return () => clearInterval(timer);
  }, [hasActive, loadJobs]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    Haptics.selectionAsync().catch(() => {});
    await snapshot.refetch();
    await loadJobs();
    setRefreshing(false);
  }, [loadJobs, snapshot]);

  /** Písně, které mají finální MP3 - bez něj se video nevyrenderuje. */
  const songs = useMemo(() => {
    const data = snapshot.data;
    if (!data) return [];
    const versions = data.versions ?? [];
    return (data.songs ?? [])
      .filter((song) => versions.some((v) => v.songId === song.id && v.isFinal))
      .sort((a, b) => a.title.localeCompare(b.title, "cs"));
  }, [snapshot.data]);

  const albums = snapshot.data?.albums ?? [];

  const songIdsKey = useMemo(() => songs.map((song) => String(song.id)).sort().join(","), [songs]);

  // Počty médií se načítají až na obrazovce výběru skladby. Když jich není
  // potřeba, tenhle dotaz vůbec neodletí.
  useEffect(() => {
    if (step !== "song" || !songIdsKey) return;
    let cancelled = false;
    const ids = songIdsKey.split(",").filter(Boolean);
    void (async () => {
      try {
        const rows = await listSongMediaCounts(ids);
        if (cancelled) return;
        const next: Record<string, { images: number; videos: number }> = {};
        for (const row of rows) next[row.songId] = { images: row.images, videos: row.videos };
        setMediaCounts(next);
      } catch {
        if (!cancelled) setMediaCounts({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [songIdsKey, step]);

  const finalVersionFor = useCallback(
    (id: string) => {
      const versions = (snapshot.data?.versions ?? []).filter((v) => v.songId === id && v.isFinal);
      return versions.find((v) => v.isPrimary) ?? versions[0] ?? null;
    },
    [snapshot.data],
  );

  /** Kolik doprovodných médií píseň má. Když ještě nevíme, řekneme "0". */
  const mediaCountFor = useCallback(
    (id: string) => mediaCounts[id] ?? { images: 0, videos: 0 },
    [mediaCounts],
  );

  const readinessFor = useCallback(
    (id: string) => {
      const song = songs.find((entry) => entry.id === id);
      const counts = mediaCountFor(id);
      return checkVideoTabReadiness({
        songId: id,
        mode: modeId,
        imageCount: counts.images,
        videoCount: counts.videos,
        hasFinalAudio: Boolean(finalVersionFor(id)),
        hasSongCover: Boolean(song?.coverUrl),
      });
    },
    [finalVersionFor, mediaCountFor, modeId, songs],
  );

  const startRender = useCallback(
    async (targetSongId: string) => {
      const version = finalVersionFor(targetSongId);
      if (!version) {
        Alert.alert("Chybí finální MP3", "K této skladbě není označená finální verze. Označ ji v editoru písně.");
        return;
      }
      try {
        setProgress("Zakládám úlohu pro renderer…");
        const initial = await createRender.mutateAsync({
          songId: targetSongId,
          versionId: version.id,
          mode: modeId,
          centerEffect: modeId === "album_cover_intro" ? effect : null,
        });
        if (initial.status === "failed") throw new Error(initial.error);
        if (initial.status === "completed") {
          setProgress(null);
          await loadJobs();
          return;
        }
        if (!initial.jobId) throw new Error("Renderer nevrátil ID úlohy.");

        // Render na VM trvá minuty, u dlouhé písně i desítky minut. 72 x 5 s
        // odpovídá starší obrazovce exportu; tady necháme běžet 120 x 5 s,
        // aby dlouhé video mělo šanci doběhnout.
        setProgress("Ve frontě Oracle rendereru…");
        const jobId = initial.jobId;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          setProgress(`Renderuje se (${attempt + 1}/120)…`);
          // loadJobs vrací void, takže stav čteme přímo z jobs přes ref.
          await loadJobs();
          const current = jobsRef.current.find((job) => job.id === jobId);
          if (current?.renderStatus === "failed") {
            throw new Error(current.errorMessage || "Render selhal.");
          }
          if (current?.renderStatus === "ready") {
            setProgress(null);
            return;
          }
        }
        throw new Error("Renderer video nedokončil. Zkontroluj stav v seznamu níž.");
      } catch (caught) {
        setProgress(null);
        Alert.alert(
          "Video se nevyrenderovalo",
          caught instanceof Error ? caught.message : "Zkus to prosím znovu.",
        );
      }
    },
    [createRender, effect, finalVersionFor, loadJobs, modeId],
  );

  const downloadJob = useCallback(async (job: StudioVideoJob) => {
    try {
      const url = await getVideoDownloadUrl(job);
      const song = songs.find((entry) => entry.id === job.songId);
      const fileName = `${(song?.title ?? "video").replace(/[^a-z0-9_-]/gi, "_")}-Temney.mp4`;
      const saved = await saveFinishedVideoToDownloads(url, fileName);
      if (saved) Alert.alert("Video je uložené", `Je ve složce Download / SongCraft Studio jako ${fileName}.`);
      else await downloadOrShareFile(url, fileName, "video/mp4", "Uložit hotové video");
    } catch (caught) {
      Alert.alert("Stažení selhalo", caught instanceof Error ? caught.message : "Zkus to prosím znovu.");
    }
  }, [songs]);

  if (loading || (isAuthenticated && snapshot.isLoading)) {
    return (
      <ScreenContainer className="px-5">
        <View style={{ paddingTop: 14, gap: 12 }}>
          <Shimmer height={36} radius={16} />
          <Shimmer height={88} radius={16} />
          <Shimmer height={88} radius={16} />
          <Shimmer height={88} radius={16} />
        </View>
      </ScreenContainer>
    );
  }

  if (!isAuthenticated) {
    return (
      <ScreenContainer className="p-5 justify-center">
        <EmptyState
          icon="lock"
          title="Videa jsou soukromá"
          text="Přihlas se, aby se načetly skladby, jejich finální MP3 a doprovodná média."
          action={<PrimaryButton label="Přihlásit se" icon="login" onPress={() => void startPrivateLogin()} />}
        />
      </ScreenContainer>
    );
  }

  // ---------------------------------------------------------------- krok 1
  if (step === "mode") {
    const single = VIDEO_MODES.find((entry) => !GALLERY_IDS.includes(entry.id as VideoTabMode))!;
    const galleryEntry = VIDEO_MODES.find((entry) => entry.id === "gallery_images")!;
    const galleryGroup = VIDEO_MODES.filter((entry) => GALLERY_IDS.includes(entry.id as VideoTabMode));

    return (
      <ScreenContainer className="px-5">
        {/*
          Krok 1 nemá seznam k zobrazení, takže je to ScrollView. FlatList s
          prázdným `data` by vyžadoval renderItem a TS by to odmítl.
        */}
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 96 }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
              progressBackgroundColor={colors.surface}
            />
          }
        >
          <View style={styles.stack}>
              <StudioHeader eyebrow="Tvorba videa" title="Videa" />

              <Text style={[Type.body, styles.intro, { color: colors.muted }]}>
                Vybři typ videa. Každý typ má stejný začátek a konec: obál alba 3 s. Uprostřed je to,
                co zvolíš.
              </Text>

              {/* Typ 1: obrázek skladby */}
              <VideoModeCard
                icon={single.icon}
                label={single.label}
                detail={single.detail}
                selected={modeId === single.id}
                onPress={() => setModeId(single.id as VideoTabMode)}
              />

              {modeId === single.id ? (
                <View style={styles.panel}>
                  <Text style={[Type.label, { color: colors.foreground }]}>Efekt na obrázku skladby</Text>
                  <Text style={[Type.caption, { color: colors.muted }]}>
                    Obrázek není statický. Efekt běží na celou dobu písně.
                  </Text>
                  <View style={styles.effectRow}>
                    {CENTER_EFFECTS.map((choice) => {
                      const active = effect === choice.id;
                      return (
                        <Pressable
                          key={choice.id}
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                          accessibilityLabel={choice.label}
                          onPress={() => {
                            Haptics.selectionAsync().catch(() => {});
                            setEffect(choice.id);
                          }}
                          style={({ pressed }) => [
                            styles.effect,
                            {
                              backgroundColor: active ? colors.primary : colors.surfaceElevated,
                              borderColor: active ? colors.primary : Hairline,
                              opacity: pressed ? 0.75 : 1,
                            },
                          ]}
                        >
                          <MaterialIcons
                            name={
                              (choice.id === "breathe"
                                ? "waves"
                                : choice.id === "parallax"
                                  ? "layers"
                                  : "step-forward") as never
                            }
                            size={18}
                            color={active ? colors.onPrimary : colors.primary}
                          />
                          <Text
                            style={[
                              Type.label,
                              { color: active ? colors.onPrimary : colors.foreground },
                            ]}
                          >
                            {choice.label}
                          </Text>
                          <Text
                            numberOfLines={2}
                            style={[
                              Type.caption,
                              { color: active ? colors.onPrimary : colors.muted },
                            ]}
                          >
                            {choice.detail}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <VideoCompositionStrip
                    coverSeconds={COVER_SECONDS}
                    sceneSeconds={null}
                    sceneLabels="obrázek skladby"
                    note={`Efekt: ${CENTER_EFFECTS.find((c) => c.id === effect)?.label}`}
                  />
                </View>
              ) : null}

              {/* Typ 2: video s více médii */}
              <View style={styles.spacer} />
              <VideoModeCard
                icon={galleryEntry.icon}
                label="Video s více médii"
                detail="Víc obrázků, smyčka z videí nebo obojí dohromady"
                selected={GALLERY_IDS.includes(modeId)}
                expanded={galleryOpen}
                onPress={() => {
                  const next = !galleryOpen;
                  setGalleryOpen(next);
                  if (next) setModeId(galleryGroup[0].id as VideoTabMode);
                }}
              />

              {galleryOpen ? (
                <View style={styles.subgroup}>
                  {galleryGroup.map((entry) => (
                    <VideoModeCard
                      key={entry.id}
                      nested
                      icon={entry.icon}
                      label={entry.label}
                      detail={entry.detail}
                      selected={modeId === entry.id}
                      onPress={() => setModeId(entry.id as VideoTabMode)}
                    />
                  ))}
                </View>
              ) : null}

              {GALLERY_IDS.includes(modeId) ? (
                <View style={styles.panel}>
                  <VideoCompositionStrip
                    coverSeconds={COVER_SECONDS}
                    sceneSeconds={modeId === "gallery_images" ? 8 : null}
                    sceneLabels={
                      modeId === "gallery_images"
                        ? "obrázky"
                        : modeId === "gallery_videos"
                          ? "krátké scény 5–10 s"
                          : "obrázky i scény v tvém pořadí"
                    }
                    note="Pořadí médií nastavíš tážením v panelu doprovodných médií v editoru písně."
                  />
                </View>
              ) : null}

              <PrimaryButton
                label={`Vybrat skladbu · ${mode.label}`}
                icon="arrow-forward"
                onPress={() => setStep("song")}
              />
            </View>
        </ScrollView>
      </ScreenContainer>
    );
  }

  // ---------------------------------------------------------------- krok 2
  if (step === "song") {
    const chosen = songs.find((song) => song.id === songId);
    const readiness = songId ? readinessFor(songId) : null;

    return (
      <ScreenContainer className="px-5">
        <FlatList
          data={songs}
          keyExtractor={(item) => String(item.id)}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 96 }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
              progressBackgroundColor={colors.surface}
            />
          }
          ListHeaderComponent={
            <View style={styles.stack}>
              <StudioHeader eyebrow={mode.label} title="Vyber skladbu" />
              <SecondaryButton
                label="Zpět na typ videa"
                icon="arrow-back"
                onPress={() => setStep("mode")}
              />
              <Text style={[Type.body, styles.intro, { color: colors.muted }]}>
                {mode.detail}
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const counts = mediaCountFor(item.id);
            const check = readinessFor(item.id);
            const itemAlbum = albums.find((entry) => entry.id === item.albumId);
            const note = albumCoverNote(itemAlbum?.coverUrl ?? null);

            const mediaBadge =
              counts.images || counts.videos
                ? `${counts.images} obrázků · ${counts.videos} videí`
                : "0 doprovodných médií";

            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: item.id === songId, disabled: !check.ready }}
                accessibilityLabel={item.title}
                disabled={!check.ready}
                onPress={() => {
                  Haptics.selectionAsync().catch(() => {});
                  setSongId(item.id);
                }}
                style={({ pressed }) => [
                  styles.songRow,
                  {
                    backgroundColor: item.id === songId ? `${colors.primary}14` : colors.surface,
                    borderColor: item.id === songId ? colors.primary : Hairline,
                    opacity: check.ready ? (pressed ? 0.75 : 1) : 0.5,
                  },
                ]}
              >
                <CoverArt uri={item.coverUrl ?? itemAlbum?.coverUrl} title={item.title} size={54} />
                <View style={styles.songCopy}>
                  <Text numberOfLines={1} style={[Type.heading, { color: colors.foreground }]}>
                    {item.title}
                  </Text>
                  <Text numberOfLines={1} style={[Type.caption, { color: colors.muted }]}>
                    {itemAlbum?.name ?? "Bez alba"} · {mediaBadge}
                  </Text>
                  {!check.ready ? (
                    <Text style={[Type.caption, { color: colors.warning }]}>
                      {check.label} — video pro tenhle typ nejde
                    </Text>
                  ) : note ? (
                    <Text numberOfLines={1} style={[Type.caption, { color: colors.mutedSubtle }]}>
                      {note}
                    </Text>
                  ) : null}
                </View>
                {item.id === songId ? (
                  <MaterialIcons name="check-circle" size={20} color={colors.primary} />
                ) : (
                  <MaterialIcons name="chevron-right" size={19} color={colors.muted} />
                )}
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <EmptyState
              icon="music-off"
              title="Zatím tu nejsou skladby s finálním MP3"
              text="Video se vyrábí z finální verze MP3. Označ ji v editoru písně a tab se doplní."
              action={
                <PrimaryButton
                  label="Nová skladba"
                  icon="add"
                  onPress={() => router.push("/song/new" as never)}
                />
              }
            />
          }
          ListFooterComponent={
            songId && readiness?.ready ? (
              <View style={styles.stack}>
                <VideoCompositionStrip
                  coverSeconds={COVER_SECONDS}
                  sceneSeconds={modeId === "gallery_images" ? 8 : null}
                  sceneLabels={
                    modeId === "album_cover_intro"
                      ? "obrázek skladby"
                      : modeId === "gallery_images"
                        ? "obrázky"
                        : modeId === "gallery_videos"
                          ? "krátké scény 5–10 s"
                          : "obrázky i scény v tvém pořadí"
                  }
                  note={
                    modeId === "album_cover_intro"
                      ? `Obraz skladby: ${chosen?.title ?? ""} · efekt ${CENTER_EFFECTS.find((c) => c.id === effect)?.label}`
                      : "Délku jednotlivých scén změníš v panelu doprovodných médií v editoru písně."
                  }
                />
                <PrimaryButton
                  label={progress ?? `Vytvořit video · ${chosen?.title ?? ""}`}
                  icon="movie"
                  disabled={Boolean(progress)}
                  onPress={() => void startRender(songId)}
                />
                {progress ? <Text style={[Type.caption, { color: colors.muted }]}>{progress}</Text> : null}
              </View>
            ) : null
          }
        />
      </ScreenContainer>
    );
  }

  // ---------------------------------------------------------------- krok 3
  return (
    <ScreenContainer className="px-5">
      <FlatList
        data={jobs}
        keyExtractor={(item) => String(item.id)}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 96 }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surface}
          />
        }
        ListHeaderComponent={
          <View style={styles.stack}>
            <StudioHeader eyebrow="Fronta renderu" title="Vytvořená videa" />
            <SecondaryButton label="Nové video" icon="add" onPress={() => setStep("mode")} />
            {jobsError ? (
              <Pressable
                onPress={() => void loadJobs()}
                style={[styles.errorCard, { borderColor: colors.warning, backgroundColor: `${colors.warning}12` }]}
              >
                <MaterialIcons name="sync" size={18} color={colors.warning} />
                <Text style={[Type.caption, { color: colors.muted, flex: 1 }]}>
                  {jobsError} Klepni pro opakovat.
                </Text>
              </Pressable>
            ) : null}
          </View>
        }
        renderItem={({ item }) => {
          const song = songs.find((entry) => entry.id === item.songId);
          const album = albums.find((entry) => entry.id === song?.albumId);
          const jobMode = findVideoMode(item.mode ?? item.type);
          const state =
            item.renderStatus === "ready"
              ? { label: "Hotovo", icon: "check-circle", tone: colors.success }
              : item.renderStatus === "failed"
                ? { label: "Selhalo", icon: "error", tone: colors.error }
                : item.renderStatus === "rendering"
                  ? { label: "Renderuje se", icon: "autorenew", tone: colors.primary }
                  : { label: "Ve frontě", icon: "hourglass-top", tone: colors.warning };

          return (
            <View style={[styles.jobCard, { backgroundColor: colors.surface, borderColor: Hairline }]}>
              <CoverArt uri={song?.coverUrl ?? album?.coverUrl} title={song?.title ?? "Video"} size={48} />
              <View style={styles.songCopy}>
                <Text numberOfLines={1} style={[Type.label, { color: colors.foreground }]}>
                  {song?.title ?? "Skladba"}
                </Text>
                <Text numberOfLines={1} style={[Type.caption, { color: colors.muted }]}>
                  {jobMode?.label ?? (item.mode ?? item.type)}
                </Text>
                <View style={styles.stateRow}>
                  <MaterialIcons name={state.icon as never} size={13} color={state.tone} />
                  <Text style={[Type.caption, { color: state.tone }]}>{state.label}</Text>
                </View>
                {item.errorMessage ? (
                  <Text numberOfLines={2} style={[Type.caption, { color: colors.error }]}>
                    {item.errorMessage}
                  </Text>
                ) : null}
              </View>
              {item.renderStatus === "ready" ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Stáhnout video"
                  onPress={() => void downloadJob(item)}
                  style={({ pressed }) => [
                    styles.downloadButton,
                    { backgroundColor: colors.primary, opacity: pressed ? 0.7 : 1 },
                  ]}
                >
                  <MaterialIcons name="download" size={19} color={colors.onPrimary} />
                </Pressable>
              ) : null}
            </View>
          );
        }}
        ListEmptyComponent={
          <EmptyState
            icon="movie"
            title="Zatím tu nejsou žádná videa"
            text="Vyber typ videa a vytvoř první. Render běží na Oracle VM, může trvat pár minut."
            action={<PrimaryButton label="Vytvořit první video" icon="add" onPress={() => setStep("mode")} />}
          />
        }
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 14, paddingBottom: 36, gap: 12 },
  stack: { gap: Space.md },
  spacer: { height: Space.xs },
  intro: { lineHeight: 21 },
  panel: {
    gap: Space.sm,
    padding: Space.lg,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Hairline,
    backgroundColor: "rgba(255,255,255,0.02)",
  },
  subgroup: { gap: Space.sm, paddingLeft: Space.md },
  effectRow: { flexDirection: "row", gap: Space.sm },
  effect: {
    flex: 1,
    minHeight: 96,
    borderRadius: Radius.md,
    borderWidth: 1,
    padding: Space.md,
    gap: 4,
  },
  songRow: {
    minHeight: 76,
    borderRadius: Radius.md,
    borderWidth: 1,
    padding: Space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: Space.md,
    marginBottom: Space.xs,
  },
  songCopy: { flex: 1, gap: 2 },
  jobCard: {
    borderRadius: Radius.md,
    borderWidth: 1,
    padding: Space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: Space.md,
    marginBottom: Space.xs,
  },
  stateRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  downloadButton: {
    width: 42,
    height: 42,
    borderRadius: Radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  errorCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: Space.sm,
    padding: Space.md,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
});
