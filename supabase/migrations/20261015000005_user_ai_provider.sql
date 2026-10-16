-- Vlastní AI poskytovatel a API klíč uživatele.
--
-- Proč tato migrace existuje:
--
-- Dnes volají čtyři edge funkce (`songcraft-copywriter`, `songcraft-rhymes`,
-- `songcraft-studio-assistant`, `agent-orchestrator`) jen jeden poskytovatel -
-- Gemini přes serverový GOOGLE_AI_STUDIO_KEY. Účet Temney tak jede na klíč
-- projektu a ostatní účty nemají jakoukoli možnost se k AI dostat jinak.
--
-- Zadání: účet Temney zůstává beze změny (sdílené serverové klíče), ostatní si
-- vyberou známý free poskytovatel, zadají VLASTNÍ API klíč a nechají si načíst
-- jeho free modely.
--
-- KLÍČ PATRÍ DO DATABÁZE, NE DO KLIENTA
--
-- `api_key` je v této tabulce jako v `youtube_credentials` - service-only, bez
-- jediné client policy. Klient ho nikdy nedostane: funkce vrací jen příznak
-- `hasKey` a poslední čtyři znaky pro rozpoznání. Bez toho by klíč šel přes
-- síť do telefonu a dál do záloh zařízení, kde by o něm nikdo nevěděl.
--
-- Stejně jako u `youtube_credentials` je klíč v DB v čitelném tvaru. To je
-- vzor, který tenhle projekt používá; změna na šifrování by znamenala nový
-- tajný klíč v prostředí, který by se musel spravovat na každé nasazení.
--
-- POZOR: soubor se už aplikoval. Jakoukoli opravu dělat do NOVÉ migrace,
-- ne tady. Editovat aplikovaný soubor znamená, že oprava se nikdy nespustí.

create table if not exists public.sc_user_ai_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- provider_id musí sedět s katalogem v supabase/functions/_shared/llm-providers.ts.
  provider text not null check (length(btrim(provider)) between 1 and 40),
  model text check (model is null or length(btrim(model)) between 1 and 160),
  api_key text not null check (length(api_key) between 8 and 400),
  -- poslední čtyři znaky, aby uživatel poznal, který klíč má uložený
  key_hint text not null check (length(key_hint) between 3 and 8),
  -- NULL = ještě nikdy neověřen proti API poskytovatele
  key_verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.sc_user_ai_settings is
  'Vlastní AI poskytovatel a API klíč uživatele. Service-only: klíč se nikdy nevrací do klienta, funkce vrací jen hasKey a keyHint.';
comment on column public.sc_user_ai_settings.api_key is
  'API klíč uživatele v čitelném tvaru, stejně jako youtube_credentials.refresh_token. Nepropírá se do klienta ani do logu.';
comment on column public.sc_user_ai_settings.key_hint is
  'Poslední čtyři znaky klíče. Jediné, co se o klíči klient dozví.';

create index if not exists sc_user_ai_settings_provider_idx
  on public.sc_user_ai_settings (provider);

-- ---------------------------------------------------------------------------
-- RLS a práva: bez jediné client policy (service role obchází RLS)
-- ---------------------------------------------------------------------------

alter table public.sc_user_ai_settings enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    perform public.songcraft_drop_client_policies('public.sc_user_ai_settings');
    perform public.songcraft_set_service_policy('public.sc_user_ai_settings');
  end if;
end $$;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if not exists (select 1 from pg_roles where rolname = role_name) then continue; end if;
    execute format('revoke all on public.sc_user_ai_settings from %I', role_name);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.sc_user_ai_settings to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Fail-closed: klíč uživatele nesmí být čitelný z klienta
-- ---------------------------------------------------------------------------
do $$
declare
  leaked text;
  leftover text;
  service_oids oid[];
begin
  if to_regclass('public.sc_user_ai_settings') is null then return; end if;

  select coalesce(array_agg(oid), '{}'::oid[]) into service_oids from pg_roles where rolname = 'service_role';

  if not (select relrowsecurity from pg_class where oid = 'public.sc_user_ai_settings'::regclass) then
    raise exception 'sc_user_ai_settings musí mít zapnuté RLS.';
  end if;

  select string_agg(p.polname, ', ') into leaked
  from pg_policy p
  where p.polrelid = 'public.sc_user_ai_settings'::regclass
    and (p.polroles is null or not (p.polroles && service_oids));
  if leaked is not null then
    raise exception 'sc_user_ai_settings nesmí mít žádnou client policy, nalezeno: %', leaked;
  end if;

  select string_agg(format('%s=%s', grants.grantee, grants.privileges), '; ') into leftover
  from (
    select t.grantee, string_agg(t.privilege_type, ',' order by t.privilege_type) as privileges
    from information_schema.role_table_grants t
    where t.table_name = 'sc_user_ai_settings'
      and t.table_schema = 'public'
      and t.grantee in ('anon', 'authenticated')
    group by t.grantee
  ) grants;
  if leftover is not null then
    raise exception 'sc_user_ai_settings: zbyla práva pro klienta (%), klíč by byl čitelný z telefonu', leftover;
  end if;
end $$;