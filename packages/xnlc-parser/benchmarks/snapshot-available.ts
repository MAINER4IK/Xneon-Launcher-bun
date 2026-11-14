// Диагностический снимок незавершённой загрузки; пропуски перечисляются явно.
import { link, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { sha1File } from "../src"
const [sourceArg, targetArg] = process.argv.slice(2)
if (!sourceArg || !targetArg) throw new Error("Usage: bun snapshot-available.ts <source> <empty-target>")
const source = resolve(sourceArg), target = resolve(targetArg)
await mkdir(target, { recursive: true })
if ((await readdir(target)).length) throw new Error("Каталог снимка должен быть пустым")
await mkdir(join(target, "objects"))
const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8")) as { packs: { files: { hashes: { sha1?: string } }[]; overrides: { sha1: string }[] }[] }
const hashes = new Set(manifest.packs.flatMap(pack => [...pack.files.map(file => file.hashes.sha1), ...pack.overrides.map(file => file.sha1)]).filter((hash): hash is string => !!hash && /^[0-9a-f]{40}$/.test(hash)))
const available = new Set<string>(), missing: string[] = []
for (const hash of hashes) {
  const file = join(source, "objects", `${hash}.jar`)
  try {
    if (!(await stat(file)).isFile() || await sha1File(file) !== hash) throw new Error("missing or incomplete")
    await link(file, join(target, "objects", `${hash}.jar`)); available.add(hash)
  } catch { missing.push(hash) }
}
for (const pack of manifest.packs) {
  pack.files = pack.files.filter(file => file.hashes.sha1 && available.has(file.hashes.sha1))
  pack.overrides = pack.overrides.filter(file => available.has(file.sha1))
}
await writeFile(join(target, "manifest.json"), JSON.stringify(manifest))
await writeFile(join(target, "snapshot-report.json"), JSON.stringify({ source, available: available.size, missing }, null, 2))
console.log(JSON.stringify({ available: available.size, missing: missing.length }))
