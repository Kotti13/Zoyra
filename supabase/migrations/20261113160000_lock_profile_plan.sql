-- Users may edit their own profile, but never their plan (set only by the billing backend / service role).
revoke update on public.profiles from authenticated, anon;
grant update (username, display_name, bio, avatar_url, is_private, updated_at) on public.profiles to authenticated;
