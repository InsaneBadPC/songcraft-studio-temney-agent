-- R2 archivy: povolit v DB cestu `r2://songcraft-studio/.../<owner_id>/...`.
--
-- `songcraft_path_allowed` je společný guard pro cover_path, storage_path i
-- video_path. Dosud povoloval jen cesty začínající `<owner_id>/`, protože
-- všechny soubory byly v Supabase Storage. Po migraci velkých/archivních
-- souborů do Cloudflare R2 musí projít i `r2://` cesta, ale pořád jen když
-- obsahuje UUID vlastníka jako celý segment. Cizí UUID, `..` ani řídicí znaky
-- zůstávají zakázané.

create or replace function public.songcraft_path_allowed(owner_id uuid, path_value text)
returns boolean
language sql
immutable
as $$
  select path_value is null
     or (owner_id is not null
         and (
           path_value like owner_id::text || '/%'
           or (
             path_value like 'r2://songcraft-studio/%'
             and path_value like '%/' || owner_id::text || '/%'
           )
         )
         and position('..' in path_value) = 0
         and length(path_value) between 1 and 1024
         and path_value !~ '[[:cntrl:]]');
$$;
