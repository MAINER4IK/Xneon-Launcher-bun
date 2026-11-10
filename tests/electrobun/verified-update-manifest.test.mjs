import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { test } from "bun:test"
import { verifySignedWindowsUpdateManifest, verifyWindowsUpdateManifest } from "../../electrobun/main/verified-update-manifest.ts"

const { publicKey, privateKey } = generateKeyPairSync("ed25519")
const manifest = {
  schemaVersion: 1, identifier: "com.xneonlauncher.app", channel: "stable",
  version: "1.0.8", hash: "abc123", platform: "win", arch: "x64",
  artifact: { file: "stable-win-x64-XneonLauncher.tar.zst", tarSha256: "a".repeat(64), tarSize: 1000, downloadSha256: "b".repeat(64), downloadSize: 500 },
}

function verifyManifest(patch = {}, installed = "1.0.8-pre2", preference = "stable") {
  const bytes = Buffer.from(JSON.stringify({ ...manifest, ...patch }))
  return verifyWindowsUpdateManifest(bytes, sign(null, bytes, privateKey), publicKey, installed, "stable", preference)
}

test("stable and beta apply version policy without changing the installed channel", () => {
  assert.equal(verifyManifest().version, "1.0.8")
  assert.equal(verifyManifest({ version: "1.0.8-pre3" }, "1.0.8-pre2", "canary").version, "1.0.8-pre3")
  assert.throws(() => verifyManifest({ version: "1.0.8-pre3" }), /stable version/)
  assert.throws(() => verifyManifest({ version: "1.0.8-pre1" }), /newer/)
  assert.throws(() => verifyManifest({}, "1.0.8"), /newer/)
  assert.throws(() => verifyManifest({ channel: "canary" }), /installed package/)
})

test("signature and archive integrity fields are required", () => {
  const original = Buffer.from(JSON.stringify(manifest))
  const changed = Buffer.from(JSON.stringify({ ...manifest, version: "1.0.9" }))
  assert.throws(() => verifyWindowsUpdateManifest(changed, sign(null, original, privateKey), publicKey, "1.0.8", "stable", "stable"), /signature/)
  assert.throws(() => verifyManifest({ artifact: { file: manifest.artifact.file } }), /artifact metadata/)
})

test("only a trusted key ID with its own valid signature is accepted", () => {
  const bytes = Buffer.from(JSON.stringify(manifest))
  const other = generateKeyPairSync("ed25519")
  const trusted = { current: publicKey.export({ type: "spki", format: "pem" }) }
  const envelope = (keyId, key) => Buffer.from(JSON.stringify({ keyId, signature: sign(null, bytes, key).toString("base64") }))
  const check = value => verifySignedWindowsUpdateManifest(bytes, value, trusted, "1.0.8-pre2", "stable", "stable")
  assert.equal(check(envelope("current", privateKey)).version, "1.0.8")
  assert.throws(() => check(envelope("unknown", privateKey)), /Unknown update signing key/)
  assert.throws(() => check(envelope("current", other.privateKey)), /manifest signature/)
})
