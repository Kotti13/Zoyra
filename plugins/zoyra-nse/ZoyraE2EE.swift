// Zoyra E2EE — native decrypt path for the Notification Service Extension.
// Mirrors src/lib/e2ee/crypto.ts (version 1). Pure: no keychain / UIKit, so plugins/zoyra-nse/tests can compile it
// with swiftc on macOS and check it against fixtures produced by the JS implementation (scripts/nse-fixtures.mjs).
//
//   envelope:  shared   = X25519(my_enc_priv, eph_pub)                  (all-zero → reject)
//              wrap_key = HKDF-SHA256(ikm: shared, salt: eph_pub ‖ my_enc_pub, info: frame("zoyra-e2ee-wrap-v1", mid, device_id), 32)
//              content_key = XChaCha20-Poly1305(wrap_key, nonce, aad: frame("zoyra-e2ee-wrap-aad", mid, device_id)).open(wrapped)
//   device:    Ed25519_verify(account_sign_pub, frame("zoyra-e2ee-device-v1", sender_id, sender_device_id, enc_pub?, sign_pub), account_sig)
//              (enc_pub of the sender device is not needed to decrypt, so the cert is checked with the
//               sender's enc_pub only when supplied; the push carries sign_pub + account_sig + enc_pub.)
//   message:   Ed25519_verify(sign_pub, SHA256(frame("zoyra-e2ee-sig-v1", 1, cid, mid, sender_device_id, nonce, ct,
//                                               SHA256(frame("zoyra-e2ee-commit-v1", content_key)))), sig)
//              plaintext = XChaCha20-Poly1305(content_key, nonce, aad: frame("zoyra-e2ee-msg", 1, cid, mid, sender_device_id)).open(ct)
//
// XChaCha20-Poly1305 = HChaCha20 subkey (key, nonce[0..<16]) + IETF ChaCha20-Poly1305 (CryptoKit ChaChaPoly) with
// nonce 0x00000000 ‖ nonce[16..<24] (draft-irtf-cfrg-xchacha-03 §2.3).
import CryptoKit
import Foundation

public enum ZoyraE2EEError: Error {
  case badFormat, badEnvelope, badSignature, badDevice, decryptFailed, unsupportedVersion
}

public enum ZoyraE2EE {
  // MARK: encoding

  static func u32be(_ n: UInt32) -> Data {
    var be = n.bigEndian
    return Data(bytes: &be, count: 4)
  }

  /// Length-prefixed concatenation, identical to `frame()` in crypto.ts (strings UTF-8, numbers u32 big endian).
  public enum Part { case s(String), n(UInt32), b(Data) }
  public static func frame(_ parts: [Part]) -> Data {
    var out = Data()
    for p in parts {
      let bytes: Data
      switch p {
      case .s(let s): bytes = Data(s.utf8)
      case .n(let n): bytes = u32be(n)
      case .b(let b): bytes = b
      }
      out.append(u32be(UInt32(bytes.count)))
      out.append(bytes)
    }
    return out
  }

  public static func b64(_ s: String?) throws -> Data {
    guard let s, let d = Data(base64Encoded: s) else { throw ZoyraE2EEError.badFormat }
    return d
  }

  // MARK: HChaCha20 / XChaCha20-Poly1305

  @inline(__always) static func rotl(_ v: UInt32, _ c: UInt32) -> UInt32 { (v << c) | (v >> (32 - c)) }

  @inline(__always) static func qr(_ s: inout [UInt32], _ a: Int, _ b: Int, _ c: Int, _ d: Int) {
    s[a] = s[a] &+ s[b]; s[d] ^= s[a]; s[d] = rotl(s[d], 16)
    s[c] = s[c] &+ s[d]; s[b] ^= s[c]; s[b] = rotl(s[b], 12)
    s[a] = s[a] &+ s[b]; s[d] ^= s[a]; s[d] = rotl(s[d], 8)
    s[c] = s[c] &+ s[d]; s[b] ^= s[c]; s[b] = rotl(s[b], 7)
  }

  static func le32(_ d: [UInt8], _ i: Int) -> UInt32 {
    UInt32(d[i]) | (UInt32(d[i + 1]) << 8) | (UInt32(d[i + 2]) << 16) | (UInt32(d[i + 3]) << 24)
  }

