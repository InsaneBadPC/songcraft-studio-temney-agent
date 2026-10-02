-- Doprovodna media písně: víc obrázků nebo víc videí jako zdroj pro video.
--
-- Dnešní stav: sc_songs.cover_path (jeden obrázek) a sc_songs.source_video_path
-- (jedno video). Worker bere jediný zdroj. Tato tabulka řeší to - na jednu píseň
-- jich může být libovolně moc a řídí se jejich pořadí.
--
-- Výsledné video z toho: [cover s textem] -> [media v rucnim poradi] -> [cover s textem].
-- Cover je zacatek a konec, ne polozka smycky.

create table if not exists sc_song_media (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  song_id uuid not null references sc_songs(id) on delete cascade,
  kind text not null default 'image' check (kind in ('image', 'video')),
  storage_path text not null,
  original_file_name text,
  mime_type text,
  byte_size bigint not null default 0 check (byte_size >= 0),
  sort_order integer not null default 0,
  scene_ms integer not null default 0 check (scene_ms >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table sc_song_media is
  'Doprovodna media piskne - obrazky a videa jako zdroj pro skladane video. Poradi urcuje sort_order.';
comment on column sc_song_media.scene_ms is
  'Delka sceny v ms pro video. 0 = vzit maximum, co dany soubor ma.';

create index if not exists sc_song_media_song_order_idx
  on sc_song_media (song_id, sort_order);

alter table sc_song_media enable row level security;

drop policy if exists sc_song_media_owner_all on sc_song_media;
create policy sc_song_media_owner_all on sc_song_media
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Cesta musi patrit vlastnikovi - stejne jako cover_path a source_video_path
-- (viz sc_owned_storage_path). Bez toho by si uzivatel mohl ukladat cudy
-- cizich souboru.
create or replace function sc_song_media_path_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not sc_owned_storage_path(new.user_id, new.storage_path) then
    raise exception 'sc_song_media: cesta % nepatri uzivateli %', new.storage_path, new.user_id
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists sc_song_media_guard_paths on sc_song_media;
create trigger sc_song_media_guard_paths
  before insert or update of storage_path, user_id on sc_song_media
  for each row execute function sc_song_media_path_guard();

-- updated_at pri kazde zmene, jako u ostatnich tabulek v tomto schema.
create or replace function sc_song_media_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sc_song_media_touch on sc_song_media;
create trigger sc_song_media_touch
  before update on sc_song_media
  for each row execute function sc_song_media_touch();
-- Rezim source_gallery: uzivatel vybere, z ceho skladat - z obrazku nebo
-- z videi. Bez toho by renderer vzal vsechno a nebylo poznat, co chtel.
alter table agent_videos
  add column if not exists gallery_kind text check (gallery_kind is null or gallery_kind in ('image', 'video'));

comment on column agent_videos.gallery_kind is
  'Pro mode=source_gallery: image = skladat z obrazku, video = z videi, null = vzit vse.';
