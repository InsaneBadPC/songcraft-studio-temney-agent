-- Media store: registry binarek, rozpocty uzivatelu a jeden snapshot RPC.
--
-- Problem, ktery resi:
-- 1) Supabase Storage ma na free planu 1 GB a projekt byl tvrde omezeny
--    (402 exceed_storage_size_quota) -> nebylo se mozne prihlasit.
--    Binarka (MP3, obaly, video) proto presune do Cloudflare R2.
-- 2) Snapshot staval ~160 API requestu: 7 dotazu na tabulky + signed URL
--    na kazdy radek. Tady je to jedna funkce vracejici JSON.
-- 3) Nikdo nesmel vedet, kolik uzivatel zere. Registry + metering to zjistuje.
--
-- Migrace je CISTE ADITIVNI: nic nemaže, nic nepřepisuje, cizi data se nemeni.
-- Tabulka sc_media_objects popisuje media, ktera existuji; existujici radky
-- v sc_albums/sc_lyrics/sc_songs/sc_audio_versions/sc_song_media zustavaji
-- beze zmeny a slouzi jako zdroj pravdy.

-- ---------------------------------------------------------------------------
-- 1) Registry binarek
-- ---------------------------------------------------------------------------

create table if not exists sc_media_objects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null,
  kind text not null check (kind in ('cover', 'audio', 'video', 'media', 'export', 'backup')),
  byte_size bigint not null default 0 check (byte_size >= 0),
  content_type text,
  original_file_name text,
  sha256 text,
  -- 'active' = žije, 'purged' = smazáno (pouze deriváty), 'migrating' = právě se přesouvá
  state text not null default 'active' check (state in ('active', 'migrating', 'purged')),
  -- Derivát (MP4 render) se smaže nejdřív 7 dní po zveřejnění na YouTube.
  published_at timestamptz,
  purge_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table sc_media_objects is
  'Registry binarek (R2 i Supabase Storage). Zdroj pravdy pro rozpočet, metering a lifecycle mazani.';

create index if not exists sc_media_objects_user_kind_idx
  on sc_media_objects (user_id, kind, state);
create index if not exists sc_media_objects_purge_idx
  on sc_media_objects (purge_after) where state = 'active' and purge_after is not null;
-- Jeden soubor = jeden zaznam. Cesta je unikatni v rámci uživatele.
create unique index if not exists sc_media_objects_user_path_idx
  on sc_media_objects (user_id, storage_path);

alter table sc_media_objects enable row level security;

drop policy if exists sc_media_objects_owner_all on sc_media_objects;
create policy sc_media_objects_owner_all on sc_media_objects
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Cesta musí patřit vlastníkovi - stejně jako u sc_song_media.
create or replace function sc_media_objects_path_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.songcraft_path_allowed(new.user_id, new.storage_path) then
    raise exception 'sc_media_objects: cesta % nepatri uzivateli %', new.storage_path, new.user_id
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists sc_media_objects_guard_paths on sc_media_objects;
create trigger sc_media_objects_guard_paths
  before insert or update of storage_path, user_id on sc_media_objects
  for each row execute function sc_media_objects_path_guard();

create or replace function sc_media_objects_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists sc_media_objects_touch on sc_media_objects;
create trigger sc_media_objects_touch
  before update on sc_media_objects
  for each row execute function sc_media_objects_touch();

-- ---------------------------------------------------------------------------
-- 2) Rozpočet na uživatele (tvrdé limity před vlastními Supabase kvótami)
-- ---------------------------------------------------------------------------

create table if not exists sc_usage_budget (
  user_id uuid primary key references auth.users(id) on delete cascade,
  max_storage_bytes bigint not null default 2147483648 check (max_storage_bytes >= 0),
  max_monthly_egress_bytes bigint not null default 5368709120 check (max_monthly_egress_bytes >= 0),
  -- Když se rozpočet překročí, aplikace nesmí spadnout: tlačítka pro těžká
  -- média se zablokují, texty a metadata fungují dál.
  blocked boolean not null default false,
  updated_at timestamptz not null default now()
);

comment on table sc_usage_budget is
  'Tvrde limity uzivatele na media. Prekroceni = graceful degradace, ne padajici aplikace.';

alter table sc_usage_budget enable row level security;

drop policy if exists sc_usage_budget_owner_read on sc_usage_budget;
create policy sc_usage_budget_owner_read on sc_usage_budget
  for select to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3) Metering udalosti (egress + storage)
-- ---------------------------------------------------------------------------

create table if not exists sc_metering_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('upload', 'download', 'render', 'publish', 'purge', 'migrate')),
  byte_size bigint not null default 0 check (byte_size >= 0),
  storage_path text,
  created_at timestamptz not null default now()
);

comment on table sc_metering_events is
  'Metering bajtu: upload (storage), download (egress), render, publish, purge.';

create index if not exists sc_metering_events_user_time_idx
  on sc_metering_events (user_id, created_at desc);
create index if not exists sc_metering_events_kind_idx
  on sc_metering_events (kind, created_at desc);

alter table sc_metering_events enable row level security;

