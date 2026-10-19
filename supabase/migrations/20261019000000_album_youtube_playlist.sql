-- YouTube playlist alba + vyplnění playlist_ids u publikace.
--
-- Proč tato migrace existuje:
--
-- 1) PLAYLIST PODLE ALBA. Na YouTube kanálu má každé album svůj playlist
--    ("Myšlenkovej Boom" = PLe8kaulECxw0). Aby appka mohla skladbu zařadit
--    rovnou při publikaci, potřebuje vědět, které album patří ke kterému
--    playlistu. Doteď se `youtube_publications.playlist_ids` vůbec nepoužíval
--    a neexistovalo mapování album -> playlist, takže se zařazení dělalo ručně
--    (a u shortů omylem i tam, kam nepatří).
--
-- 2) SHORTS DO PLAYLISTU NEPATŘÍ. Shorts mají vlastní cestu (9:16) a do
--    playlistu alba se nezařazují. Sloupec je proto jen na albu; publikace
--    Shortsu ho nedostane. Když se formát Shorts rozpozná, playlist se
--    nevyplní.
--
-- POZOR: id playlistu má tvar PL + 20-32 znaků [A-Za-z0-9_-]. Kontrola je
-- fail-closed: neplatný tvar se neuloží, aby se do API neposlal nesmysl.

alter table public.sc_albums
  add column if not exists youtube_playlist_id text;

comment on column public.sc_albums.youtube_playlist_id is
  'ID YouTube playlistu, který odpovídá tomuto albu (např. PLe8kaulECxw0). NULL = nezařazovat.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sc_albums_youtube_playlist_id_format'
  ) then
    alter table public.sc_albums
      add constraint sc_albums_youtube_playlist_id_format
      check (youtube_playlist_id is null or youtube_playlist_id ~ '^PL[A-Za-z0-9_-]{10,40}$');
  end if;
end $$;

-- Stávající playlist alba "Myšlenkovej Boom" nastavíme, když album existuje.
update public.sc_albums
   set youtube_playlist_id = 'PLe8kaulECxw0'
 where name = 'Myšlenkovej Boom'
   and youtube_playlist_id is null;
