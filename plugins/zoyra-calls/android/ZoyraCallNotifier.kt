// Generated into android/ by plugins/withZoyraCalls.js (expo prebuild). Edit the copy in plugins/zoyra-calls/android/.
package __PACKAGE__.zoyracall

import android.app.Activity
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.util.Log
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.core.app.NotificationCompat
import androidx.core.app.Person

/**
 * Zoyra incoming-call notification: a CallStyle notification on the `zoyra_calls` channel (our own
 * ringtone `res/raw/zoyra_ring`, looped with FLAG_INSISTENT until answered / declined / cancelled) with a
 * full-screen intent that opens the app straight into `/call?id=<id>` over the lock screen.
 */
object ZoyraCallNotifier {
  private const val TAG = "ZoyraCall"
  const val CHANNEL_ID = "zoyra_calls_v1"
  const val NOTIFICATION_ID = 7301
  const val EXTRA_CALL_ID = "zoyra_call_id"
  const val EXTRA_RING = "zoyra_call_ring"
  const val EXTRA_ANSWER = "zoyra_call_answer"
  /** Random per-notification secret: proves an Answer intent came from our own PendingIntent (extras on a
   *  plain deep link / browser intent:// URL can be forged, this value can't be guessed). */
  const val EXTRA_NONCE = "zoyra_call_nonce"
  private const val PREFS = "zoyra_call_answer"
  private const val ANSWER_TTL_MS = 120_000L
  const val ACTION_DECLINE = "__PACKAGE__.zoyracall.DECLINE"
  private const val RING_TIMEOUT_MS = 65_000L
  private const val ACCENT = 0xFFFA2D48.toInt()

  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = context.getSystemService(NotificationManager::class.java) ?: return
    if (nm.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(CHANNEL_ID, "Incoming calls", NotificationManager.IMPORTANCE_HIGH)
    channel.description = "Rings for incoming Zoyra voice and video calls"
    channel.setSound(
      ringUri(context),
      AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build(),
    )
    channel.enableVibration(true)
    channel.vibrationPattern = longArrayOf(0, 700, 1300)
    channel.enableLights(true)
    channel.lightColor = Color.RED
    channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    channel.setBypassDnd(false)
    nm.createNotificationChannel(channel)
  }

  fun ringUri(context: Context): Uri = Uri.parse("android.resource://${context.packageName}/raw/zoyra_ring")

