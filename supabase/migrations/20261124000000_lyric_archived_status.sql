alter table public.sc_lyrics drop constraint if exists sc_lyrics_status_check;
alter table public.sc_lyrics add constraint sc_lyrics_status_check check (status in ('draft','complete','archived'));
