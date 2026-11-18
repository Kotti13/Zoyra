// NSE crypto test harness (macOS). Built and run by scripts/nse-selftest.mjs:
//   swiftc -O plugins/zoyra-nse/ZoyraE2EE.swift plugins/zoyra-nse/tests/main.swift -o <tmp>/nse-test && <tmp>/nse-test fixtures.json
// Checks HChaCha20 / XChaCha20-Poly1305 against draft-irtf-cfrg-xchacha-03 and against vectors + sealed messages
// produced by the JS implementation (src/lib/e2ee/crypto.ts).
import Foundation

var failures = 0
var passed = 0
func check(_ name: String, _ ok: Bool) {
  if ok { passed += 1; print("  ok  \(name)") } else { failures += 1; print("  FAIL \(name)") }
}
func hex(_ s: String) -> Data {
  var d = Data(); var i = s.startIndex
  while i < s.endIndex { let j = s.index(i, offsetBy: 2); d.append(UInt8(s[i..<j], radix: 16)!); i = j }
  return d
}
func tohex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

// draft-irtf-cfrg-xchacha-03 §2.2.1 (HChaCha20)
let hk = hex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
let hn = hex("000000090000004a0000000031415927")
check("HChaCha20 draft §2.2.1", (try? tohex(ZoyraE2EE.hchacha20(key: hk, nonce16: hn))) == "82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc")

// draft-irtf-cfrg-xchacha-03 §A.3.1 (AEAD_XChaCha20_Poly1305)
let pt = Data("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.".utf8)
let aad = hex("50515253c0c1c2c3c4c5c6c7")
let key = hex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f")
let iv = hex("404142434445464748494a4b4c4d4e4f5051525354555657")
let ct = hex("bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52e")
let tag = hex("c0875924c1c7987947deafd8780acf49")
check("XChaCha20-Poly1305 draft §A.3.1 seal", (try? ZoyraE2EE.xSeal(key: key, nonce: iv, plaintext: pt, aad: aad)) == ct + tag)
check("XChaCha20-Poly1305 draft §A.3.1 open", (try? ZoyraE2EE.xOpen(key: key, nonce: iv, sealed: ct + tag, aad: aad)) == pt)
var bad = ct + tag; bad[3] ^= 1
check("XChaCha20-Poly1305 rejects tampering", (try? ZoyraE2EE.xOpen(key: key, nonce: iv, sealed: bad, aad: aad)) == nil)

// JS fixtures
guard CommandLine.arguments.count > 1, let raw = FileManager.default.contents(atPath: CommandLine.arguments[1]),
      let fx = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
  print("  FAIL no fixtures file"); exit(1)
}
for v in fx["xchacha"] as? [[String: String]] ?? [] {
  let out = try? ZoyraE2EE.xSeal(key: hex(v["key"]!), nonce: hex(v["nonce"]!), plaintext: hex(v["pt"]!), aad: hex(v["aad"]!))
  check("XChaCha20-Poly1305 vs noble (\(v["pt"]!.count / 2) bytes)", out.map(tohex) == v["sealed"]!)
}
for c in fx["messages"] as? [[String: Any]] ?? [] {
  let name = c["name"] as! String
  let zx = c["zx"] as! [String: Any]
  let priv = Data(base64Encoded: c["enc_priv"] as! String)!
  let expect = c["expect"] as? String
  var got: String? = nil
  if let m = try? ZoyraE2EE.message(fromZX: zx), let p = try? ZoyraE2EE.open(m, encPriv: priv) {
    got = ZoyraE2EE.previewText(kind: m.kind, payload: p)
  }
  if let expect { check("message: \(name)", got == expect) } else { check("message rejected: \(name)", got == nil) }
}
print("\(passed) passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)
