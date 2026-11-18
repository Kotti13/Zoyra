# Zoyra end-to-end encryption (E2EE)

Code: `src/lib/e2ee/` (client) and `supabase/migrations/20261115250000_e2ee.sql` (server; changed by `20261115280000_security_hardening.sql` and `20261115310000_e2ee_auto_keys.sql`).
Self-test: `node --no-warnings scripts/e2ee-selftest.mjs` (it loads `crypto.ts` itself).

## Libraries

All of them are pure JavaScript, MIT-licensed and audited. There is no GPL code, so libsignal is not used.

| Purpose | Library |
|---|---|
| X25519 (encryption), Ed25519 (signatures) | `@noble/curves` |
| XChaCha20-Poly1305 | `@noble/ciphers` |
| HKDF-SHA256, SHA-256/512, scrypt | `@noble/hashes` |
| CSPRNG | `expo-crypto` `getRandomValues`, installed as `globalThis.crypto.getRandomValues` by `random.ts`. It uses `SecRandomCopyBytes` on iOS and `java.security.SecureRandom` on Android. On web it uses the browser's Web Crypto. |
| Private keys at rest | `expo-secure-store` (Keychain `WHEN_UNLOCKED_THIS_DEVICE_ONLY` / Android Keystore) |

`expo-secure-store` is a native module, so it needs a new development build. It does not work in Expo Go.

## Keys

- **Account key** (Ed25519, one per user). It signs each device's public keys. Its public half goes in `e2ee_accounts`. Its private half exists only on the user's devices and inside the optional PIN backup.
- **Device keys** (one set per install). Each install has an X25519 key pair for decryption and an Ed25519 key pair for signing messages. They are published in `e2ee_devices` together with `account_sig = Ed25519_account(frame("zoyra-e2ee-device-v1", user_id, device_id, enc_pub, sign_pub))`. Clients check this signature against the contact's account key and skip any device whose signature fails.
- **Keyring**. These are old device decryption keys: restored from the backup, or replaced by a rotation. They are kept so that history stays readable.

`frame(...)` is a length-prefixed concatenation. Each field is written as a u32 length followed by its bytes, so two different field lists can never encode to the same bytes.

## Message format (version 1)

For each message:

1. `content_key = random(32)`, `nonce = random(24)`.
2. `ciphertext = XChaCha20-Poly1305(content_key, nonce, aad = frame("zoyra-e2ee-msg", 1, conversation_id, message_id, sender_device_id)).encrypt(JSON(payload))`
   `payload = { body?, track?, meta? }`. Everything the user typed or picked goes in here. That includes poll question and options, lyric, playlist, location, and for voice notes and photos `meta.media = { path, key, mime, size, … }`.
