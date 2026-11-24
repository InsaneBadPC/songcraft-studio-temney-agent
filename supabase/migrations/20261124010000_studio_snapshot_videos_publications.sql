-- Snapshot studia rozšířený o videa (agent_videos) a publikace
-- (youtube_publications). Starší migrace se nemění - funkci jen nahradíme
-- verzí se stejnými parametry, návratovou hodnotou a bezpečnostními atributy.

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
    ), '[]'::jsonb),
    'videos', coalesce((
      select jsonb_agg(row_to_json(t)) from (
        select id, user_id, song_id, aspect, render_status, type, mode, created_at
        from public.agent_videos
        where user_id = v_user
        order by created_at desc
      ) t
    ), '[]'::jsonb),
    'publications', coalesce((
      select jsonb_agg(row_to_json(t)) from (
        select id, user_id, video_id, song_id, youtube_video_id, status, title, tags, published_at, privacy_status
        from public.youtube_publications
        where user_id = v_user
        order by published_at desc nulls last
      ) t
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.sc_studio_snapshot(uuid) is
  'Cely snapshot studia v jednom requestu. Bez signed URL - ta se resi lazy pri otevreni media.';
