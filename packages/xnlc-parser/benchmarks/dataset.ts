// Загрузка набора для локального benchmark. Архивы не входят в репозиторий.
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { sha1 } from "../src"

const directory = process.argv[2]
const target = Number(process.argv[3] ?? 30), maxMiB = Number(process.argv[4] ?? 4)
if (!directory || !Number.isInteger(target) || target < 1 || target > 100 || !Number.isFinite(maxMiB) || maxMiB <= 0 || maxMiB > 128) throw new Error("Usage: bun benchmarks/dataset.ts <destination> [count 1..100] [max MiB]")
await mkdir(directory, { recursive: true })
const headers = { "User-Agent": "XneonLauncher-parser-benchmark/0.1 (https://launcher.xneon.org)" }
const facets = encodeURIComponent(JSON.stringify([["categories:fabric"], ["project_type:mod"]]))
const hits: { project_id: string; slug: string }[] = []
for (const offset of [0, 100]) {
  const response = await fetch(`https://api.modrinth.com/v2/search?facets=${facets}&limit=100&offset=${offset}`, { headers })
  if (!response.ok) throw new Error(`Modrinth search: ${response.status}`)
  const page = await response.json() as { hits: typeof hits }
  hits.push(...page.hits)
}
const entries: unknown[] = [], errors: unknown[] = []
let cursor = 0
await Promise.all(Array.from({ length: 4 }, async () => {
  while (true) {
    const index = cursor++
    if (index >= hits.length || entries.length >= target) break
    const project = hits[index]
    try {
      const url = `https://api.modrinth.com/v2/project/${encodeURIComponent(project.project_id)}/version?loaders=%5B%22fabric%22%5D`
      const versionsResponse = await fetch(url, { headers })
      if (!versionsResponse.ok) throw new Error(`versions: ${versionsResponse.status}`)
      const versions = await versionsResponse.json() as { id: string; version_number: string; files: { url: string; filename: string; size: number; primary: boolean; hashes: { sha1: string } }[] }[]
      const version = versions.find(v => v.files.some(f => f.primary && f.size <= maxMiB * 1024 * 1024))
      const file = version?.files.find(f => f.primary && f.size <= maxMiB * 1024 * 1024)
      if (!file || !version) throw new Error(`No primary Fabric file within ${maxMiB} MiB`)
      const download = await fetch(file.url, { headers })
      if (!download.ok) throw new Error(`download: ${download.status}`)
      const bytes = new Uint8Array(await download.arrayBuffer())
      if (bytes.length !== file.size || sha1(bytes) !== file.hashes.sha1) throw new Error("Size or SHA-1 mismatch")
      const name = `${file.hashes.sha1}.jar`
      await writeFile(join(directory, name), bytes)
      entries.push({ project: project.slug, projectId: project.project_id, versionId: version.id, version: version.version_number, originalName: file.filename, url: file.url, size: file.size, sha1: file.hashes.sha1, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), localName: name })
    } catch (error) { errors.push({ project: project.slug, error: error instanceof Error ? error.message : String(error) }) }
  }
}))
await writeFile(join(directory, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), source: "Modrinth search categories:fabric project_type:mod", maxFileSize: maxMiB * 1024 * 1024, target, entries, errors }, null, 2))
console.log(JSON.stringify({ directory, downloaded: entries.length, errors: errors.length }))
