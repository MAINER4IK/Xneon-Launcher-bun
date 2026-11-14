import { readFile, writeFile } from "node:fs/promises"
type Mod = { loader: string; id?: string; version?: string; jsonDigest?: string }
type Result = { mods: Mod[]; errors: string[]; fingerprint?: number }
type Scan = { mode: string; count: number; elapsedMs: number; maxRssKiB: number; packs: unknown[]; results: Record<string, Result> }
const [aPath, bPath, outPath] = process.argv.slice(2)
if (!aPath || !bPath || !outPath) throw new Error("Usage: bun xmcl-compare.ts <xnlc.json> <xmcl.json> <report.json>")
const a = JSON.parse(await readFile(aPath, "utf8")) as Scan, b = JSON.parse(await readFile(bPath, "utf8")) as Scan
const hashes = [...new Set([...Object.keys(a.results), ...Object.keys(b.results)])].sort()
const normalize = (mods: Mod[]) => mods.map(mod => ({ loader: mod.loader, id: mod.id || null, version: mod.version || null, jsonDigest: mod.jsonDigest ?? null })).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))
const mismatches = [], errors = []
for (const hash of hashes) {
  const x = a.results[hash], y = b.results[hash]
  if (!x || !y || x.fingerprint !== y.fingerprint || JSON.stringify(normalize(x.mods)) !== JSON.stringify(normalize(y.mods))) mismatches.push({ hash, xnlc: x?.mods, xmcl: y?.mods, xnlcFingerprint: x?.fingerprint, xmclFingerprint: y?.fingerprint })
  if (x?.errors.length || y?.errors.length) errors.push({ hash, xnlc: x?.errors ?? ["missing"], xmcl: y?.errors ?? ["missing"] })
}
const coverage = (scan: Scan) => ({ recognized: Object.values(scan.results).filter(result => result.mods.length > 0).length, withoutMetadata: Object.values(scan.results).filter(result => result.mods.length === 0).length, withErrors: Object.values(scan.results).filter(result => result.errors.length > 0).length })
const report = { xnlc: { count: a.count, elapsedMs: a.elapsedMs, maxRssKiB: a.maxRssKiB, packs: a.packs, coverage: coverage(a) }, xmcl: { count: b.count, elapsedMs: b.elapsedMs, maxRssKiB: b.maxRssKiB, packs: b.packs, coverage: coverage(b) }, unique: hashes.length, mismatches, errors }
await writeFile(outPath, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ unique: hashes.length, mismatches: mismatches.length, errors: errors.length, xnlc: report.xnlc.elapsedMs, xmcl: report.xmcl.elapsedMs }))
