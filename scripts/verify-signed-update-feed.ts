import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import packageJson from "../package.json"
import { updatePublicKeys } from "../electrobun/main/update-public-keys"
import { verifySignedWindowsUpdateManifest } from "../electrobun/main/verified-update-manifest"

const [directory] = Bun.argv.slice(2)
assert.ok(directory && packageJson.version === "1.0.8-pre3")
const expected = new Set(["xneon-launcher-1.0.8-pre3-win-x64.exe"])
for (const channel of ["stable", "canary"] as const) {
  const name = `${channel}-win-x64-update-v2.json`
  const [manifestBytes, envelope] = await Promise.all(
    [name, name + ".sig"].map(file => readFile(path.join(directory, file))),
  )
  const manifest = verifySignedWindowsUpdateManifest(manifestBytes, envelope, updatePublicKeys, "0.0.0", channel, "canary")
  assert.equal(manifest.version, packageJson.version)
  const archive = Bun.file(path.join(directory, manifest.artifact.file))
  assert.equal(archive.size, manifest.artifact.downloadSize)
  const hash = createHash("sha256")
  for await (const chunk of archive.stream()) hash.update(chunk)
  assert.equal(hash.digest("hex"), manifest.artifact.downloadSha256)
  expected.add(name).add(name + ".sig").add(manifest.artifact.file)
}
assert.deepEqual((await readdir(directory)).sort(), [...expected].sort(), "Unexpected release attachments")
const checksums: string[] = []
for (const name of [...expected].sort()) {
  const file = Bun.file(path.join(directory, name))
  assert.ok(file.size > 0, "Missing or empty release attachment")
  const hash = createHash("sha256")
  for await (const chunk of file.stream()) hash.update(chunk)
  checksums.push(hash.digest("hex") + "  " + name)
}
await writeFile(path.join(directory, "SHA256SUMS.txt"), checksums.join("\n") + "\n", { flag: "wx" })
console.log("Verified trusted signatures and release attachment hashes")
