-- Notes: the song's 30-second clip (Instagram music notes).
--
--   user_notes.track may carry  clip_start  whole seconds ≥ 0 (where the clip starts; ≤ 24 h)
--                               clip_len    seconds, 1..30 (30, or the whole song when it's shorter)
--   Both are optional (older notes have neither and play from 0:00). The existing track check (object with
--   string id + title, ≤ 4 KB) already allows extra keys; this only rejects malformed clip values.
--   CASE keeps the casts from running on non-numbers (AND doesn't guarantee evaluation order).

alter table public.user_notes drop constraint if exists user_notes_track_clip;
alter table public.user_notes add constraint user_notes_track_clip check (
  track is null or jsonb_typeof(track) <> 'object' or (
    case
      when not (track ? 'clip_start') then true
      when jsonb_typeof(track -> 'clip_start') <> 'number' then false
      else (track ->> 'clip_start')::numeric >= 0
        and (track ->> 'clip_start')::numeric <= 86400
        and (track ->> 'clip_start')::numeric = trunc((track ->> 'clip_start')::numeric)
    end
    and case
      when not (track ? 'clip_len') then true
      when jsonb_typeof(track -> 'clip_len') <> 'number' then false
      else (track ->> 'clip_len')::numeric between 1 and 30
    end
  )
);
