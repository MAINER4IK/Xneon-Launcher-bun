// В registry опубликованы manifests с workspace:^* и исходным main=index.ts.
// Исправляются только manifests во временном каталоге; код dist не изменяется.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

if (!process.argv[2]) throw new Error("Usage: bun setup-xmcl.ts <isolated-directory>")
const root = resolve(process.argv[2])
await mkdir(root, { recursive: true })
if ((await readdir(root)).length) throw new Error("Каталог для XMCL должен быть пустым")
const lock = await readFile(join(import.meta.dir, "xmcl-npm-lock.json"))
const lockData = JSON.parse(lock.toString()) as { packages: { "": { dependencies: Record<string, string> } } }
await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: lockData.packages[""].dependencies }, null, 2))
await writeFile(join(root, "package-lock.json"), lock)
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const install = Bun.spawn([npm, "ci", "--prefix", root, "--ignore-scripts", "--no-audit", "--no-fund"], { stdout: "inherit", stderr: "inherit" })
if (await install.exited !== 0) throw new Error("Не удалось установить сторонние зависимости XMCL")
const packages = [["mod-parser", "3.4.3"], ["system", "2.3.0"], ["asm", "1.0.1"], ["unzip", "2.2.0"], ["yauzl", "2.10.0"]] as const
const provenance = []
for (const [name, version] of packages) {
  const metadata = await fetch(`https://registry.npmjs.org/@xmcl%2f${name}/${version}`).then(response => {
    if (!response.ok) throw new Error(`Registry HTTP ${response.status}`)
    return response.json()
  }) as { dist: { tarball: string; integrity: string } }
  const response = await fetch(metadata.dist.tarball)
  if (!response.ok) throw new Error(`Package HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`
  if (integrity !== metadata.dist.integrity) throw new Error(`Integrity mismatch: ${name}`)
  const archive = join(root, `${name}-${version}.tgz`), target = join(root, "node_modules", "@xmcl", name)
  await writeFile(archive, bytes); await mkdir(target, { recursive: true })
  const tar = Bun.spawn(["tar", "-xzf", archive, "-C", target, "--strip-components=1"], { stderr: "inherit" })
  if (await tar.exited !== 0) throw new Error(`Не удалось распаковать ${name}`)
  const path = join(target, "package.json"), data = JSON.parse(await readFile(path, "utf8"))
  if (data.main === "./index.ts") { data.main = "./dist/index.js"; await writeFile(path, JSON.stringify(data, null, 2)) }
  provenance.push({ name: `@xmcl/${name}`, version, tarball: metadata.dist.tarball, integrity })
}
await writeFile(join(root, "provenance.json"), JSON.stringify({ packages: provenance, manifestChanges: "main ./index.ts → ./dist/index.js where necessary; dist code unchanged" }, null, 2))
console.log(JSON.stringify({ root, packages: provenance.length }))
