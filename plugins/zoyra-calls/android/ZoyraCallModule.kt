// Generated into android/ by plugins/withZoyraCalls.js (expo prebuild). Edit the copy in plugins/zoyra-calls/android/.
package __PACKAGE__.zoyracall

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/** `NativeModules.ZoyraCall` (src/lib/native-call.ts): the Android incoming-call notification + lock screen. */
class ZoyraCallModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = NAME

  @ReactMethod
  fun showIncoming(callId: String, callerName: String, video: Boolean) {
    ZoyraCallNotifier.show(context, callId, callerName, video)
  }

  @ReactMethod
  fun dismiss(callId: String) {
    ZoyraCallNotifier.cancel(context, callId)
  }

  @ReactMethod
  fun dismissAll() {
    ZoyraCallNotifier.cancelAll(context)
  }

  @ReactMethod
  fun canUseFullScreenIntent(promise: Promise) {
    promise.resolve(ZoyraCallNotifier.canUseFullScreenIntent(context))
  }

  @ReactMethod
  fun openFullScreenIntentSettings() {
    try {
      val intent = if (Build.VERSION.SDK_INT >= 34) {
        Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}"))
      } else {
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      }
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    } catch (e: Exception) {
      // settings screen not available on this device
    }
  }

  @ReactMethod
  fun setShowWhenLocked(on: Boolean) {
    val activity = context.currentActivity ?: return
    UiThreadUtil.runOnUiThread { ZoyraCallNotifier.setShowWhenLocked(activity, on) }
  }

  /** "normal" | "vibrate" | "silent": the in-app ring only plays sound in "normal". */
  @ReactMethod
  fun getRingerMode(promise: Promise) {
    val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    promise.resolve(
      when (am?.ringerMode) {
        AudioManager.RINGER_MODE_SILENT -> "silent"
        AudioManager.RINGER_MODE_VIBRATE -> "vibrate"
        else -> "normal"
      },
    )
  }

  /** One-shot proof that the notification's Answer button (not a crafted deep link) opened `/call?answer=1`. */
  @ReactMethod
  fun consumeAnswer(callId: String, promise: Promise) {
    promise.resolve(ZoyraCallNotifier.consumeAnswer(context, callId))
  }

  @ReactMethod
  fun isLocked(promise: Promise) {
    promise.resolve(ZoyraCallNotifier.isLocked(context))
  }

  companion object {
    const val NAME = "ZoyraCall"
  }
}
