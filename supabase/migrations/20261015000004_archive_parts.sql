-- Archiv se posílá po částech a obnovu potřebuje vědět, kolik jich je.
--
-- Proč tato migrace existuje:
--
-- Bucket songcraft-backups jde přes Cloudflare, který má tvrdý limit na velikost
-- těla jednoho requestu (100 MB). První pokus poslal archiv 1,28 GB v jednom
-- POST: request visel 22 minut, nic se nezapsalo a 2jádrová VM s 954 MB RAM
-- přestala odpovídat i na SSH - nedostal se ani renderer, který na ní běží.
--
-- Worker proto posílá archiv po částech (`backup-worker.mjs`, uploadArchiveParts)
-- a čte je ze souboru po offsetu, takže se na disku nezdvojuje. Bez počtu částí
-- by obnova nevěděla, kolik částí složit - proto sloupec.
--
-- `archive_path` teď není cesta k souboru, ale základ názvu částí
-- (`<uuid>.part-0001`, `<uuid>.part-0002`, …). Bez `archive_parts` by to nebylo
-- poznat.
--
-- POZOR: soubor se už aplikoval. Jakoukoli opravu dělat do NOVÉ migrace,
-- ne tady. Editovat aplikovaný soubor znamená, že oprava se nikdy nespustí.

alter table public.sc_service_backups
  add column if not exists archive_parts integer;

comment on column public.sc_service_backups.archive_parts is
  'Počet částí archivu (uuid.part-0001 …). NULL = archiv je v jednom kusu (starší formát).';

comment on column public.sc_service_backups.archive_path is
  'Základ názvu částí archivu, ne cesta k jednomu souboru. Viz archive_parts.';

-- Hotová záloha musí vědět, co je k dispozici. Bez počtu částí by obnova
-- stáhla jen první část a vzala to za celý archiv.
alter table public.sc_service_backups drop constraint if exists sc_service_backups_archive_parts_check;
alter table public.sc_service_backups
  add constraint sc_service_backups_archive_parts_check
  check (archive_parts is null or archive_parts >= 1);

do $$
declare
  broken record;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sc_service_backups' and column_name = 'archive_parts'
  ) then
    raise exception 'sc_service_backups musí mít sloupec archive_parts.';
  end if;

  -- Záznam s hotovou zálohou a bez počtu částí by při obnově stáhl jen první
  -- část a vzal to za celý archiv.
  select id, archive_path into broken
  from public.sc_service_backups
  where status = 'done' and archive_path is not null and archive_parts is null;
  if broken is not null then
    raise exception 'Hotová záloha % nemá archive_parts a obnova by stáhla jen první část.', broken.id;
  end if;
end $$;