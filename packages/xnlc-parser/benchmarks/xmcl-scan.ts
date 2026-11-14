// Сравнение metadata на одних и тех же файлах; полный ASM Forge измеряется отдельно.
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { createHash } from "node:crypto"

const [mode, rootArg, xmclArg, outputArg] = process.argv.slice(2)
if (!rootArg || !xmclArg || !outputArg || !["xnlc", "xmcl"].includes(mode)) throw new Error("Usage: bun xmcl-scan.ts <xnlc|xmcl> <dataset> <xmcl-node_modules> <output>")
const root = resolve(rootArg), xmclRoot = resolve(xmclArg), output = resolve(outputArg)
const require = createRequire(join(xmclRoot, "package.json"))
const xmcl = mode === "xmcl" ? require("@xmcl/mod-parser") : undefined
const system = mode === "xmcl" ? require("@xmcl/system") : undefined
const withHashes = process.env.XNLC_BENCH_HASHES === "1"
const xnlc = mode === "xnlc" || withHashes ? await import("../src") : undefined
type Ref = { path: string; hashes: { sha1?: string } }
type Pack = { slug: string; files: Ref[]; overrides: { path: string; sha1: string }[] }
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as { packs: Pack[] }
const packHashes = manifest.packs.map(pack => {
  const effective = new Map<string, string>()
  for (const file of pack.files) if (file.hashes.sha1 && /^[0-9a-f]{40}$/.test(file.hashes.sha1)) effective.set(file.path, file.hashes.sha1)
  for (const override of [...pack.overrides].sort((a, b) => Number(a.path.startsWith("client-overrides/")) - Number(b.path.startsWith("client-overrides/")))) {
    if (/^[0-9a-f]{40}$/.test(override.sha1)) effective.set(override.path.replace(/^(?:client-)?overrides\//, ""), override.sha1)
  }
  return { slug: pack.slug, hashes: [...effective.values()] }
})
const fullPacks = process.env.XNLC_BENCH_PACK_SCAN === "1"
const hashes = fullPacks ? packHashes.flatMap(pack => pack.hashes) : [...new Set(packHashes.flatMap(pack => pack.hashes))].sort()
type Item = { id?: string; version?: string; loader: string; jsonDigest?: string }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  return value
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex") }
const results: Record<string, { mods: Item[]; errors: string[]; formats?: string[]; fingerprint?: number }> = {}
const started = performance.now()
const packs: { slug: string; count: number; elapsedMs: number; errors: number }[] = []
const slowest: { hash: string; elapsedMs: number }[] = []
let packIndex = 0, packStart = started, packCount = 0, packErrors = 0
for (const [index, hash] of hashes.entries()) {
  if (process.env.XNLC_BENCH_TRACE === "1") console.error(`${mode}: файл ${index + 1}/${hashes.length} ${hash}`)
  while (fullPacks && packIndex < packHashes.length && packCount === packHashes[packIndex].hashes.length) {
    packs.push({ slug: packHashes[packIndex].slug, count: packCount, elapsedMs: performance.now() - packStart, errors: packErrors })
    packIndex++; packCount = 0; packErrors = 0; packStart = performance.now()
  }
  const path = join(root, "objects", `${hash}.jar`)
  const fileStart = performance.now()
  const mods: Item[] = [], errors: string[] = []
  try {
    if (mode === "xnlc") {
      const result = await xnlc!.analyze(path)
      for (const mod of result.mods) if (["fabric", "quilt", "forge", "neoforge", "liteloader"].includes(mod.loader)) mods.push({ id: mod.id, version: mod.version, loader: mod.loader, jsonDigest: mod.loader === "fabric" || mod.loader === "quilt" ? digest(mod.raw) : undefined })
      errors.push(...result.diagnostics.filter(item => item.code !== "METADATA_NOT_FOUND").map(item => `${item.code}: ${item.message}`))
      results[hash] = { mods, errors, formats: result.formats }
    } else {
      const fs = await system.openFileSystem(path)
      try {
        const run = async (name: string, fn: () => Promise<void>) => {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            if (process.versions.bun) await fn()
            else await Promise.race([fn(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("metadata timeout")), 5000) })])
          } catch (error) { errors.push(`${name}: ${String(error)}`) }
          finally { if (timer) clearTimeout(timer) }
        }
        if (await fs.existsFile("fabric.mod.json")) await run("fabric", async () => { const m = await xmcl.readFabricMod(fs); mods.push({ id: m.id, version: m.version, loader: "fabric", jsonDigest: digest(m) }) })
        if (await fs.existsFile("quilt.mod.json")) await run("quilt", async () => { const m = await xmcl.readQuiltMod(fs); mods.push({ id: m.quilt_loader?.id, version: m.quilt_loader?.version, loader: "quilt", jsonDigest: digest(m) }) })
        const manifestStore: Record<string, string> = {}
        if (await fs.existsFile("META-INF/mods.toml") || await fs.existsFile("META-INF/neoforge.mods.toml")) await run("manifest", async () => { await xmcl.readForgeModManifest(fs, manifestStore) })
        for (const [filename, loader] of [["mods.toml", "forge"], ["neoforge.mods.toml", "neoforge"]] as const) {
          if (await fs.existsFile(`META-INF/${filename}`)) await run(loader, async () => { for (const m of await xmcl.readForgeModToml(fs, manifestStore, filename)) mods.push({ id: m.modid || undefined, version: m.version, loader }) })
        }
        if (await fs.existsFile("mcmod.info") || await fs.existsFile("cccmod.info") || await fs.existsFile("neimod.info")) await run("legacy", async () => { for (const m of await xmcl.readForgeModJson(fs)) mods.push({ id: m.modid, version: m.version, loader: "forge" }) })
        if (await fs.existsFile("litemod.json")) await run("liteloader", async () => { const m = await xmcl.readLiteloaderMod(fs); mods.push({ id: m.name, version: m.version, loader: "liteloader" }) })
      } finally { fs.close() }
      results[hash] = { mods, errors }
    }
  } catch (error) { results[hash] = { mods, errors: [...errors, String(error)] } }
  if (withHashes && results[hash].errors.every(message => !message.includes("ENOENT"))) {
    try {
      if (await xnlc!.sha1File(path) !== hash) throw new Error("SHA-1 mismatch")
      results[hash].fingerprint = await xnlc!.curseforgeFingerprintFile(path)
    } catch (error) { results[hash].errors.push(`hash: ${String(error)}`) }
  }
  const duration = performance.now() - fileStart
  if (slowest.length < 30 || duration > slowest[slowest.length - 1].elapsedMs) {
    slowest.push({ hash, elapsedMs: duration }); slowest.sort((a, b) => b.elapsedMs - a.elapsedMs); slowest.length = Math.min(slowest.length, 30)
  }
  packCount++
  if (results[hash].errors.length) packErrors++
  if ((index + 1) % 200 === 0) console.error(`${mode}: ${index + 1}/${hashes.length}`)
}
if (fullPacks) while (packIndex < packHashes.length) {
  packs.push({ slug: packHashes[packIndex].slug, count: packCount, elapsedMs: performance.now() - packStart, errors: packErrors })
  packIndex++; packCount = 0; packErrors = 0; packStart = performance.now()
}
const elapsedMs = performance.now() - started, maxRssKiB = process.resourceUsage().maxRSS
await writeFile(output, JSON.stringify({ mode, fullPacks, withHashes, count: hashes.length, elapsedMs, maxRssKiB, packs, slowest, results }))
console.log(JSON.stringify({ mode, count: hashes.length, elapsedMs, maxRssKiB, failures: Object.values(results).filter(item => item.errors.length).length }))
