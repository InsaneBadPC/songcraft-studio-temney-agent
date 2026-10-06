-- Tab Videa: čtyři kanonické režimy + cesta k obálu alba.
--
-- Proč tato migrace existuje:
--
-- 1) `source_gallery` NELZE ZALOŽIT. Migrace 20260929000000 zúžila
--    agent_videos.type a .mode na (static_cover, image_animation,
--    full_scenes, video_loop, source_loop) a backend na (ffmpeg,
--    vm_image_animation, vm_full_scenes). `source_gallery` ani
--    `vm_source_loop` tam nebyly, takže UI v app/export/youtube.tsx
--    nabízelo volbu, která vždy skončila 502 "Renderovací úlohu se nepodařilo
--    založit". Tady přidávám hodnoty, které opravdu umí worker vyrenderovat.
--
-- 2) OBÁL ALBA != OBÁL SKLADBY. Uživatel chce obál alba na začátku a na konci,
--    uprostřed obrázek skladby. Dnes worker umí jen `sc_songs.cover_path` s
--    fallbackem na album. Nový sloupec cover_lead_path nese obál alba
--    explicitně, aby renderer nemusel hádat.
--
-- 3) STARÉ ŘÁDKY SE NESMÍ ZAVĚSIT. Řádky se source_gallery / vm_source_loop
--    přemapujeme na gallery_mixed / vm_gallery. Kdyby zůstalo něco
--    nepovoleného, migrace skončí výjimkou - stejný fail-closed vzor jako
--    20260929000000. Raději selže než tichy přijme nesmysl.
--
-- POZOR: soubor se už aplikoval. Jakoukoli opravu dělat do NOVÉ migrace,
-- ne tady. Editovat aplikovaný soubor znamená, že oprava se nikdy nespustí.

-- ---------------------------------------------------------------------------
-- 1. Cesta k obálu alba (začátek a konec videa)
-- ---------------------------------------------------------------------------
alter table public.agent_videos
  add column if not exists cover_lead_path text;

comment on column public.agent_videos.cover_lead_path is
  'Obál alba na začátku a na konci videa. Service-role only jako ostatni cesty.';

-- Stejná vlastnická kontrola, jakou mají storage_path / output_path. Používáme
-- tentýž helper, protože si pohlídá i NOT VALID idempotenci.
select public.songcraft_add_path_constraint(
  'public.agent_videos',
  'agent_videos_cover_lead_path_user_prefix',
  'cover_lead_path'
);

-- Efekt na obrázku skladby pro album_cover_intro. NULL = renderer si vybere
-- breathe. Uživatel vybírá v tabu Videa a hodnota musí být v tomto seznamu,
-- jinak job skončí chybou a uživatel uvidí jen "render selhal".
alter table public.agent_videos
  add column if not exists center_effect text
  check (center_effect is null or center_effect in ('breathe', 'parallax', 'steps'));

comment on column public.agent_videos.center_effect is
  'Efekt na obrázku skladby pro mode=album_cover_intro: breathe | parallax | steps, null = breathe.';

-- Vertikální pozadí pro Shorts (1080x1920). Uživatel ho dodává jako soubor;
-- worker ho použije jako filler kolem vejšího obalu alba / obrázku skladby.
-- NULL znamená, že se použije tmavý rozmazaný obál.
alter table public.agent_videos
  add column if not exists short_background_path text;

comment on column public.agent_videos.short_background_path is
  'Volitelná cesta k pozadí pro 9:16 Shorts, jinak tmavý rozmazaný obál.';

-- ---------------------------------------------------------------------------
-- 2. Nové kanonické režimy
--
--    album_cover_intro  obál alba 3 s -> obrázek skladby -> obál alba 3 s
--    gallery_images     obál alba 3 s -> doprovodné obrázky po 8 s -> obál alba 3 s
--    gallery_videos     obál alba 3 s -> krátké scény 5-10 s -> obál alba 3 s
--    gallery_mixed      obál alba 3 s -> obrázky i scény v pořadí uživatele
-- ---------------------------------------------------------------------------

-- Nejdřív přemapujeme to, co tam zůstalo po source_gallery. Musí být PŘED
-- přidáním nových hodnot do CHECKu, jinak by update spadl na porušení.
update public.agent_videos
set mode = 'gallery_mixed', type = 'gallery_mixed'
where mode in ('source_gallery', 'source_gallery') or type in ('source_gallery', 'source_gallery');

update public.agent_videos
set backend = 'vm_gallery'
where backend = 'vm_source_loop';

-- CHECKy jsou pojmenované, takže je můžeme sundat a znovu přidat.
alter table public.agent_videos drop constraint if exists agent_videos_type_check;
alter table public.agent_videos drop constraint if exists agent_videos_mode_check;
alter table public.agent_videos drop constraint if exists agent_videos_backend_check;

alter table public.agent_videos
  add constraint agent_videos_type_check
  check (type in (
    'static_cover', 'image_animation', 'full_scenes', 'video_loop', 'source_loop',
    'album_cover_intro', 'gallery_images', 'gallery_videos', 'gallery_mixed'
  ));

alter table public.agent_videos
  add constraint agent_videos_mode_check
  check (mode in (
    'static_cover', 'image_animation', 'full_scenes', 'video_loop', 'source_loop',
    'album_cover_intro', 'gallery_images', 'gallery_videos', 'gallery_mixed'
  ));

alter table public.agent_videos
  add constraint agent_videos_backend_check
  check (backend in (
    'ffmpeg', 'vm_image_animation', 'vm_full_scenes',
    'vm_gallery'
  ));

comment on column public.agent_videos.mode is
  'Režim renderu. Tab Videa posílá album_cover_intro, gallery_images, gallery_videos, gallery_mixed.';

comment on column public.agent_videos.backend is
  'Kdo režim vyrábí. vm_gallery = gallery-engine.mjs na Oracle VM, ffmpeg = lokální ffmpeg.';

-- ---------------------------------------------------------------------------
-- 3. Fail-closed: po všechném nesmí zůstat nic nepovoleného
-- ---------------------------------------------------------------------------
do $$
declare
  leftovers text;
begin
  select string_agg(format('%s#%s=%s', type, mode, backend), ', ')
  into leftovers
  from public.agent_videos
  where type not in (
          'static_cover', 'image_animation', 'full_scenes', 'video_loop', 'source_loop',
          'album_cover_intro', 'gallery_images', 'gallery_videos', 'gallery_mixed'
        )
     or mode not in (
          'static_cover', 'image_animation', 'full_scenes', 'video_loop', 'source_loop',
          'album_cover_intro', 'gallery_images', 'gallery_videos', 'gallery_mixed'
        )
     or backend not in ('ffmpeg', 'vm_image_animation', 'vm_full_scenes', 'vm_gallery');

  if leftovers is not null then
    raise exception 'agent_videos: po přemapování zůstaly nepovolené režimy: %', leftovers;
  end if;
end
$$;
