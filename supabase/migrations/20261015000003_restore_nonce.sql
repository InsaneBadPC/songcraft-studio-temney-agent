-- Potvrzovací nonce pro obnovu dat.
--
-- Proč tato migrace existuje:
--
-- Obnova do existujícího účtu (`restore_existing`) MAŽE data toho účtu a
-- pak je naplní ze zálohy. To je nevratná operace nad cizími daty, takže
-- nesmí stačit jen to, že služební účet je přihlášený.
--
-- agent_ops by tady seděl (pending_confirmation + nonce_hash), ale tenhle
-- tok patří člověku v konzoli, ne agentovi, a agent-confirm umí potvrzovat
-- jen akce z vlastního allowlistu. Proto si úloha v sc_service_backups nese
-- vlastní hash nonce, stejným vzorem jako agent-confirm:
--
--   prepare_restore  vygeneruje nonce, uloží SHA-256, vrátí nonce jednou
--   confirm_restore  operátor ho vloží zpátky; porovnání je v konstantním čase
--
-- U `full` (vytvoření zálohy) se nonce nepoužije - záloha nic nemaže. Tady
-- jsou sloupce nullable právě kvůli tomu.
--
-- POZOR: soubor se už aplikoval. Jakoukoli opravu dělat do NOVÉ migrace,
-- ne tady. Editovat aplikovaný soubor znamená, že oprava se nikdy nespustí.

alter table public.sc_service_backups
  add column if not exists confirm_nonce_hash text,
  add column if not exists confirm_expires_at timestamptz;

comment on column public.sc_service_backups.confirm_nonce_hash is
  'SHA-256 nonce pro potvrzení obnovy. Nikdy se neukládá samotný token.';

comment on column public.sc_service_backups.confirm_expires_at is
  'Kdy potvrzovací nonce vyprší. NULL = potvrzení není potřeba (kind=backup).';

-- awaiting_confirmation: úloha čeká na potvrzovací nonce. Worker si ji vůbec
-- nevšimne, dokud ji songcraft-service-console nepřepne na queued.
alter table public.sc_service_backups drop constraint if exists sc_service_backups_status_check;
alter table public.sc_service_backups
  add constraint sc_service_backups_status_check
  check (status in ('queued', 'awaiting_confirmation', 'running', 'done', 'failed', 'canceled'));

-- Obnova do existujícího účtu maže jeho data, takže bez cíle to nesmí projít.
alter table public.sc_service_backups drop constraint if exists sc_service_backups_restore_target_check;
alter table public.sc_service_backups
  add constraint sc_service_backups_restore_target_check
  check (kind <> 'restore' or target_user_id is not null);

-- Fail-closed: po migraci musí být sloupce, RLS i nulové client policy.
do $$
declare
  leaked text;
  allowed text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sc_service_backups' and column_name = 'confirm_nonce_hash'
  ) then
    raise exception 'sc_service_backups musí mít sloupec confirm_nonce_hash.';
  end if;

  -- CHECK musí opravdu znát awaiting_confirmation, jinak prepare_restore spadne
  -- na porušení omezení a konzola bude mlčet chybu.
  select pg_get_constraintdef(oid) into allowed
  from pg_constraint
  where conname = 'sc_service_backups_status_check'
    and conrelid = 'public.sc_service_backups'::regclass;
  if allowed is null or allowed not like '%awaiting_confirmation%' then
    raise exception 'CHECK stavu v sc_service_backups nezná awaiting_confirmation.';
  end if;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    select string_agg(p.polname, ', ') into leaked
    from pg_policy p
    where p.polrelid = 'public.sc_service_backups'::regclass
      and (p.polroles is null or not (p.polroles && array(select oid from pg_roles where rolname = 'service_role')));
    if leaked is not null then
      raise exception 'sc_service_backups nesmí mít žádnou client policy, nalezeno: %', leaked;
    end if;
  end if;
end $$;