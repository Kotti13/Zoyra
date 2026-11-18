// Generated into android/ by plugins/withZoyraCalls.js (expo prebuild). Edit the copy in plugins/zoyra-calls/android/.
package __PACKAGE__.zoyracall

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/** Runs the `ZoyraCallAction` headless JS task (registered in src/lib/native-call.ts), e.g. decline from the notification. */
class ZoyraCallTaskService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    val extras = intent?.extras ?: return null
    return HeadlessJsTaskConfig("ZoyraCallAction", Arguments.fromBundle(extras), 20_000L, true)
  }
}
