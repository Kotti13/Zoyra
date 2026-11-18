import { Redirect } from 'expo-router';

/** Unknown paths (stale deep links, old notification URLs) land on Home instead of the "Unmatched Route" page. */
export default function NotFound() {
  return <Redirect href="/" />;
}
