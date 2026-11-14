// Снимок популярных Modrinth-сборок: сначала индексы, затем содержимое по SHA-1.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { ArchiveContext } from "../src"

const directory = resolve(process.argv[2] ?? "")
const action = process.argv[3] ?? "index"
if (!process.argv[2] || !["index", "download"].includes(action)) throw new Error("Usage: bun modpacks-50.ts <directory> [index|download]")
await mkdir(directory, { recursive: true })
const headers = { "User-Agent": "XneonLauncher-parser-benchmark/0.1 (https://launcher.xneon.org)" }
async function get(url: string, timeoutMs = 30000): Promise<Response> {
  let error: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
      if (response.ok) return response
      if (response.status !== 429 && response.status < 500) throw new Error(`HTTP ${response.status}: ${url}`)
      error = new Error(`HTTP ${response.status}: ${url}`)
    } catch (e) { error = e }
    await Bun.sleep(1000 * 2 ** attempt)
  }
  throw error
}
async function downloadFile(url: string, expectedSize: number): Promise<Uint8Array> {
  if (expectedSize >= 16 * 1024 * 1024 && expectedSize <= 512 * 1024 * 1024) {
    // Диапазоны ограничивают время больших скачиваний при медленном CDN.
    const chunkSize = 8 * 1024 * 1024, count = Math.ceil(expectedSize / chunkSize)
    const output = new Uint8Array(expectedSize)
    let cursor = 0
    try {
      await Promise.all(Array.from({ length: Math.min(4, count) }, async () => {
        while (true) {
          const index = cursor++
          if (index >= count) break
          const start = index * chunkSize, end = Math.min(expectedSize, start + chunkSize) - 1
          const response = await fetch(url, { headers: { ...headers, Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(240000) })
          if (response.status !== 206 || response.headers.get("content-range") !== `bytes ${start}-${end}/${expectedSize}`) throw new Error("CDN не подтвердил диапазон и размер")
          const data = new Uint8Array(await response.arrayBuffer())
          if (data.length !== end - start + 1) throw new Error("Неполный диапазон")
          output.set(data, start)
        }
      }))
      return output
    } catch { /* Зеркало может не поддерживать Range или содержать неверный fileSize. */ }
  }
  const timeout = Math.min(900000, 90000 + Math.ceil(expectedSize / (128 * 1024)) * 1000)
  return new Uint8Array(await (await get(url, timeout)).arrayBuffer())
}
type Ref = { path: string; hashes: { sha1?: string }; downloads: string[]; fileSize: number; env?: { client?: string } }
type Pack = { rank: number; projectId: string; slug: string; title: string; downloads: number; versionId: string; version: string; archive: string; sha1: string; files: Ref[]; overrides: { path: string; sha1: string; size: number }[] }
type Index = { createdAt: string; source: string; packs: Pack[]; errors: { slug: string; message: string }[] }
const validHash = (value: string | undefined): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value)
const manifestPath = join(directory, "manifest.json")
if (action === "index") {
  const facets = encodeURIComponent(JSON.stringify([["project_type:modpack"]]))
  const search = await (await get(`https://api.modrinth.com/v2/search?index=downloads&limit=100&facets=${facets}`)).json() as { hits: { project_id: string; slug: string; title: string; downloads: number }[] }
  const previous = await readFile(manifestPath, "utf8").then(text => JSON.parse(text) as Index).catch(() => undefined)
  const packs: Pack[] = previous?.packs ?? [], errors: Index["errors"] = previous?.errors ?? []
  await mkdir(join(directory, "packs"), { recursive: true })
  await mkdir(join(directory, "objects"), { recursive: true })
  let next = packs.length ? Math.max(...packs.map(pack => pack.rank)) : 0
  while (packs.length < 50 && next < search.hits.length) {
    const batch = search.hits.slice(next, next + Math.min(5, 50 - packs.length))
    next += batch.length
    const results = await Promise.all(batch.map(async hit => {
    try {
      const versions = await (await get(`https://api.modrinth.com/v2/project/${hit.project_id}/version`)).json() as { id: string; version_number: string; version_type: string; files: { url: string; filename: string; primary: boolean; hashes: { sha1: string } }[] }[]
      const version = versions.find(v => v.version_type === "release" && v.files.some(f => f.filename.endsWith(".mrpack"))) ?? versions.find(v => v.files.some(f => f.filename.endsWith(".mrpack")))
      const file = version?.files.find(f => f.primary && f.filename.endsWith(".mrpack")) ?? version?.files.find(f => f.filename.endsWith(".mrpack"))
      if (!version || !file) throw new Error("Нет версии .mrpack")
      if (!validHash(file.hashes.sha1)) throw new Error("Некорректный SHA-1 архива")
      const response = await get(file.url, 600000)
      if (Number(response.headers.get("content-length")) > 512 * 1024 * 1024) throw new Error("Слишком большой архив сборки")
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.length > 512 * 1024 * 1024) throw new Error("Слишком большой архив сборки")
      if (new Bun.CryptoHasher("sha1").update(bytes).digest("hex") !== file.hashes.sha1) throw new Error("SHA-1 архива не совпадает")
      await writeFile(join(directory, "packs", `${file.hashes.sha1}.mrpack`), bytes)
      const zip = await ArchiveContext.open(bytes, { limits: { maxEntrySize: 256 * 1024 * 1024, maxTotalUncompressedSize: 512 * 1024 * 1024 } })
      if (!zip.get("modrinth.index.json")) throw new Error("Нет modrinth.index.json")
      const index = JSON.parse(new TextDecoder().decode(await zip.read("modrinth.index.json", 8 * 1024 * 1024))) as { files: Ref[] }
      const files = index.files.filter(item => /^mods\/.+\.(jar|litemod)$/i.test(item.path) && item.env?.client !== "unsupported")
      const overrides: Pack["overrides"] = []
      for (const entry of zip.entries()) {
        if (!/^(?:client-)?overrides\/mods\/.+\.(jar|litemod)$/i.test(entry.name)) continue
        const data = await zip.read(entry.name), sha1 = new Bun.CryptoHasher("sha1").update(data).digest("hex")
        await writeFile(join(directory, "objects", `${sha1}.jar`), data)
        overrides.push({ path: entry.name, sha1, size: data.length })
      }
      zip.close()
      return { pack: { rank: search.hits.indexOf(hit) + 1, projectId: hit.project_id, slug: hit.slug, title: hit.title, downloads: hit.downloads, versionId: version.id, version: version.version_number, archive: file.url, sha1: file.hashes.sha1, files, overrides } satisfies Pack }
    } catch (e) { return { error: { slug: hit.slug, message: String(e) } } }
    }))
    for (const result of results) {
      if (result.pack) { packs.push(result.pack); console.log(`${packs.length}/50 ${result.pack.slug}: ${result.pack.files.length} ссылок, ${result.pack.overrides.length} overrides`) }
      else if (result.error) { errors.push(result.error); console.error(result.error) }
    }
    await writeFile(manifestPath, JSON.stringify({ createdAt: previous?.createdAt ?? new Date().toISOString(), source: "Modrinth search, project_type:modpack, index:downloads; latest release", packs, errors }, null, 2))
  }
  const unique = new Map<string, number>()
  for (const pack of packs) for (const file of pack.files) if (validHash(file.hashes.sha1)) unique.set(file.hashes.sha1, file.fileSize)
  console.log(JSON.stringify({ packs: packs.length, references: packs.reduce((n, p) => n + p.files.length, 0), unique: unique.size, uniqueBytes: [...unique.values()].reduce((a, b) => a + b, 0), errors }))
  if (packs.length !== 50) process.exitCode = 1
} else {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Index
  const refs = new Map<string, Ref>()
  for (const pack of manifest.packs) for (const file of pack.files) if (validHash(file.hashes.sha1)) refs.set(file.hashes.sha1, file)
  // Крупные файлы загружаются в конце: медленный CDN не задерживает тысячи небольших модов.
  const entries = [...refs].sort((a, b) => a[1].fileSize - b[1].fileSize), errors: { sha1: string; message: string }[] = [], sizeMismatches: { sha1: string; declared: number; actual: number }[] = []
  let cursor = 0, downloaded = 0, reused = 0
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (true) {
      const index = cursor++
      if (index >= entries.length) break
      const [hash, ref] = entries[index], target = join(directory, "objects", `${hash}.jar`)
      try {
        const existing = await stat(target).catch(() => null)
        if (existing && new Bun.CryptoHasher("sha1").update(await Bun.file(target).arrayBuffer()).digest("hex") === hash) {
          if (existing.size !== ref.fileSize) sizeMismatches.push({ sha1: hash, declared: ref.fileSize, actual: existing.size })
          reused++; continue
        }
        let bytes: Uint8Array | undefined, lastError: unknown
        for (const url of ref.downloads) {
          try {
            const data = await downloadFile(url, ref.fileSize)
            if (new Bun.CryptoHasher("sha1").update(data).digest("hex") !== hash) throw new Error("SHA-1 не совпадает")
            if (data.length !== ref.fileSize) sizeMismatches.push({ sha1: hash, declared: ref.fileSize, actual: data.length })
            bytes = data; break
          } catch (e) { lastError = e }
        }
        if (!bytes) throw lastError ?? new Error("Нет доступной ссылки")
        await writeFile(target, bytes); downloaded++
      } catch (e) { errors.push({ sha1: hash, message: String(e) }); console.error(`Ошибка ${hash}: ${String(e)}`) }
      if ((index + 1) % 100 === 0) console.log(`${index + 1}/${entries.length}; скачано ${downloaded}; ошибок ${errors.length}`)
    }
  }))
  await writeFile(join(directory, "download-report.json"), JSON.stringify({ completedAt: new Date().toISOString(), expected: entries.length, downloaded, reused, errors, sizeMismatches }, null, 2))
  console.log(JSON.stringify({ expected: entries.length, downloaded, reused, errors: errors.length, sizeMismatches: sizeMismatches.length }))
  if (errors.length) process.exitCode = 1
}
