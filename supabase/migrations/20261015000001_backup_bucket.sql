-- Bucket pro archivy: songcraft-backups.
--
-- Proč tato migrace existuje:
--
-- Export všech uživatelů má reálně přes gigabajt (15. 10. 2026: 136 objektů,
-- 1 336 MB). Edge funkce to nesplave - Deno izolát má paměťový strop, takže
-- archiv staví worker na VM a výsledek ukládá sem. Klient si ho pak stáhne
-- přes krátce platnou signed URL.
--
-- Proč je to NOVÝ bucket a ne `songcraft`:
--
-- `songcraft` má owner-prefix policy (`(storage.foldername(name))[1] =
-- auth.uid()::text`) a trigger, který kontroluje MIME typ i velikost podle
-- prvního segmentu cesty. Archiv by musel začínat UUID nějakého uživatele,
-- aby prošel - a tím by vypadal, jako by patřil jemu, což je přesně ta
-- chyba, kterou se celý ten systém snaží vyhnout. Tady je bucket soukromý a
-- úplně bez client policy: nedá se k němu dostat z aplikace vůbec, jen
-- service role z funkce songcraft-service-console po ověření služebního účtu.
--
-- POZOR: soubor se už aplikoval. Jakoukoli opravu dělat do NOVÉ migrace,
-- ne tady. Editovat aplikovaný soubor znamená, že oprava se nikdy nespustí.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'songcraft-backups', 'songcraft-backups', false, 2147483648,
  array['application/x-xz', 'application/x-zstd', 'application/gzip', 'application/octet-stream']
)
on conflict (id) do update
  set public = false,
      file_size_limit = 2147483648,
      allowed_mime_types = array[
        'application/x-xz', 'application/x-zstd', 'application/gzip', 'application/octet-stream'
      ];

-- Žádná client policy. Pro čtení archivu se používá signed URL, které zrodí
-- service role, takže bucket nemusí být přístupný ani přihlášenému účtu.
do $$
declare
  policy_row record;
  service_oids oid[];
  policy_text text;
begin
  if to_regclass('storage.objects') is null then return; end if;
  select coalesce(array_agg(oid), '{}'::oid[]) into service_oids from pg_roles where rolname = 'service_role';
  for policy_row in
    select polname as policyname, polroles, pg_get_expr(polqual, polrelid) as qual,
           pg_get_expr(polwithcheck, polrelid) as with_check
    from pg_policy where polrelid = 'storage.objects'::regclass
  loop
    policy_text := coalesce(policy_row.qual, '') || ' ' || coalesce(policy_row.with_check, '');
    if (policy_text ilike '%songcraft-backups%')
       and (policy_row.polroles is null or not (policy_row.polroles && service_oids)) then
      execute format('drop policy if exists %I on storage.objects', policy_row.policyname);
    end if;
  end loop;
end $$;

drop policy if exists "songcraft backups service role" on storage.objects;
create policy "songcraft backups service role" on storage.objects
  for all to service_role
  using (bucket_id = 'songcraft-backups')
  with check (bucket_id = 'songcraft-backups');

-- ---------------------------------------------------------------------------
-- Fail-closed: bucket musí být soukromý a nesmí mít žádnou client policy
-- ---------------------------------------------------------------------------
do $$
declare
  is_public boolean;
  leaked text;
  service_oids oid[];
begin
  if to_regclass('storage.buckets') is null then return; end if;

  select public into is_public from storage.buckets where id = 'songcraft-backups';
  if is_public is null then
    raise exception 'Bucket songcraft-backups nebyl založen.';
  end if;
  if is_public then
    raise exception 'Bucket songcraft-backups nesmí být veřejný - archiv obsahuje data všech uživatelů.';
  end if;

  select coalesce(array_agg(oid), '{}'::oid[]) into service_oids from pg_roles where rolname = 'service_role';
  select string_agg(p.polname, ', ') into leaked
  from pg_policy p
  where p.polrelid = 'storage.objects'::regclass
    and pg_get_expr(p.polqual, p.polrelid) ilike '%songcraft-backups%'
    and (p.polroles is null or not (p.polroles && service_oids));
  if leaked is not null then
    raise exception 'Bucket songcraft-backups nesmí mít žádnou client policy, nalezeno: %', leaked;
  end if;
end $$;