drop policy if exists sc_metering_events_owner_read on sc_metering_events;
create policy sc_metering_events_owner_read on sc_metering_events
  for select to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 4) Rozpočet a spotřeba (jedno volání, žádné podepisování)
-- ---------------------------------------------------------------------------

create or replace function public.sc_media_usage(p_user_id uuid default auth.uid())
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with usage as (
    select
      coalesce(sum(byte_size) filter (where state = 'active'), 0)::bigint as storage_bytes,
      coalesce(sum(byte_size) filter (where state = 'active' and kind in ('video', 'media')), 0)::bigint as video_bytes
    from public.sc_media_objects
    where user_id = p_user_id
  ),
  egress as (
    select coalesce(sum(byte_size), 0)::bigint as egress_bytes
    from public.sc_metering_events
    where user_id = p_user_id
      and kind = 'download'
      and created_at >= date_trunc('month', now())
  ),
  budget as (
    select coalesce(max_storage_bytes, 2147483648)::bigint as max_storage_bytes,
           coalesce(max_monthly_egress_bytes, 5368709120)::bigint as max_monthly_egress_bytes,
           coalesce(blocked, false) as blocked
    from public.sc_usage_budget
    where user_id = p_user_id
  )
  select jsonb_build_object(
    'storageBytes', usage.storage_bytes,
    'videoBytes', usage.video_bytes,
    'egressBytes', egress.egress_bytes,
    'maxStorageBytes', budget.max_storage_bytes,
    'maxMonthlyEgressBytes', budget.max_monthly_egress_bytes,
    'blocked', budget.blocked,
    'storageRatio', case when budget.max_storage_bytes > 0
      then round(usage.storage_bytes::numeric / budget.max_storage_bytes, 4)
      else 0 end,
    'egressRatio', case when budget.max_monthly_egress_bytes > 0
      then round(egress.egress_bytes::numeric / budget.max_monthly_egress_bytes, 4)
      else 0 end
  )
  from usage cross join egress cross join budget;
$$;

comment on function public.sc_media_usage(uuid) is
  'Spotreba uzivatele: storage, egress, podil rozpoctu. Bez podepisovani - 1 request.';

-- ---------------------------------------------------------------------------
-- 5) JEDEN snapshot RPC (replaces ~160 requestu na nacteni obrazovky)
-- ---------------------------------------------------------------------------
--
-- Vraci surove radky (snake_case) v JSON. Klient je namapuje stejne jako
-- predtim - zadna zmena datoveho modelu. Signed URL se NEvytvari tady:
-- obal/MP3 se podepise az kdyz ho nekdo chce otevrit (lazy).

create or replace function public.sc_studio_snapshot(p_user_id uuid default auth.uid())
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
begin
  if v_user is null then
    raise exception 'sc_studio_snapshot: chybi uzivatel' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'albums', coalesce((
      select jsonb_agg(row_to_json(t)) from (
        select * from public.sc_albums
        where user_id = v_user
        order by sort_order, name
      ) t
    ), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(row_to_json(t)) from (
        select * from public.sc_lyrics
        where user_id = v_user
        order by updated_at desc
      ) t
    ), '[]'::jsonb),
    'songs', coalesce((
      select jsonb_agg(row_to_json(t)) from (
        select * from public.sc_songs
        where user_id = v_user
        order by completed_at desc
      ) t
    ), '[]'::jsonb),
    'versions', coalesce((
      select jsonb_agg(row_to_json(t)) from (
        select * from public.sc_audio_versions
        where user_id = v_user
        order by is_final desc, is_primary desc, rating desc
      ) t
    ), '[]'::jsonb),
    'rhymeWords', coalesce((
      select jsonb_agg(row_to_json(t)) from (
        select * from public.sc_rhyme_words
        where user_id = v_user
        order by word
      ) t
    ), '[]'::jsonb),
    'stylePrompts', coalesce((
      select jsonb_agg(row_to_json(t)) from (
        select * from public.sc_style_prompts
        where user_id = v_user
        order by rating desc, updated_at desc
      ) t
    ), '[]'::jsonb),
    'mediaImages', coalesce((
      select jsonb_agg(row_to_json(t)) from (
        select song_id, storage_path from public.sc_song_media
        where user_id = v_user and kind = 'image'
        order by sort_order, created_at
      ) t
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.sc_studio_snapshot(uuid) is
  'Cely snapshot studia v jednom requestu. Bez signed URL - ta se resi lazy pri otevreni media.';

-- ---------------------------------------------------------------------------
-- 6) Seed rozpočtů pro existující uživatele
-- ---------------------------------------------------------------------------
-- Výchozí limity jsou 2 GB storage / 5 GB egress na uživatele. Supabase už
-- nic neukládá (binárka jde do R2), takže reálná spotřeba bude řádově v MB.

insert into public.sc_usage_budget (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- 7) Žádné změny v datech uživatelů.
--    Existující radky v sc_albums/sc_lyrics/sc_songs/sc_audio_versions/
--    sc_song_media se NEMENI. sc_media_objects se plni az pri migraci
--    (scripts/migrate-storage-to-r2.mjs) az po overeni SHA-256.
-- ---------------------------------------------------------------------------