3. One ephemeral X25519 key `eph` is made per message. For every active device `D` of every member (including the sender's own devices):
   `shared = X25519(eph, D.enc_pub)`
   `wrap_key = HKDF-SHA256(ikm = shared, salt = eph_pub‖D.enc_pub, info = frame("zoyra-e2ee-wrap-v1", message_id, D.device_id))`
   `wrapped = XChaCha20-Poly1305(wrap_key, random(24), aad = frame("zoyra-e2ee-wrap-aad", message_id, D.device_id)).encrypt(content_key)`.
   The result is stored as one row in `message_keys` (`device_id, wrapped_key, eph_pub, nonce`).
4. `signature = Ed25519_senderDevice(SHA-256(frame("zoyra-e2ee-sig-v1", 1, cid, mid, sender_device_id, nonce, ciphertext, SHA-256(frame("zoyra-e2ee-commit-v1", content_key)))))`.

**Why the signature covers a key commitment instead of the list of wrapped keys:** RLS lets each device read only its own `message_keys` row. A recipient therefore could not recompute a hash over the whole list. Committing to the content key gives the same protection. If the server swaps in an envelope that wraps a different key, the signature fails. This is covered by the self-test.

**Receive:**

1. Fetch my envelope.
2. Unwrap the content key.
3. Check that the sender device belongs to `sender_id` and that its account signature verifies (TOFU, see below).
4. Verify the signature.
5. Decrypt.

The result is either the payload or `{ error }`.

**Edits** (`encryptEdit`, `editEncryptedMessage`) create a new content key, ciphertext, envelopes and signature for the same message id. The server replaces the old ones (`edit_e2ee_message`, sender only, text only, 15 minutes).

**Plaintext columns:** e2ee rows have `body = ''` and `track = null`. `meta` contains only `{"e2ee": 1}`, plus `edited_at` after an edit. The check constraint `messages_e2ee_shape` enforces this. `kind`, the sender, the time and `reply_to` stay visible to the server. The server needs `kind` for its rules (song-share limits, poll votes, call logs).

## Files (voice notes, photos)

`encryptFile(bytes)` encrypts with a random 32-byte file key, using XChaCha20-Poly1305 in 64 KiB chunks:

- Layout: `ZEF1 | u32 chunk | 16-byte base nonce | chunks`.
- Each chunk's nonce is the base nonce followed by its u64 index.
- The AAD marks the last chunk, so truncating the file or reordering chunks is detected.

Upload the encrypted bytes to `chat-media` as `application/octet-stream`. The storage path and the file key go inside the encrypted payload.

## Groups

Groups use the same fan-out to every active device of every member (64 members at most, 10 active devices each, 640 envelopes per message).

When the membership changes, new messages are simply encrypted for the new device list. New members never get keys for older messages, and the server also hides history from before they joined. Members who were removed get no keys for later messages.

## Keys without a PIN (WhatsApp-style)

`initE2EE(userId)` runs after sign-in and never shows a screen:

- **Account has no E2EE yet** → account key + device key are created silently (`e2ee_setup` without backup arguments).
- **Account has keys on the server, this phone has none** (new phone, reinstall):
  - no backup → a new identity is created silently (`e2ee_setup(p_reset => true)`): every old device is revoked, contacts see "security code changed" (TOFU), messages that only the old keys could open stay unreadable here;
  - a backup exists → status `needs_restore` (`restoreReason: 'backup'`). Nothing is blocked. The Messages inbox shows a dismissible card (`RestoreHistoryCard`): **Restore** → `/e2ee-restore`, **Skip** → `skipRestore()` (new identity as above). If the user sends before deciding, the send asks once "Restore your chat history first?" (Restore / Continue without / Cancel); Continue without = `skipRestore()` and the send goes ahead.
- **This phone's keys were replaced on another phone** (the server account key changed) → old keys go to the keyring, status `needs_restore` (`'backup'` or `'replaced'`). No silent reset here: it would revoke the other phone, which would then revoke this one. The inbox card offers Restore (if a backup exists) or **Use here**.
- A reset needs a sign-in within the last 10 minutes (`auth_is_recent`). A new phone resets right after login, so this passes. Otherwise the status is `needs_reauth` and the card / send opens `/e2ee-setup?mode=reauth` (password confirm, then `skipRestore()`). Resets are limited to one per 10 minutes (`e2ee_reset_cooldown`, anti-loop between two phones) and send the "keys were reset on a new device" notification.

## PIN backup (optional, off by default)

Settings → Privacy → **Chat backup** (`/e2ee-setup`) turns it on (`setupBackupPin(pin)`: encrypts the current account key + every device key this phone holds and creates the row through `store_key_backup` with no current verifier), changes the PIN (`changePin`) or turns it off (`turnOffBackup()` → `delete_key_backup`, which needs the PIN verifier kept on this phone or a recent sign-in).

The user sets a 6-digit PIN. The PIN goes through `scrypt(N=2^15, r=8, p=1, 32 MiB)` with a random 16-byte salt, and HKDF then splits the result into two keys:

- `backup_key` encrypts the backup blob `{account_sign_priv, keys:[{device_id, enc_priv}]}` with XChaCha20-Poly1305 (AAD contains the user id).
- `verifier` is stored on the server.

The server never gets the PIN or `backup_key`. The table `e2ee_key_backups` has no client access at all. `begin_backup_restore(verifier)` returns the blob only when the verifier matches. Wrong tries are counted, and the count is committed because the RPC returns a status instead of raising an error. After 10 wrong tries the backup is locked for 1 h. The lockout doubles each time, up to 24 h. `store_key_backup`, used for PIN changes and new device keys, also requires the current verifier and an expected version (optimistic locking).

**Honest limit:** the attempt limit protects against anyone who only has the user's session (a stolen phone or a phished password). Anyone holding the database (an operator, or a dump) has the salt and the verifier and can try all 10^6 PINs offline. With this scrypt cost that takes about a day on one core, and less with more hardware. Real protection against a malicious server would need an HSM or enclave-backed key service, as Signal's SVR and WhatsApp's HSM vault do. Raising the scrypt cost or allowing longer PINs both help. The parameters are stored with each backup, so they can be raised later without breaking existing backups.

**Forgot PIN** on `/e2ee-restore` calls `skipRestore()` (no new PIN needed):

- A new account key is created and every old device is revoked.
- The old backup is deleted (a new one can be turned on in Settings).
- Old messages stay unreadable on phones that don't already hold the old keys.
- Contacts see "security code changed".

## Trust

Trust is TOFU: on first contact, each contact's `account_sign_pub` is remembered (`trust.ts`, stored in AsyncStorage, public data only). If it changes, a "security code changed" notice is recorded (`getIdentityChanges`, `subscribeIdentityChanges`). The safety number (`getSafetyNumber`) has 60 digits:

- Each user contributes 30 digits: 5200 rounds of SHA-512 over that user's account key and user id, cut into 6 groups of 5 digits.
- The two halves are ordered by user id, so both phones show the same number.

`/e2ee-verify` shows the number and a QR code (`zoyra-sn:1:<uidA>:<uidB>:<digits>`).

Devices that were verified once are remembered. Messages from a device that a contact later replaced through a key reset therefore still verify. A device we never verified, signed by an account key we no longer accept, gives `untrusted_device`.

## What this scheme does not provide

- **No forward secrecy and no post-compromise security.** There is no double ratchet. Anyone who obtains a device's X25519 private key can decrypt every stored message that was wrapped for that device. Use `rotateDeviceKeys()` to limit exposure going forward. Old keys stay in the keyring and the backup so that history remains readable, which is a deliberate trade-off.
- **Metadata stays visible to the server:** who talks to whom, when, message kind, reply links, reactions, poll votes (option index), pins, read receipts and approximate size.
- **Server search can't see e2ee text.** `searchDecrypted()` searches the payloads this phone has already decrypted (the cache).
- **"Send later" scheduled messages and server system messages stay plaintext.** The server system messages are call log, Blend and song swap; they contain no text the user typed.
- **No protection from a malicious client** on the other end, or from screenshots.
- **Rollback of an edit is possible.** A malicious server could serve an older, validly signed version of an edited message.
- **Notification previews trust the server-supplied sender keys on iOS.** The Notification Service Extension checks the sender device certificate and the message signature, but it has no access to this phone's TOFU book, so a server that swapped a contact's account key could show a forged *preview* (never a forged chat message: the app verifies with TOFU). Android previews are decrypted by the app itself with the full TOFU check.
- **Text with a song** sent as kind `text` is not caught by the server's song-share rule (track is encrypted). Clients send song shares as kind `track`.

## App integration (chat screens)

Glue: `src/lib/chat-e2ee.ts`, `src/lib/chat.ts`, `src/lib/e2ee-boot.ts`, `src/lib/e2ee-notify.ts`, `src/lib/e2ee-chat-ui.tsx`.

- **Boot.** The root AuthGate calls `useE2EEBootstrap` → `initE2EE(user.id)` after sign-in (past 2FA); keys are created silently (see "Keys without a PIN"). Nothing is routed from there and nothing is blocked. Once ready, the push token is re-registered with `p_device_id` (this install's E2EE device). Sign-out clears E2EE memory (`resetE2EEMemory`); keys stay in the keychain under the user id.
- **Chat notice.** `/chat-pro` and `/group-chat` show a system row at the top: "Messages are end-to-end encrypted. No one outside of this chat, not even Zoyra, can read them." (`E2EEChatNotice`, tap → `/e2ee-verify` in 1:1 chats).
- **Sending.** Every send goes through `sendMessage()` → `sendSecure()`. It encrypts when every member has an `e2ee_accounts` row. Plaintext is used **only** when some member never set up E2EE (legacy client); such rows carry `meta.e2ee_off = true` and show "Not end-to-end encrypted". If this phone has seen a member's keys before (TOFU book) and the server now says they have none, the send is refused (no silent downgrade). Sends await `initE2EE` (silent) when keys aren't loaded yet. Only an undecided restore offer asks once (see above); `E2EESetupRequired` is thrown when the user picks Restore / cancels / needs a password confirm, and `routeIfSetupRequired` opens that screen (or just stops). Optimistic bubbles use the real message id (`newMessageId()`). Covered: composer text, replies, edits (`editChatMessage` → `edit_e2ee_message`), voice notes and photos (`uploadMediaForMessage`: `encryptFile` before upload, `meta.media = {path, key, mime, size, duration_ms | width, height}`), polls, jams, live invites, songs / playlists / lyric cards (attach sheet), forwards, dedication → chat copy, share-sheet song shares, notification inline / quick replies, call decline quick replies.
- **Receiving.** All message selects use `MSG_SELECT` (`MSG_COLS` + `E2EE_MSG_COLS`) and `decryptChatRows()` (page + every realtime INSERT / UPDATE). Failed rows render "Message unavailable on this device" (tap explains why). Media display decrypts into `Paths.cache/zoyra-e2ee-media/` (cleared on sign-out). "Security code changed" notices are local system rows linking to `/e2ee-verify`. The inbox decrypts the last message of encrypted threads; search merges `searchDecrypted()` with server results.

## Notification previews

The server only stores ciphertext, so `message_preview()` says "Sent you a message" and the phone fills in the text when the user shows message text in alerts (`msg_preview`):

- **Android.** `supabase/functions/push` sends E2EE chat pushes **data-only** (high priority) with the presentation it would have used: `data += { zoyra_msg: '1', msg_title, msg_fallback, channel_id, category_id?, group?, count }` (no `title` / `body` keys inside data, so expo-notifications never presents it itself). The background notification task (`ZOYRA_CALL_TASK`, `src/lib/native-call.ts`; it runs in the foreground, background and killed states) passes it to `handleE2EEMessagePush` (`src/lib/e2ee-notify.ts`), which runs `decryptNotificationPreview` and posts a local notification on the same channel, with the same chat category (Reply / quick replies / Mark read / Mute / Like) and identifier = the per-chat group key. Failure → `msg_fallback`.
- **iOS.** A Notification Service Extension (`plugins/withZoyraNSE.js`, Swift in `plugins/zoyra-nse/`). The push function sends one push per token with `mutableContent: true`; tokens registered with an active E2EE `device_id` also get `data.zx`: message ciphertext / nonce / signature / kind / ids, the sender device's `sign_pub`, `enc_pub`, `account_sig`, the sender's `account_sign_pub`, and **this device's envelope** (`w`, `e`, `n`, `d`). If the payload would exceed ~3.5 KB (APNs limit 4 KB) `zx` is dropped and the generic text stays. The NSE re-implements the receive path natively: CryptoKit X25519 + HKDF-SHA256 + Ed25519 verify + SHA-256, and XChaCha20-Poly1305 = HChaCha20 subkey + CryptoKit ChaChaPoly (nonce `0⁴ ‖ nonce[16..24]`). Test: `node --no-warnings scripts/nse-selftest.mjs` (draft-irtf-cfrg-xchacha-03 vectors, noble cross-checks, real sealed messages incl. tamper cases; compiles the Swift with `swiftc` on macOS).
- **Key for the NSE.** `keystore.ts` writes a second keychain item with only this device's X25519 key: service `zoyra.e2ee.nse:no-auth`, account `zoyra.e2ee.nse.<device_id>`, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` (locked-phone notifications; never in backups). The app and the NSE list `$(AppIdentifierPrefix)com.zoyra.app.shared` **first** in `keychain-access-groups`, so it is the default group for items written without an access group (no team id needed in JS). Existing installs get the item on the next key load (`ensureNseKey`). App group `group.com.zoyra.app` is added to both targets.

## Server pieces another migration must not drop

- `message_preview()` is a wrapper around `message_preview_plain()`. For e2ee rows it returns 'Sent you a message'.
- `notify_user()` contains a block marked `-- e2ee` that adds `{e2ee: true, message_id}` to the stored payload and to the push `data`.
- `poll_option_ok()` accepts e2ee polls.
- `e2ee_message_guard` trigger: clients can create e2ee rows only through `send_e2ee_message` / `edit_e2ee_message`.

If a later migration redefines one of these, it must keep the e2ee branch.
