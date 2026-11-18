import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";

import {
  Button,
  Cover,
  EmptyState,
  ErrorState,
  Glass,
  Icon,
  IconButton,
  LinkText,
  Loading,
  Row,
  Screen,
  SectionHeader,
  T,
  Tap,
  Toast,
  TrackItem,
  useAsync,
} from "../components";
import {
  HeroButton,
  InfoPill,
  PersonAvatar,
  ProfileHero,
  StatStrip,
} from "../features/profile-ui";
import { formatCount } from "../lib/catalog";
import {
  loadPublicProfile,
  onProfileChange,
  timeAgo,
  type PublicProfileData,
} from "../lib/profile";
import { chatPeerParams } from "../lib/chat";
import { dmAccess, startChat, type DmAccess } from "../lib/dm";
import { friendlySocialError, useBlocks } from "../lib/social";
import { profileShareUrl, shareContent } from "../lib/share-links";
import { supabase } from "../lib/supabase";
import { useAuth } from "../state/auth";
import { usePlayerPick } from "../state/player";
import { colors } from "../theme/tokens";
import { FLASH, flash } from "../lib/flash";

function matchLine(m: NonNullable<PublicProfileData["match"]>) {
  const v = m.value;
  const head =
    v >= 0.6
      ? "Great taste match"
      : v >= 0.3
        ? "Good taste match"
        : "Different tastes";
  const things = m.sharedGenres.length ? m.sharedGenres : m.sharedArtists;
  const body = things.length
    ? `You both love ${things.join(" and ")}.`
    : "Not much overlap yet.";
  return { head, body };
}

