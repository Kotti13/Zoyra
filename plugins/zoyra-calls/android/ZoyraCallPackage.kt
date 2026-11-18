// Generated into android/ by plugins/withZoyraCalls.js (expo prebuild). Edit the copy in plugins/zoyra-calls/android/.
package __PACKAGE__.zoyracall

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class ZoyraCallPackage : ReactPackage {
  @Deprecated("Legacy module registration; works through the New Architecture interop layer.")
  @Suppress("OVERRIDE_DEPRECATION")
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(ZoyraCallModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<in Nothing, in Nothing>> =
    emptyList()
}
