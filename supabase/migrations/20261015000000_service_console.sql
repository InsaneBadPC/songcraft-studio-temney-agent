-- Servisní konzole: kdo je služební účet a evidence záloh/obnov.
--
-- Proč tato migrace existuje:
--
-- Účet Temney má být služební: v aplikaci si zobrazí skrytou konzoli, kde
-- přidá uživatele a spustí zálohu všech dat všech uživatelů i její obnovu.
-- Zatím jsou všechny čtyři soukromé účty stejné — žádný nemá jiná práva.
--
-- KDO JE SLUŽEBNÍ ÚČET
--
-- Příznak NEJDE dát do auth.users.user_metadata: to si uživatel přepíše sám
-- přes klienta (supabase.auth.updateUser), takže by si služební právo udělil
-- kdekoli. Proto je tu tabulka `sc_service_accounts` veřejným schématem, ale
-- bez jediné client policy - čte ji výhradně service role z edge funkce po
-- ověření JWT. Prázdná tabulka znamená "nikdo není služební" (fail-closed),
-- stejně jako prázdný SONGCRAFT_ALLOWED_USER_IDS u _shared/access.ts.
--
-- ZÁLOHY A OBNOVY
--
-- `sc_service_backups` je jediná tabulka pro obě operace (`kind`), aby šlo
-- jednoduše zjistit, co se děje, a aby se dala úloha zrušit jedním dotazem.
-- Sloupce jsou záměrně bez owner-prefixu a bez cesty do storage: archiv
-- leží v bucketu `songcraft-backups` (viz 20261015000001) a jeho cestu
-- dostaneme jen přes service role.
--
-- POZOR: soubor se už aplikoval. Jakoukoli opravu dělat do NOVÉ migrace,
-- ne tady. Editovat aplikovaný soubor znamená, že oprava se nikdy nespustí.

-- ---------------------------------------------------------------------------
-- 1. Služební účty
-- ---------------------------------------------------------------------------
create table if not exists public.sc_service_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  label text not null check (length(btrim(label)) between 1 and 80),
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.sc_service_accounts is
  'Účty s právem servisní konzole. Bez client policy - čte je jen service role ve funkci songcraft-service-console po ověření JWT. Prázdná tabulka = nikdo není služební.';

-- ---------------------------------------------------------------------------
-- 2. Evidence záloh a obnov
-- ---------------------------------------------------------------------------
create table if not exists public.sc_service_backups (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('backup', 'restore')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed', 'canceled')),
  -- full = celý projekt; restore_existing = do účtu se stejným id (maže jeho
  -- data); restore_new = nový účet a přemapovaná user_id i cesty souborů.
  mode text not null default 'full'
    check (mode in ('full', 'restore_existing', 'restore_new')),
  source_backup_id uuid references public.sc_service_backups(id) on delete set null,
  target_user_id uuid references auth.users(id) on delete cascade,
  -- staré uuid -> nové uuid; obnova do nového účtu tu přepisuje všechna data.
  id_map jsonb not null default '{}'::jsonb,
  requested_by uuid not null references auth.users(id) on delete cascade,
  archive_path text,
  archive_bytes bigint,
  manifest jsonb not null default '{}'::jsonb,
  progress jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

comment on table public.sc_service_backups is
  'Zálohy a obnovy všech uživatelů. Backup běží na VM workeru, tady je jen evidence a průběh.';

create index if not exists sc_service_backups_open_idx
  on public.sc_service_backups (status, created_at)
  where status in ('queued', 'running');

-- ---------------------------------------------------------------------------
-- 3. RLS a práva: bez jediné client policy (service role obchází RLS)
-- ---------------------------------------------------------------------------

alter table public.sc_service_accounts enable row level security;
alter table public.sc_service_backups enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    perform public.songcraft_drop_client_policies('public.sc_service_accounts');
    perform public.songcraft_drop_client_policies('public.sc_service_backups');
    perform public.songcraft_set_service_policy('public.sc_service_accounts');
    perform public.songcraft_set_service_policy('public.sc_service_backups');
  end if;
end $$;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if not exists (select 1 from pg_roles where rolname = role_name) then continue; end if;
    execute format('revoke all on public.sc_service_accounts from %I', role_name);
    execute format('revoke all on public.sc_service_backups from %I', role_name);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.sc_service_accounts to service_role';
    execute 'grant select, insert, update, delete on public.sc_service_backups to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Obsluha účtu Temney
--
-- Zapisuje se sem jen účet, který už existuje a má e-mail temney@songcraft.test.
-- Registrace je vypnutá (supabase/config.toml enable_signup = false), takže
-- e-mail nemůže vzít nikdo jiný. Pokud účet ještě neexistuje, tabulka zůstane
-- prázdná a nikdo není služební - další účty přidá
-- scripts/provision-service-account.mjs.
-- ---------------------------------------------------------------------------
insert into public.sc_service_accounts (user_id, label)
select id, 'Temney'
from auth.users
where email = 'temney@songcraft.test'
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Fail-closed: po migraci nesmí existovat cesta, kterou by se dovnitř
--    dostal běžný účet
-- ---------------------------------------------------------------------------
do $$
declare
  leaked text;
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    select string_agg(format('%s: %s', c.relname, p.polname), ', ')
    into leaked
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_policy p on p.polrelid = c.oid
    where n.nspname = 'public'
      and c.relname in ('sc_service_accounts', 'sc_service_backups')
      and not (p.polroles && array(select oid from pg_roles where rolname = 'service_role'));
    if leaked is not null then
      raise exception 'Servisní tabulky nesmí mít žádnou client policy, nalezeno: %', leaked;
    end if;
  end if;

  select string_agg(c.relname, ', ')
  into leaked
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('sc_service_accounts', 'sc_service_backups')
    and not c.relrowsecurity;
  if leaked is not null then
    raise exception 'Na servisních tabulkách musí být zapnuté RLS, chybí u: %', leaked;
  end if;
end $$;