  /// HChaCha20(key: 32 bytes, nonce: 16 bytes) → 32-byte subkey.
  public static func hchacha20(key: Data, nonce16: Data) throws -> Data {
    guard key.count == 32, nonce16.count == 16 else { throw ZoyraE2EEError.badFormat }
    let k = [UInt8](key), n = [UInt8](nonce16)
    var s: [UInt32] = [0x6170_7865, 0x3320_646e, 0x7962_2d32, 0x6b20_6574]
    for i in 0..<8 { s.append(le32(k, i * 4)) }
    for i in 0..<4 { s.append(le32(n, i * 4)) }
    for _ in 0..<10 {
      qr(&s, 0, 4, 8, 12); qr(&s, 1, 5, 9, 13); qr(&s, 2, 6, 10, 14); qr(&s, 3, 7, 11, 15)
      qr(&s, 0, 5, 10, 15); qr(&s, 1, 6, 11, 12); qr(&s, 2, 7, 8, 13); qr(&s, 3, 4, 9, 14)
    }
    var out = Data(capacity: 32)
    for w in [s[0], s[1], s[2], s[3], s[12], s[13], s[14], s[15]] {
      var le = w.littleEndian
      out.append(Data(bytes: &le, count: 4))
    }
    return out
  }

  /// XChaCha20-Poly1305 open. `sealed` = ciphertext ‖ 16-byte tag (noble / libsodium layout).
  public static func xOpen(key: Data, nonce: Data, sealed: Data, aad: Data) throws -> Data {
    guard key.count == 32, nonce.count == 24, sealed.count >= 16 else { throw ZoyraE2EEError.badFormat }
    let sub = try hchacha20(key: key, nonce16: nonce.subdata(in: 0..<16))
    let n12 = Data(count: 4) + nonce.subdata(in: 16..<24)
    let box = try ChaChaPoly.SealedBox(nonce: ChaChaPoly.Nonce(data: n12), ciphertext: sealed.prefix(sealed.count - 16), tag: sealed.suffix(16))
    return try ChaChaPoly.open(box, using: SymmetricKey(data: sub), authenticating: aad)
  }

  /// XChaCha20-Poly1305 seal (tests only).
  public static func xSeal(key: Data, nonce: Data, plaintext: Data, aad: Data) throws -> Data {
    let sub = try hchacha20(key: key, nonce16: nonce.subdata(in: 0..<16))
    let n12 = Data(count: 4) + nonce.subdata(in: 16..<24)
    let box = try ChaChaPoly.seal(plaintext, using: SymmetricKey(data: sub), nonce: ChaChaPoly.Nonce(data: n12), authenticating: aad)
    return box.ciphertext + box.tag
  }

  // MARK: message

  public struct Message {
    public var messageId: String
    public var conversationId: String
    public var senderId: String
    public var senderDeviceId: String
    public var kind: String
    public var ciphertext: Data
    public var nonce: Data
    public var signature: Data
    public var senderSignPub: Data
    public var senderAccountSig: Data
    public var senderAccountPub: Data
    public var senderEncPub: Data?
    public var deviceId: String
    public var wrappedKey: Data
    public var ephPub: Data
    public var envNonce: Data
  }

  /// Parses the `zx` object of a push (supabase/functions/push/index.ts, type ZX).
  public static func message(fromZX zx: [String: Any]) throws -> Message {
    func s(_ k: String) throws -> String {
      guard let v = zx[k] as? String, !v.isEmpty else { throw ZoyraE2EEError.badFormat }
      return v
    }
    let v = (zx["v"] as? NSNumber)?.intValue ?? Int((zx["v"] as? String) ?? "") ?? 0
    guard v == 1 else { throw ZoyraE2EEError.unsupportedVersion }
    return Message(
      messageId: try s("m").lowercased(), conversationId: try s("ci").lowercased(), senderId: try s("su").lowercased(),
      senderDeviceId: try s("sd").lowercased(), kind: (zx["k"] as? String) ?? "text",
      ciphertext: try b64(s("c")), nonce: try b64(s("cn")), signature: try b64(s("s")),
      senderSignPub: try b64(s("sp")), senderAccountSig: try b64(s("sa")), senderAccountPub: try b64(s("ap")),
      senderEncPub: (zx["se"] as? String).flatMap { Data(base64Encoded: $0) },
      deviceId: try s("d").lowercased(), wrappedKey: try b64(s("w")), ephPub: try b64(s("e")), envNonce: try b64(s("n")))
  }

