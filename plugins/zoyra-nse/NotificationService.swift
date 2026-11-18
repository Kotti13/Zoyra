// Zoyra Notification Service Extension: shows the decrypted text of end-to-end encrypted chat messages.
// The push (supabase/functions/push/index.ts) carries `zx` inside the Expo data (APNs key "body"): the message
// ciphertext, THIS device's envelope and the sender device's public keys. The private key comes from the shared
// keychain (ZoyraKeychain). Anything missing or failing → the generic body the server sent stays.
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttempt: UNMutableNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    self.contentHandler = contentHandler
    let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
    bestAttempt = content
    if let text = Self.decryptedPreview(request.content.userInfo) {
      content.body = text
    }
    contentHandler(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let handler = contentHandler, let content = bestAttempt { handler(content) }
  }

  /// Expo puts the push `data` under "body" (an object, or a JSON string on some paths); accept top level too.
  static func dataDict(_ userInfo: [AnyHashable: Any]) -> [String: Any]? {
    if let d = userInfo["body"] as? [String: Any] { return d }
    if let s = userInfo["body"] as? String, let d = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] { return d }
    if let d = userInfo["data"] as? [String: Any] { return d }
    var top: [String: Any] = [:]
    for (k, v) in userInfo { if let k = k as? String { top[k] = v } }
    return top
  }

  static func decryptedPreview(_ userInfo: [AnyHashable: Any]) -> String? {
    guard let data = dataDict(userInfo), (data["e2ee"] as? Bool) == true || (data["e2ee"] as? NSNumber)?.boolValue == true,
          let zx = data["zx"] as? [String: Any] else { return nil }
    do {
      let m = try ZoyraE2EE.message(fromZX: zx)
      // The envelope must be for the message the push names.
      if let mid = data["message_id"] as? String, mid.lowercased() != m.messageId { return nil }
      guard let key = ZoyraKeychain.deviceKey(m.deviceId) else { return nil }
      let payload = try ZoyraE2EE.open(m, encPriv: key)
      return ZoyraE2EE.previewText(kind: m.kind, payload: payload)
    } catch {
      return nil
    }
  }
}
