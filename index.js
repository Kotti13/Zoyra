// App entry. Background tasks must be defined at module scope before the app renders (expo-task-manager
// runs them in a headless JS context when a push wakes the killed app), so the native-call module is
// imported first. Then Expo Router's normal entry.
import './src/lib/native-call';
import 'expo-router/entry';