  public static func unwrap(_ m: Message, encPriv: Data) throws -> Data {
    guard encPriv.count == 32, m.ephPub.count == 32 else { throw ZoyraE2EEError.badEnvelope }
    do {
      let priv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: encPriv)
      let eph = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: m.ephPub)
      let shared = try priv.sharedSecretFromKeyAgreement(with: eph)
      let isZero = shared.withUnsafeBytes { raw in raw.allSatisfy { $0 == 0 } }
      if isZero { throw ZoyraE2EEError.badEnvelope }
      let myPub = priv.publicKey.rawRepresentation
      let wrapKey = shared.hkdfDerivedSymmetricKey(
        using: SHA256.self, salt: m.ephPub + myPub,
        sharedInfo: frame([.s("zoyra-e2ee-wrap-v1"), .s(m.messageId), .s(m.deviceId)]), outputByteCount: 32)
      let keyData = wrapKey.withUnsafeBytes { Data($0) }
      let ck = try xOpen(key: keyData, nonce: m.envNonce, sealed: m.wrappedKey, aad: frame([.s("zoyra-e2ee-wrap-aad"), .s(m.messageId), .s(m.deviceId)]))
      guard ck.count == 32 else { throw ZoyraE2EEError.badEnvelope }
      return ck
    } catch let e as ZoyraE2EEError {
      throw e
    } catch {
      throw ZoyraE2EEError.badEnvelope
    }
  }

  static func verify(pub: Data, sig: Data, msg: Data) -> Bool {
    guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: pub) else { return false }
    return key.isValidSignature(sig, for: msg)
  }

  /// Full receive path: envelope → device certificate → signature → decrypt. Returns the payload JSON object.
  public static func open(_ m: Message, encPriv: Data) throws -> [String: Any] {
    let contentKey = try unwrap(m, encPriv: encPriv)
    // The device certificate covers enc_pub too; without it we can still bind sign_pub when the push carries enc_pub.
    if let encPub = m.senderEncPub {
      let cert = frame([.s("zoyra-e2ee-device-v1"), .s(m.senderId), .s(m.senderDeviceId), .b(encPub), .b(m.senderSignPub)])
      guard verify(pub: m.senderAccountPub, sig: m.senderAccountSig, msg: cert) else { throw ZoyraE2EEError.badDevice }
    } else {
      throw ZoyraE2EEError.badDevice
    }
    let commit = Data(SHA256.hash(data: frame([.s("zoyra-e2ee-commit-v1"), .b(contentKey)])))
    let digest = Data(SHA256.hash(data: frame([
      .s("zoyra-e2ee-sig-v1"), .n(1), .s(m.conversationId), .s(m.messageId), .s(m.senderDeviceId), .b(m.nonce), .b(m.ciphertext), .b(commit),
    ])))
    guard verify(pub: m.senderSignPub, sig: m.signature, msg: digest) else { throw ZoyraE2EEError.badSignature }
    let plain: Data
    do {
      plain = try xOpen(key: contentKey, nonce: m.nonce, sealed: m.ciphertext,
                        aad: frame([.s("zoyra-e2ee-msg"), .n(1), .s(m.conversationId), .s(m.messageId), .s(m.senderDeviceId)]))
    } catch {
      throw ZoyraE2EEError.decryptFailed
    }
    guard let obj = try? JSONSerialization.jsonObject(with: plain) as? [String: Any] else { throw ZoyraE2EEError.badFormat }
    return obj
  }

  // MARK: preview (mirror of previewText() in src/lib/e2ee/index.ts)

  static func clip(_ s: String, _ n: Int) -> String { s.count <= n ? s : String(s.prefix(n)) }

  public static func previewText(kind: String, payload p: [String: Any]) -> String {
    let meta = p["meta"] as? [String: Any] ?? [:]
    let body = p["body"] as? String ?? ""
    switch kind {
    case "voice": return "Sent a voice note"
    case "photo": return body.isEmpty ? "Sent a photo" : "📷 " + clip(body, 120)
    case "poll": return "Poll: " + clip(meta["question"] as? String ?? "", 120)
    case "jam": return "Invited you to a jam"
    case "live": return "Invited you to a live session"
    case "location": return "Shared a location"
    case "playlist":
      let t = meta["title"] as? String ?? ""
      return "Sent you a playlist: " + (t.isEmpty ? "a playlist" : t)
    case "lyric": return "Sent a lyric card"
    default:
      if !body.isEmpty { return clip(body, 140) }
      if let t = p["track"] as? [String: Any] { return "Sent you a song: " + (t["title"] as? String ?? "a track") }
      return "Sent you a message"
    }
  }
}
