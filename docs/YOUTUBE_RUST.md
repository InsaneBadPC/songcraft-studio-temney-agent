# Maximalizace sledovanosti na YouTube (zdarma)

Návod, podle kterého se řídí publikace SongCraft Studia. Cíl: co nejvíc
zhlédnutí a poslechů vlastní hudby bez placené reklamy. Výchozí metriky, které
algoritmus u hudebních kanálů sleduje: **CTR** (míra prokliku), **AVD/APV**
(průměrná doba a procento sledování) a **Session Time** (doba relace).

Tento dokument je zdroj pravdy. Když se praxe změní, mění se i on.

## 1. Systém „Shorts → dlouhé video"

Shorts mají největší organický dosah. Cílem je převést diváka na celou skladbu.

- Z každé skladby vystřihni **3–5 různých úseků (15–30 s)** — refrén, zlom v
  beatu, nejsilnější verše.
- Do obrazu **vypal text písně** (titulky) přesně ve středu — drží pozornost.
- V YouTube Studiu → Shorts → **„Související video"** vyber celou skladbu.
  V přehrávači Shorts se nad názvem zobrazí klikatelný odkaz na plné video.

## 2. Struktura názvu pro neznámé skladby

Samotné „[Interpret] – [Název]" nestačí, nikdo ho nevyhledává.

- Struktura: `[Interpret] - [Název] ([Žánr / Nálada] | Official Lyric Video)`
- Příklad: `TEMNEY - Falešná naděje (Temný Český Rap | Official Lyric Video)`
- Žánrový deskriptor v závorce řekne divákovi i algoritmu, o co jde → vyšší CTR.

## 3. Eliminace statického obrazu a prvních 5 sekund

„Official Audio" se statickou fotkou má nízkou retenci.

- **0–3 s:** žádné ticho ani pomalý náběh — hudba/hlas od první sekundy.
- **Lyric video:** text písně ve videu + jemný pohyb pozadí/vizualizér.
  Divák čte text, takže u videa zůstává déle (AVD).

## 4. Indexace textu přes titulky (.srt / YouTube Studio)

Algoritmus čte textová data, ne emoci ze zvuku.

- YouTube Studio → Podrobnosti → **Titulky** → vlož kompletní český text
  a nech ho automaticky načasovat.
- YouTube zaindexuje každé slovo → skladba se zobrazuje lidem, kteří hledají
  fráze z textu.
- **Celý text** dej i do popisku videa.

## 5. Testování miniatur (A/B)

Miniatura s CTR pod 3 % = málo zhlédnutí.

- **3 vizuálně odlišné miniatury** (vysoký kontrast, 2–4 slova nejvýraznějšího
  verše, neopakovat název videa).
- V YouTube Studiu použij **„Testování a porovnávání" (Test & Compare)**.
  YouTube sám zvolí variantu s nejvyšší dobou sledování.

## 6. Zkrácené konce a řetězení přes playlisty

Dlouhý fade-out do černa = divák vypne = konec relace.

- Playlist seřazený od **nejúspěšnější po nejnovější**.
- **End Screen** nastav přesně v momentu doznění posledního refrénu.
- Do end screenu vlož odkaz na **celý playlist**, ne jen na jedno video —
  další skladby se přehrají automaticky.

## 7. Algoritmický impulz přes připnutý komentář

Komentáře v prvních 24 h = signál, že obsah vyvolává reakci.

- Ihned po zveřejnění napiš **vlastní komentář a připni ho**.
- Vlož **otázku na publikum** (např. „Který verš ti sedí nejvíc?") a pod to
  kompletní text skladby.
- Na každý komentář odpověz **otázkou** (zdvojnásobí počet komentářů).

## Stav implementace v SongCraft Studiu

Legenda: **API** = dá se plně zautomatizovat přes YouTube Data API;
**Studio** = jediné místo je ručně v YouTube Studiu (Google API neumožňuje);
**externí** = skript mimo repo, dokud se nepřenese do appky.

| Bod | Stav | Kde / jak |
|---|---|---|
| 1. Shorts → plné video (Související video) | **Studio** | API neumí; dělá se v YouTube Studiu → Shorts → Související video |
| 1b. Připnutý komentář s odkazem | **API** | `commentThreads.insert` v `youtube-publish` (externí skript `yt_upload.py` už není potřeba) |
| 2. Název s žánrovým deskriptorem | **API** | `supabase/functions/_shared/youtube-metadata.ts` → `buildYoutubeTitle` |
| 3. Dynamický vizuál (lyric/cover video) | hotovo v rendereru | `workers/video-renderer/gallery-engine.mjs` (obálka + pohyb) |
| 4a. Plný text v popisu | **API** | `_shared/youtube-metadata.ts` → `buildYoutubeDescription` |
| 4b. Titulky (.srt → captions.insert) | **API** | `_shared/youtube-metadata.ts` → `buildSimpleSrt` + `captions.insert` v `youtube-publish` |
| 5. A/B miniatury (Test & Compare) | **Studio** | Google A/B API neexistuje; `thumbnails.set` jen nastaví jednu |
| 5b. Miniatura jako obálka | **API** | `thumbnails.set` v `youtube-publish` |
| 6a. End screen | **Studio** | API neumí |
| 6b. Zařazení do playlistu alba | **API** | `playlist_ids` → `playlistItems.insert` v `youtube-publish` |
| 7. Připnutý komentář s otázkou | **API** | `commentThreads.insert` v `youtube-publish` |

### Co Google API neumí (a proto Studio)

- **Související video u Shorts** — vázané na konkrétní Short, jen Studio.
- **End screen / cards** — API neumí end screens ani karty.
- **A/B testování miniatur (Test & Compare)** — API nemá endpoint pro A/B;
  `thumbnails.set` umí jen trvale nastavit jednu miniatura.
- **Automatické načasování titulků** — `captions.insert` umí nahrát hotový
  `.srt`, ale ne ho načasovat z holého textu. Načasování řeší appka
  (odhadem podle délky veršů) nebo YouTube Studio.
