// Generated into android/ by plugins/withZoyraCalls.js (expo prebuild). Edit the copy in plugins/zoyra-calls/android/.
package __PACKAGE__.zoyracall

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.facebook.react.HeadlessJsTaskService

/** Decline on the call notification: stop ringing now, then let JS decline the call on the server. */
class ZoyraCallActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val callId = intent.getStringExtra(ZoyraCallNotifier.EXTRA_CALL_ID) ?: return
    ZoyraCallNotifier.cancel(context, callId)
    if (intent.action != ZoyraCallNotifier.ACTION_DECLINE) return
    val task = Intent(context, ZoyraCallTaskService::class.java)
      .putExtra("action", "decline")
      .putExtra("callId", callId)
    try {
      HeadlessJsTaskService.acquireWakeLockNow(context)
      context.startService(task)
    } catch (e: Exception) {
      // Background start refused: the call still times out as missed on the server.
      Log.w("ZoyraCall", "Couldn't start the decline task", e)
    }
  }
}