  private fun launchIntent(context: Context, callId: String, answer: Boolean, nonce: String? = null): Intent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    val query = if (answer) "&answer=1" else "&ring=1"
    return Intent(Intent.ACTION_VIEW, Uri.parse("zoyra://call?id=${Uri.encode(callId)}$query")).apply {
      component = launch.component
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      putExtra(EXTRA_CALL_ID, callId)
      putExtra(EXTRA_RING, true)
      putExtra(EXTRA_ANSWER, answer)
      if (nonce != null) putExtra(EXTRA_NONCE, nonce)
    }
  }

  private fun smallIcon(context: Context): Int {
    val res = context.resources
    val own = res.getIdentifier("notification_icon", "drawable", context.packageName)
    return if (own != 0) own else android.R.drawable.sym_call_incoming
  }

  /** Posts (or replaces) the ringing notification for this call. Never throws. */
  fun show(context: Context, callId: String, callerName: String, video: Boolean) {
    try {
      ensureChannel(context)
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      val base = callId.hashCode()
      val ringIntent = launchIntent(context, callId, false) ?: return
      val nonce = java.util.UUID.randomUUID().toString()
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("nonce:$callId", nonce).apply()
      val answerIntent = launchIntent(context, callId, true, nonce) ?: return
      val fullScreen = PendingIntent.getActivity(context, base, ringIntent, flags)
      val answer = PendingIntent.getActivity(context, base + 1, answerIntent, flags)
      val decline = PendingIntent.getBroadcast(
        context,
        base + 2,
        Intent(context, ZoyraCallActionReceiver::class.java).setAction(ACTION_DECLINE).putExtra(EXTRA_CALL_ID, callId),
        flags,
      )
      val name = callerName.ifBlank { "Zoyra" }
      val what = if (video) "Incoming Zoyra video call" else "Incoming Zoyra voice call"
      val person = Person.Builder().setName(name).setImportant(true).build()

      val builder = NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(smallIcon(context))
        .setColor(ACCENT)
        .setContentTitle(name)
        .setContentText(what)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setPriority(NotificationCompat.PRIORITY_MAX)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setOngoing(true)
        .setAutoCancel(false)
        .setOnlyAlertOnce(false)
        .setTimeoutAfter(RING_TIMEOUT_MS)
        .setContentIntent(fullScreen)
        .setFullScreenIntent(fullScreen, true)
        .setSound(ringUri(context))
        .setVibrate(longArrayOf(0, 700, 1300))

      val notification: Notification = try {
        builder.setStyle(NotificationCompat.CallStyle.forIncomingCall(person, decline, answer).setIsVideo(video)).build()
      } catch (e: Exception) {
        Log.w(TAG, "CallStyle unavailable, using plain actions", e)
        builder.setStyle(null)
          .addAction(0, "Decline", decline)
          .addAction(0, "Answer", answer)
          .build()
      }
      // Ring (and vibrate) on a loop until the notification is cancelled.
      notification.flags = notification.flags or Notification.FLAG_INSISTENT
      context.getSystemService(NotificationManager::class.java)?.notify(callId, NOTIFICATION_ID, notification)
    } catch (e: Exception) {
      Log.w(TAG, "Couldn't post the incoming call notification", e)
    }
  }

  fun cancel(context: Context, callId: String) {
    try {
      context.getSystemService(NotificationManager::class.java)?.cancel(callId, NOTIFICATION_ID)
    } catch (e: Exception) {
      Log.w(TAG, "cancel failed", e)
    }
  }

  fun cancelAll(context: Context) {
    try {
      val nm = context.getSystemService(NotificationManager::class.java) ?: return
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        nm.activeNotifications.filter { it.id == NOTIFICATION_ID }.forEach { nm.cancel(it.tag, it.id) }
      }
    } catch (e: Exception) {
      Log.w(TAG, "cancelAll failed", e)
    }
  }

  fun canUseFullScreenIntent(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < 34) return true
    return context.getSystemService(NotificationManager::class.java)?.canUseFullScreenIntent() ?: false
  }

  fun isLocked(context: Context): Boolean =
    context.getSystemService(KeyguardManager::class.java)?.isKeyguardLocked ?: false

  /** Shows the activity over the lock screen (and turns the screen on) while a call rings / is live. */
  fun setShowWhenLocked(activity: Activity, on: Boolean) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      activity.setShowWhenLocked(on)
      activity.setTurnScreenOn(on)
    } else {
      @Suppress("DEPRECATION")
      val f = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
      if (on) activity.window.addFlags(f) else activity.window.clearFlags(f)
    }
  }

  /** Called by MainActivity (onCreate + every new intent): a call notification tap shows over the lock screen. */
  fun handleIntent(activity: Activity, intent: Intent?) {
    if (intent == null || !intent.getBooleanExtra(EXTRA_RING, false)) return
    setShowWhenLocked(activity, true)
    val callId = intent.getStringExtra(EXTRA_CALL_ID)
    // Answer stops the ringtone right away; the JS call screen answers the call — but only after
    // consumeAnswer() confirms the tap came from our notification (nonce match), not a crafted link.
    if (callId != null && intent.getBooleanExtra(EXTRA_ANSWER, false)) {
      cancel(activity, callId)
      val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val expected = prefs.getString("nonce:$callId", null)
      val got = intent.getStringExtra(EXTRA_NONCE)
      if (expected != null && got != null && expected == got) {
        prefs.edit().remove("nonce:$callId").putString("answered", callId).putLong("answered_at", System.currentTimeMillis()).apply()
      }
    }
  }

  /** One-shot: true when our notification's Answer was tapped for this call in the last 2 minutes. */
  fun consumeAnswer(context: Context, callId: String): Boolean {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val id = prefs.getString("answered", null) ?: return false
    val at = prefs.getLong("answered_at", 0L)
    prefs.edit().remove("answered").remove("answered_at").apply()
    return id.equals(callId, ignoreCase = true) && (System.currentTimeMillis() - at) in 0L..ANSWER_TTL_MS
  }

  /** Hooks MainActivity: applies the current intent and every later one. */
  fun attach(activity: Activity) {
    handleIntent(activity, activity.intent)
    if (activity is ComponentActivity) {
      activity.addOnNewIntentListener { handleIntent(activity, it) }
    }
  }
}
