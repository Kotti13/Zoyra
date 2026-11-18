-- Follow/unfollow shows up live in Followers, Friends and Profile.
alter publication supabase_realtime add table public.follows, public.dedications;
