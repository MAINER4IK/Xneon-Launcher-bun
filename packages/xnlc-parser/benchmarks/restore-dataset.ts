// Восстановление зафиксированного набора без включения сторонних JAR в Git.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { sha1 } from "../src"

const [manifestPath, destination] = process.argv.slice(2)
if (!manifestPath || !destination) throw new Error("Usage: bun benchmarks/restore-dataset.ts <manifest.json> <destination>")
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { entries: { localName: string; url: string; size: number; sha1: string; sha256: string }[] }
await mkdir(destination, { recursive: true })
let restored = 0
for (const entry of manifest.entries) {
  if (!/^[a-f0-9]{40}\.jar$/.test(entry.localName) || basename(entry.localName) !== entry.localName || !entry.url.startsWith("https://cdn.modrinth.com/")) throw new Error("Unsafe dataset manifest entry")
  const response = await fetch(entry.url, { headers: { "User-Agent": "XneonLauncher-parser-benchmark/0.1 (https://launcher.xneon.org)" } })
  if (!response.ok) throw new Error(`Download failed: ${entry.localName} (${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length !== entry.size || sha1(bytes) !== entry.sha1 || new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(`Hash mismatch: ${entry.localName}`)
  await writeFile(join(destination, entry.localName), bytes)
  restored++
}
await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify({ destination, restored }))
