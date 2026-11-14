// Диагностический профиль этапов на зафиксированном наборе; времена этапов не суммируются как один прогон.
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { ArchiveContext, ParserCache, ParserWorker, analyze, assessDependency, curseforgeFingerprintFile, sha1File } from "../src"

const [rootArg, outputArg, countArg] = process.argv.slice(2)
if (!rootArg || !outputArg) throw new Error("Usage: bun profile-package.ts <dataset> <output> [count]")
const root = resolve(rootArg), count = Number(countArg ?? 30)
if (!Number.isSafeInteger(count) || count < 1 || count > 200) throw new Error("Invalid count")
type Pack = { files: { path: string; hashes: { sha1?: string } }[]; overrides: { sha1: string }[] }
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as { packs: Pack[] }
const hashes = [...new Set(manifest.packs.flatMap(pack => [...pack.files.map(file => file.hashes.sha1), ...pack.overrides.map(file => file.sha1)]).filter((hash): hash is string => !!hash))].slice(0, count)
const files = hashes.map(hash => join(root, "objects", `${hash}.jar`))
const phases: Record<string, number> = {}
const measure = async (name: string, fn: () => Promise<void>) => { const start = performance.now(); await fn(); phases[name] = performance.now() - start }
const metadataEntries = ["fabric.mod.json", "quilt.mod.json", "META-INF/mods.toml", "META-INF/neoforge.mods.toml", "mcmod.info", "litemod.json"]
await measure("zip_index_ms", async () => { for (const path of files) { const archive = await ArchiveContext.open(path); archive.close() } })
await measure("zip_open_and_metadata_read_ms", async () => { for (const path of files) { const archive = await ArchiveContext.open(path); try { for (const name of metadataEntries) if (archive.get(name)) await archive.read(name, archive.limits.maxMetadataSize).catch(() => {}) } finally { archive.close() } } })
const parsed = []
await measure("analyze_ms", async () => { for (const path of files) parsed.push(await analyze(path)) })
let assessed = 0
await measure("dependency_assessment_ms", async () => { for (const result of parsed) for (const dependency of result.dependencies) { assessDependency(dependency, { mods: [], complete: false }); assessed++ } })
await measure("sha1_ms", async () => { for (const path of files) await sha1File(path) })
await measure("curseforge_ms", async () => { for (const path of files) await curseforgeFingerprintFile(path) })
const sample = files.slice(0, Math.min(10, files.length))
await measure("nested_analyze_ms", async () => { for (const path of sample) await analyze(path, { nested: true }) })
const cache = new ParserCache(sample.length)
await measure("cache_cold_ms", async () => { for (const path of sample) await cache.analyze(path) })
await measure("cache_hit_ms", async () => { for (const path of sample) await cache.analyze(path) })
const worker = new ParserWorker(1)
try { await measure("worker_analyze_ms", async () => { for (const path of sample) await worker.analyze(path) }) } finally { await worker.close() }
const crcBuffer = new Uint8Array(1024 * 1024).map((_, index) => index & 255)
await measure("crc32_1mib_100x_ms", async () => { for (let i = 0; i < 100; i++) Bun.hash.crc32(crcBuffer) })
const result = { count: files.length, sampleCount: sample.length, hashes, assessed, phases, maxRssKiB: process.resourceUsage().maxRSS, note: "Последовательный диагностический профиль; ZIP read включает индекс, ввод-вывод, DEFLATE и CRC. Кэш ОС и внешняя нагрузка не контролируются." }
await writeFile(outputArg, JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
