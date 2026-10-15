-- Uzavření díry v tabulce _backup_agent_videos_20261005.
--
-- Proč tato migrace existuje:
--
-- `_backup_agent_videos_20261005` vznikla 5. 10. 2026 ručně v SQL jako kopie
-- `agent_videos` před zásahem do renderu. Její definice se NEDOSTALA do žádné
-- migrace v repu, takže o ní repo nevědělo - a v živé DB měla:
--
--   relrowsecurity  = false          (RLS vypnuté, protože ji nikdo nezapnul)
--   anon            -> DELETE, INSERT, SELECT, TRUNCATE, UPDATE
--   authenticated   -> DELETE, INSERT, SELECT, TRUNCATE, UPDATE
--
-- `sb_publishable_...` klíč z lib/supabase.ts je ZAMÝŠLENĚ veřejný - je
-- zabalený v APK a ve veřejném webu. U všech ostatních 26 tabulek nestačí,
-- protože RLS izoluje podle auth.uid(). Tady nestačilo: `anon` znamená
-- nepřihlášený návštěvník. Kdokoli si mohl archiv rozbalit a přečíst 27
-- řádků s user_id cizích uživatelů, a dokázal je i zmazat.
--
-- Tato migrace dělá dvě věci:
--
--   1) Zapisuje definici tabulky do repa, aby o ní repo vědělo a nesrazilo se
--      to při příštím diffu schématu. Sloupce jsou 1:1 s agent_videos v době
--      vzniku - tedy BEZ cover_lead_path a short_background_path, které se do
--      agent_videos přidaly až 5. 10. odpoledne. Záměrně neopravuju a nedoplňuji
--      primary key ani FK: tabulka je mrtvá záloha a každý nový constraint je
--      další věc, která může na starých datech spadnout.
--
--   2) Zavavírá přístup. RLS zapnu, odměnu `anon` a `authenticated` všechno a
--      nechám jen service_role. Data zůstanou na místě, jen je nikdo neuvidí.
--
-- POZOR: soubor se už aplikoval. Jakoukoli opravu dělat do NOVÉ migrace,
-- ne tady. Editovat aplikovaný soubor znamená, že oprava se nikdy nespustí.

create table if not exists public._backup_agent_videos_20261005 (
  id uuid,
  user_id uuid,
  song_id uuid,
  type text,
  render_status text,
  storage_path text,
  duration_seconds integer,
  error_message text,
  created_at timestamp with time zone,
  mode text,
  backend text,
  audio_storage_path text,
  prompt_used text,
  output_path text,
  attempt_count integer,
  max_attempts integer,
  lease_expires_at timestamp with time zone,
  motion_recipe jsonb,
  motion_prompt text,
  recipe_source text,
  aspect text,
  source_video_path text,
  gallery_kind text
);

comment on table public._backup_agent_videos_20261005 is
  'Mrtvá ruční záloha agent_videos z 5. 10. 2026. Bez FK, bez PK, bez indexu - nikdo ji nepoužívá a nesmí být přístupná z klienta. Její obsah je v archivu všech uživatelů, takže ji nezálohuji.';

alter table public._backup_agent_videos_20261005 enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    perform public.songcraft_drop_client_policies('public._backup_agent_videos_20261005');
    perform public.songcraft_set_service_policy('public._backup_agent_videos_20261005');
  end if;
end $$;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if not exists (select 1 from pg_roles where rolname = role_name) then continue; end if;
    if to_regclass('public._backup_agent_videos_20261005') is not null then
      execute format('revoke all on public._backup_agent_videos_20261005 from %I', role_name);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role')
     and to_regclass('public._backup_agent_videos_20261005') is not null then
    execute 'grant select, insert, update, delete on public._backup_agent_videos_20261005 to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Fail-closed: po migraci musí být RLS zapnuté, žádná client policy nesmí
-- existovat a anon/authenticated nesmí mít žádná práva
-- ---------------------------------------------------------------------------
do $$
declare
  leaked text;
  leftover text;
  service_oids oid[];
begin
  if to_regclass('public._backup_agent_videos_20261005') is null then return; end if;

  select coalesce(array_agg(oid), '{}'::oid[]) into service_oids from pg_roles where rolname = 'service_role';

  if not (select relrowsecurity from pg_class where oid = 'public._backup_agent_videos_20261005'::regclass) then
    raise exception '_backup_agent_videos_20261005 musí mít zapnuté RLS.';
  end if;

  select string_agg(p.polname, ', ') into leaked
  from pg_policy p
  where p.polrelid = 'public._backup_agent_videos_20261005'::regclass
    and (p.polroles is null or not (p.polroles && service_oids));
  if leaked is not null then
    raise exception '_backup_agent_videos_20261005 nesmí mít žádnou client policy, nalezeno: %', leaked;
  end if;

  select string_agg(format('%s=%s', grants.grantee, grants.privileges), '; ')
  into leftover
  from (
    select t.grantee, string_agg(t.privilege_type, ',' order by t.privilege_type) as privileges
    from information_schema.role_table_grants t
    where t.table_name = '_backup_agent_videos_20261005'
      and t.table_schema = 'public'
      and t.grantee in ('anon', 'authenticated')
    group by t.grantee
  ) grants;
  if leftover is not null then
    raise exception '_backup_agent_videos_20261005: zbyla práva pro klienta (%), mají být úplně odebrána', leftover;
  end if;
end $$;