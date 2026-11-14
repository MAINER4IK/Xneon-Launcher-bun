import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const [rootArg, xmclArg, outArg, countArg] = process.argv.slice(2)
if (!rootArg || !xmclArg || !outArg) throw new Error("Usage: bun xmcl-repeat.ts <dataset> <xmcl-dir> <output-dir> [repetitions]")
const root = resolve(rootArg), xmcl = resolve(xmclArg), output = resolve(outArg), count = Number(countArg ?? 3)
if (!Number.isSafeInteger(count) || count < 1 || count > 30) throw new Error("Invalid repetitions")
await mkdir(output, { recursive: true })
const scanScript = join(import.meta.dir, "xmcl-scan.ts"), compareScript = join(import.meta.dir, "xmcl-compare.ts")
const runs: { iteration: number; mode: string; elapsedMs: number; wallMs: number; maxRssKiB: number; count: number }[] = []
for (let i = 0; i < count; i++) {
  for (const mode of i % 2 ? ["xmcl", "xnlc"] : ["xnlc", "xmcl"]) {
    const path = join(output, `${i + 1}-${mode}.json`)
    const executable = mode === "xmcl" && process.env.XMCL_NODE_EXECUTABLE ? process.env.XMCL_NODE_EXECUTABLE : process.execPath
    if (mode === "xmcl" && process.env.XMCL_NODE_EXECUTABLE && process.env.XNLC_BENCH_HASHES === "1") throw new Error("Общее Bun-хеширование нельзя использовать в Node")
    const wallStart = performance.now()
    const child = Bun.spawn([executable, scanScript, mode, root, xmcl, path], { env: { ...process.env, XNLC_BENCH_PACK_SCAN: "1" }, stdout: "pipe", stderr: "inherit" })
    const text = await new Response(child.stdout).text()
    if (await child.exited !== 0) throw new Error(`Ошибка ${mode} в повторе ${i + 1}`)
    const result = JSON.parse(text) as { elapsedMs: number; maxRssKiB: number; count: number }
    runs.push({ iteration: i + 1, mode, elapsedMs: result.elapsedMs, wallMs: performance.now() - wallStart, maxRssKiB: result.maxRssKiB, count: result.count })
    console.log(JSON.stringify(runs.at(-1)))
  }
  const compare = Bun.spawn([process.execPath, compareScript, join(output, `${i + 1}-xnlc.json`), join(output, `${i + 1}-xmcl.json`), join(output, `${i + 1}-compare.json`)], { stdout: "inherit", stderr: "inherit" })
  if (await compare.exited !== 0) throw new Error("Ошибка сравнения")
}
function median(values: number[]) { const sorted = values.toSorted((a, b) => a - b), mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2 }
const summary = ["xnlc", "xmcl"].map(mode => {
  const selected = runs.filter(run => run.mode === mode)
  return { mode, medianMs: median(selected.map(run => run.elapsedMs)), medianWallMs: median(selected.map(run => run.wallMs)), medianPeakRssKiB: median(selected.map(run => run.maxRssKiB)), maxPeakRssKiB: Math.max(...selected.map(run => run.maxRssKiB)) }
})
const comparisons = await Promise.all(Array.from({ length: count }, async (_, index) => {
  const result = JSON.parse(await readFile(join(output, `${index + 1}-compare.json`), "utf8"))
  return { iteration: index + 1, unique: result.unique, mismatches: result.mismatches.length, errors: result.errors.length }
}))
await writeFile(join(output, "summary.json"), JSON.stringify({ withHashes: process.env.XNLC_BENCH_HASHES === "1", xmclRuntime: process.env.XMCL_NODE_EXECUTABLE ?? "bun", repetitions: count, runs, summary, comparisons }, null, 2))
console.log(JSON.stringify({ summary, comparisons }))
