// Reads this device's X25519 key written by src/lib/e2ee/keystore.ts (writeNseKey) through expo-secure-store:
//   kSecClassGenericPassword, service "zoyra.e2ee.nse:no-auth", account = generic = UTF-8 "zoyra.e2ee.nse.<device_id>",
//   value JSON {"v":1,"uid":"…","d":"<device_id>","p":"<base64 enc_priv>"}, AfterFirstUnlockThisDeviceOnly.
// The item lives in the shared group `$(AppIdentifierPrefix)com.zoyra.app.shared` (first keychain-access-groups
// entry of the app, so its default group). No kSecAttrAccessGroup here: the query searches every group this
// extension is entitled to, which includes the shared one.
import Foundation
import Security

enum ZoyraKeychain {
  static let service = "zoyra.e2ee.nse:no-auth"

  static func deviceKey(_ deviceId: String) -> Data? {
    let account = Data("zoyra.e2ee.nse.\(deviceId.lowercased())".utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: kCFBooleanTrue as Any,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data,
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          (obj["v"] as? NSNumber)?.intValue == 1,
          let p = obj["p"] as? String, let key = Data(base64Encoded: p), key.count == 32 else { return nil }
    return key
  }
}
