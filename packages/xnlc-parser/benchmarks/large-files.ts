// Отдельная проверка больших JAR, исключённых из ограниченного набора.
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { analyze, sha1File } from "../src"

const directory = process.argv[2]
if (!directory) throw new Error("Usage: bun benchmarks/large-files.ts <destination>")
await mkdir(directory, { recursive: true })
const headers = { "User-Agent": "XneonLauncher-parser-benchmark/0.1 (https://launcher.xneon.org)" }
const results = []
for (const project of ["ambientsounds", "biomes-o-plenty", "cobblemon"]) {
  const response = await fetch(`https://api.modrinth.com/v2/project/${project}/version?loaders=%5B%22fabric%22%5D`, { headers })
  if (!response.ok) throw new Error(`Modrinth version query: ${response.status}`)
  const versions = await response.json() as { id: string; files: { primary: boolean; filename: string; url: string; size: number; hashes: { sha1: string } }[] }[]
  const version = versions[0], file = version?.files.find(item => item.primary)
  if (!file) throw new Error(`Missing primary file: ${project}`)
  const path = join(directory, `${file.hashes.sha1}.jar`)
  const download = await fetch(file.url, { headers })
  if (!download.ok) throw new Error(`Download failed: ${project} ${download.status}`)
  await Bun.write(path, download)
  if (await sha1File(path) !== file.hashes.sha1) throw new Error(`SHA-1 mismatch: ${project}`)
  const result = await analyze(path)
  results.push({ project, versionId: version.id, url: file.url, filename: file.filename, size: file.size, sha1: file.hashes.sha1, formats: result.formats, mods: result.mods.map(mod => ({ loader: mod.loader, id: mod.id, version: mod.version })), diagnostics: result.diagnostics })
  console.log(JSON.stringify(results.at(-1)))
}
await writeFile(join(directory, "large-results.json"), JSON.stringify(results, null, 2))