export default function PublicProfile() {
  const { id: rawId, username: rawUsername } = useLocalSearchParams<{ id?: string; username?: string }>();
  const { user } = useAuth();
  const me = user?.id;
  // Share links can name a profile by @username (https://<share host>/u/<username>).
  const username = typeof rawUsername === "string" ? rawUsername.replace(/^@/, "").toLowerCase() : "";
  const byName = useAsync(async () => {
    if (!username || typeof rawId === "string" || !me) return null;
    const { data, error } = await supabase.from("profiles").select("id").eq("username", username).maybeSingle();
    if (error) throw new Error(error.message);
    return (data as { id: string } | null)?.id ?? null;
  }, [username, rawId, me]);
  const id = typeof rawId === "string" ? rawId : byName.data ?? "";
  const { playTrack } = usePlayerPick();
  const { blocked, unblock } = useBlocks(me);
  const [busy, setBusy] = useState<"follow" | "message" | "unblock" | null>(
    null,
  );
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(
    null,
  );
  // Block state changed elsewhere (the options sheet) wins over the hook's snapshot.
  const [blockOverride, setBlockOverride] = useState<boolean | null>(null);
  const [followDelta, setFollowDelta] = useState<{ on: boolean } | null>(null);

  const res = useAsync(
    () => (id && me ? loadPublicProfile(id, me) : Promise.resolve(null)),
    [id, me],
  );
  const d = res.data;
  const { reload } = res;
  // Whether a chat would open directly, go out as a request, need a follow first, or is blocked.
  // Re-checked after following / unfollowing and when the profile reloads.
  const [accessNonce, setAccessNonce] = useState(0);
  const access = useAsync<DmAccess | null>(
    () =>
      id && me && d
        ? dmAccess(id).catch((): DmAccess | null => null)
        : Promise.resolve(null),
    [id, me, d, accessNonce],
  );

  useEffect(() => {
    if (!note || note.error) return;
    const t = setTimeout(() => setNote(null), 3200);
    return () => clearTimeout(t);
  }, [note]);

  // Block / unblock from the options sheet: reflect it here right away.
  useEffect(
    () =>
      onProfileChange((c) => {
        if (c.id !== id) return;
        if (c.blocked !== undefined) setBlockOverride(c.blocked);
        setFollowDelta(null);
        reload();
      }),
    [id, reload],
  );

  // Pull to refresh: re-fetch the profile (DM access re-checks when it lands).
  const refresh = () => {
    setFollowDelta(null);
    return res.refresh();
  };

  if (me && id === me) return <Redirect href="/profile" />;

  const iFollow = followDelta ? followDelta.on : !!d?.iFollow;
  const iBlocked = blockOverride ?? blocked.has(id);

  const toggleFollow = async () => {
    if (!me || !d || busy) return;
    setBusy("follow");
    setNote(null);
    const next = !iFollow;
    setFollowDelta({ on: next });
    let error: unknown = null;
    try {
      const r = next
        ? await supabase
            .from("follows")
            .insert({ follower_id: me, following_id: id })
        : await supabase
            .from("follows")
            .delete()
            .eq("follower_id", me)
            .eq("following_id", id);
      error = r.error;
    } catch (e) {
      error = e;
    }
    setBusy(null);
    if (!error) flash(next ? FLASH.followed : FLASH.unfollowed);
    if (error) {
      setFollowDelta(null);
      setNote({
        text: friendlySocialError(error, "Could not update follow"),
        error: true,
      });
      return;
    }
    setNote({
      text: next
        ? `You follow ${d.person.display_name}.`
        : `You unfollowed ${d.person.display_name}.`,
    });
    setAccessNonce((n) => n + 1);
    // Following a private profile unlocks its content; refetch so playlists and taste appear.
    if (d.person.is_private || !next) {
      res.reload();
      setFollowDelta(null);
    }
  };

  const message = async () => {
    if (busy) return;
    if (!me) return setNote({ text: "Sign in to send messages.", error: true });
    // Locked: they only accept people they follow (or mutuals). Follow first, then re-check.
    if (access.data === "locked") {
      if (!iFollow) await toggleFollow();
      return;
    }
    setBusy("message");
    setNote(null);
    try {
      const { id: cid, request } = await startChat(id);
      if (request) flash("Sent as a request");
      router.push({ pathname: "/chat-pro", params: { id: cid, ...chatPeerParams(d?.person ?? { id }) } });
    } catch (e) {
      setNote({
        text: friendlySocialError(e, "Could not start a conversation"),
        error: true,
      });
      setAccessNonce((n) => n + 1);
    } finally {
      setBusy(null);
    }
  };

  const doUnblock = async () => {
    if (!d || busy) return;
    setBusy("unblock");
    try {
      if (await unblock(id, d.person.display_name)) {
        setBlockOverride(false);
        setNote({ text: `${d.person.display_name} is unblocked.` });
        res.reload();
      }
    } catch (e) {
      setNote({ text: friendlySocialError(e, "Could not unblock"), error: true });
    } finally {
      setBusy(null);
    }
  };

  const share = () => {
    if (!d) return;
    shareContent({
      url: profileShareUrl({ id, username: d.person.username }),
      title: `${d.person.display_name} on Zoyra`,
      message: `Check out ${d.person.display_name} on Zoyra`,
    }).catch(() =>
      setNote({ text: "Could not open the share menu.", error: true }),
    );
  };

  const back = <HeroButton icon="back" label="Back" href="back" />;
  const more = (
    <HeroButton
      icon="more"
      label="More"
      href={{ pathname: "/profile-more", params: { id } }}
    />
  );

  if (!id && username && me && byName.loading) {
    return (
      <Screen top={4}>
        <Loading height={240} />
      </Screen>
    );
  }

  if (!id && (!username || me)) {
    return (
      <Screen top={4}>
        <EmptyState
          icon="users"
          title={username ? `No one goes by @${username}` : "No profile selected"}
          action="Find people"
          href="/followers"
        />
      </Screen>
    );
  }

  if (!me) {
    return (
      <Screen top={4} gap={16}>
        <ProfileHero name="?" height={130} avatarSize={88} left={back} />
        <EmptyState
          icon="users"
          title="Sign in to see profiles"
          body="Following, messages and taste match need an account."
          action="Sign in"
          href="/login"
        />
      </Screen>
    );
  }

  if (res.loading && !d) {
    return (
      <Screen top={4}>
        <ProfileHero name="" height={130} avatarSize={88} left={back} />
        <Loading height={240} />
      </Screen>
    );
  }

  if (res.error || !d) {
    return (
      <Screen top={4} gap={16}>
        <ProfileHero name="?" height={130} avatarSize={88} left={back} />
        {res.error ? (
          <ErrorState message={res.error} onRetry={res.reload} />
        ) : (
          <EmptyState
            icon="users"
            title="Profile not found"
            body="This account may have been deleted."
          />
        )}
      </Screen>
    );
  }

  const p = d.person;
  const subtitle = [p.username ? `@${p.username}` : null, p.bio?.trim()]
    .filter(Boolean)
    .join(" · ");
  const followers =
    d.followers +
    (followDelta ? (followDelta.on ? 1 : 0) - (d.iFollow ? 1 : 0) : 0);
  const live = !!d.latest?.live;
  const m = d.match ? matchLine(d.match) : null;
  const pct = d.match ? Math.round(d.match.value * 100) : 0;

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: "dots", mesh: "coral" }} onRefresh={refresh}>
      <ProfileHero
        id={p.id}
        name={p.display_name}
        avatar={p.avatar_url}
        custom={d.custom}
        height={130}
        avatarSize={88}
        left={back}
        right={more}
      />

      <View style={{ gap: 6, paddingLeft: 4 }}>
        <T size={26} weight={700} tracking={-0.4} accessibilityRole="header">
          {p.display_name}
        </T>
        {subtitle ? (
          <T size={14} color={colors.textSecondary} numberOfLines={2}>
            {subtitle}
          </T>
        ) : null}
        <Row gap={8} style={{ marginTop: 6, flexWrap: "wrap" }}>
          <InfoPill
            icon="clock"
            label={`Joined ${new Date(p.created_at).getFullYear()}`}
          />
          {p.is_private ? <InfoPill icon="lock" label="Private" /> : null}
          {d.followsMe ? <InfoPill icon="users" label="Follows you" /> : null}
        </Row>
      </View>

      {iBlocked || d.blockedWith ? (
        <Glass padding={16} style={{ gap: 12 }}>
          <Row>
            <Icon name="shield" size={22} color={colors.textSecondary} />
            <T
              size={14}
              color={colors.textSecondary}
              style={{ flex: 1 }}
              lineHeight={20}
            >
              {iBlocked
                ? `You blocked ${p.display_name}. You can’t follow or message each other.`
                : "You can’t interact with this profile."}
            </T>
          </Row>
          {iBlocked ? (
            <Button
              label={busy === "unblock" ? "Unblocking…" : "Unblock"}
              variant="glass"
              height={44}
              onPress={() => void doUnblock()}
            />
          ) : null}
        </Glass>
      ) : (
        <Row gap={10}>
          <Button
            label={
              busy === "follow"
                ? "…"
                : iFollow
                  ? "Following"
                  : d.followsMe
                    ? "Follow back"
                    : "Follow"
            }
            icon={iFollow ? "check" : "plus"}
            variant={iFollow ? "glass" : "primary"}
            onPress={() => void toggleFollow()}
            style={{ flex: 1 }}
          />
          {access.data === "blocked" ? null : (
            <Button
              label={
                busy === "message"
                  ? "Opening…"
                  : access.data === "locked"
                    ? iFollow
                      ? "Messages off"
                      : "Follow to message"
                    : "Message"
              }
              icon={access.data === "locked" ? "lock" : "mail"}
              variant={
                access.data === "locked" && iFollow ? "disabled" : "glass"
              }
              onPress={
                access.data === "locked" && iFollow
                  ? undefined
                  : () => void message()
              }
              style={{ flex: 1 }}
            />
          )}
          <IconButton
            icon="share"
            label="Share profile"
            size={48}
            iconSize={22}
            bg={colors.iconGhost}
            onPress={share}
          />
        </Row>
      )}

      {note ? (
        <View accessibilityLiveRegion="polite">
          <Toast
            icon={note.error ? "info" : "check"}
            iconColor={note.error ? colors.error : colors.success}
            message={note.text}
          />
        </View>
      ) : null}

      <StatStrip
        items={[
          { value: formatCount(Math.max(0, followers)), label: "Followers" },
          { value: formatCount(d.following), label: "Following" },
          {
            value: d.visible ? formatCount(d.playlistCount) : "–",
            label: "Playlists",
          },
        ]}
      />

      {!d.visible ? (
        d.blockedWith || iBlocked ? null : (
          <EmptyState
            icon="users"
            title="This profile is private"
            body={`Follow ${p.display_name} to see their playlists, listening and taste.`}
          />
        )
      ) : (
        <>
          {/* Taste match (needs both of you to have listening history you can see) */}
          {d.custom.showcase.taste ? (
            <Glass padding={16}>
              {d.match && m ? (
                <Row gap={16}>
                  <View
                    style={{
                      width: 72,
                      height: 72,
                      borderRadius: 36,
                      borderWidth: 7,
                      borderColor: colors.accent,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <T size={18} weight={700}>{`${pct}%`}</T>
                  </View>
                  <View style={{ flex: 1, gap: 4 }}>
                    <T size={16} weight={700}>
                      {m.head}
                    </T>
                    <T size={13} color={colors.textSecondary}>
                      {m.body}
                    </T>
                    <LinkText
                      label="Compare in detail"
                      size={13}
                      href={{
                        pathname: "/taste-compare",
                        params: { user: id },
                      }}
                    />
                  </View>
                </Row>
              ) : (
                <Row gap={16}>
                  <Icon name="users" size={28} color={colors.accentLight} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <T size={15} weight={600}>
                      Taste match
                    </T>
                    <T size={13} color={colors.textSecondary} lineHeight={18}>
                      {iFollow
                        ? "Not enough listening yet to compare, or they keep their listening activity private."
                        : `Follow ${p.display_name} to compare your taste.`}
                    </T>
                  </View>
                </Row>
              )}
            </Glass>
          ) : null}

          {/* Pinned songs */}
          {d.custom.showcase.pinned && d.custom.pinned_tracks.length ? (
            <>
              <SectionHeader title="Pinned songs" />
              <Glass padding={4} style={{ paddingHorizontal: 12 }}>
                {d.custom.pinned_tracks.map((t, i, list) => (
                  <View
                    key={t.id}
                    style={
                      i > 0
                        ? { borderTopWidth: 1, borderTopColor: colors.divider }
                        : undefined
                    }
                  >
                    <TrackItem
                      track={t}
                      list={list}
                      context={`${p.display_name}'s pinned songs`}
                      showDuration={false}
                      artRadius={22}
                    />
                  </View>
                ))}
              </Glass>
            </>
          ) : null}

          {/* Listening now / recently */}
          {d.latest ? (
            <Glass padding={16}>
              <Row gap={14}>
                <Cover
                  artwork={d.latest.track.artwork}
                  id={d.latest.track.id}
                  size={56}
                  radius={26}
                />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <T
                    size={12}
                    weight={700}
                    tracking={0.4}
                    color={live ? colors.success : colors.textSecondary}
                  >
                    {live
                      ? "LISTENING NOW"
                      : `LISTENED ${timeAgo(d.latest.played_at).toUpperCase()}`}
                  </T>
                  <T size={15} weight={700} numberOfLines={1}>
                    {d.latest.track.title}
                  </T>
                  <T size={13} color={colors.textSecondary} numberOfLines={1}>
                    {d.latest.track.artist.name}
                  </T>
                </View>
                <IconButton
                  icon="play"
                  label={`Play ${d.latest.track.title}`}
                  bg={colors.chipGhost}
                  filled
                  onPress={() =>
                    d.latest &&
                    playTrack(d.latest.track, `${p.display_name}'s listening`)
                  }
                />
              </Row>
            </Glass>
          ) : null}
        </>
      )}

      {/* Mutual friends */}
      {d.mutual.length ? (
        <>
          <SectionHeader title="Mutual friends" />
          <Row gap={0}>
            {d.mutual.slice(0, 4).map((f, i) => (
              <Tap
                key={f.id}
                accessibilityLabel={f.display_name}
                onPress={() =>
                  router.push({
                    pathname: "/public-profile",
                    params: { id: f.id },
                  })
                }
                style={{
                  marginLeft: i ? -10 : 0,
                  borderRadius: 22,
                  borderWidth: 2,
                  borderColor: colors.bg,
                }}
              >
                <PersonAvatar
                  id={f.id}
                  name={f.display_name}
                  uri={f.avatar_url}
                  preset={f.avatar_art}
                  size={40}
                />
              </Tap>
            ))}
            <T
              size={13}
              color={colors.textSecondary}
              style={{ marginLeft: 12, flex: 1 }}
              numberOfLines={2}
            >
              {d.mutual
                .slice(0, 2)
                .map((f) => f.display_name.split(" ")[0])
                .join(", ") +
                (d.mutualCount > 2
                  ? ` and ${d.mutualCount - 2} ${d.mutualCount - 2 === 1 ? "other" : "others"}`
                  : "")}
            </T>
          </Row>
        </>
      ) : null}

      {/* Public playlists */}
      {d.visible ? (
        <>
          <SectionHeader
            title="Public playlists"
            action={
              d.playlistCount > d.playlists.length || d.playlists.length > 3
                ? "See all"
                : undefined
            }
            href={{ pathname: "/profile-playlists", params: { id } }}
          />
          {d.playlists.length ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginHorizontal: -16 }}
              contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}
            >
              {d.playlists.map((pl) => (
                <Tap
                  key={pl.id}
                  accessibilityLabel={`${pl.title}, ${pl.track_count} songs`}
                  onPress={() =>
                    router.push({
                      pathname: "/playlist",
                      params: { id: pl.id },
                    })
                  }
                  style={{ width: 120, gap: 8 }}
                >
                  <Cover uri={pl.cover_url} id={pl.id} size={120} radius={32} />
                  <T size={14} weight={600} numberOfLines={1}>
                    {pl.title}
                  </T>
                </Tap>
              ))}
            </ScrollView>
          ) : (
            <T size={14} color={colors.textSecondary}>
              No public playlists yet.
            </T>
          )}
        </>
      ) : null}
    </Screen>
  );
}
