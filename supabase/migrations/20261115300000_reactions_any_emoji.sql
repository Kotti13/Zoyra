-- Reactions with any emoji.
--
-- 20261114180000_chat_pro limited message_reactions.emoji to a fixed set of 10. The app now has a full emoji
-- picker, so the fixed list is replaced by a sanity check (mirrored client-side by isValidReactionEmoji in
-- src/lib/emoji.ts):
--   * 1–16 code points (covers ZWJ families, tag flags and two-tone couples), not blank
--   * no ASCII at all once keycap sequences (1️⃣ #️⃣ *️⃣ = [0-9#*] + optional U+FE0F + U+20E3) are removed,
--     so no letters, digits, whitespace, punctuation or control characters
-- Existing rows (all from the old set) satisfy the new rule.

do $$
declare
  c record;
begin
  -- The original check was inline (auto-named message_reactions_emoji_check); drop any check on the column.
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.message_reactions'::regclass
      and con.contype = 'c'
      and att.attname = 'emoji'
  loop
    execute format('alter table public.message_reactions drop constraint %I', c.conname);
  end loop;
end
$$;

alter table public.message_reactions
  add constraint message_reactions_emoji_check check (
    char_length(emoji) between 1 and 16
    and btrim(emoji) <> ''
    and regexp_replace(emoji, '[0-9#*]️?⃣', '', 'g') !~ '[\x01-\x7F]'
  );
