import { expect, test } from "bun:test"
import { createHash, generateKeyPairSync } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { generateUpdateFeed, signUpdateFeed, verifyUpdateFeed } from "../../scripts/update-feed"
import {
  compatibilityManifestFileName, manifestFileName, nativeArchiveName, unixDistributionName, unixDistributions,
  verifySignedUpdateManifest, type UpdateTarget,
} from "../../electrobun/main/update-manifest"

const macTarget: UpdateTarget = { platform: "macos", arch: "arm64", channel: "stable" }
const linuxTarget: UpdateTarget = { platform: "linux", arch: "x64", channel: "stable" }
const winTarget: UpdateTarget = { platform: "win", arch: "x64", channel: "stable" }
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex")

function tar(files: Array<[string, Buffer]>) {
  const blocks: Buffer[] = []
  for (const [name, bytes] of files) {
    const header = Buffer.alloc(512); header.write(name); header.write("0000755\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116)
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124); header.fill(32, 148, 156); header.write("0", 156); header.write("ustar\0", 257)
    header.write(header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, "0") + "\0 ", 148)
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)])
}

function nativeBinary(platform: UpdateTarget["platform"]) {
  if (platform === "win") {
    const bytes = Buffer.alloc(256); bytes.write("MZ"); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68)
    return bytes
  }
  const binary = Buffer.alloc(64)
  if (platform === "linux") { binary.write("\x7fELF"); binary[4] = 2; binary[5] = 1; binary.writeUInt16LE(62, 18) }
  else { binary.writeUInt32LE(0xfeedfacf); binary.writeUInt32LE(0x0100000c, 4) }
  return binary
}

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  return { privateKey, keys: { fixture: publicKey.export({ format: "pem", type: "spki" }).toString() } }
}

async function nativeFixture(root: string, target: UpdateTarget, version: string) {
  const input = path.join(root, "native"); await mkdir(input, { recursive: true })
  const binary = nativeBinary(target.platform)
  const app = target.platform === "macos" ? "Xneon Launcher.app" : "XneonLauncher"
  const resources = `${app}/${target.platform === "macos" ? "Contents/Resources" : "Resources"}`
  const bin = `${app}/${target.platform === "macos" ? "Contents/MacOS" : "bin"}`
  const ext = target.platform === "win" ? ".exe" : ""
  const local = { schemaVersion: 1, identifier: "org.xneon.launcher", ...target, version, hash: "fixture123" }
  const entries: Array<[string, Buffer]> = [
    [`${bin}/bun${ext}`, binary], [`${bin}/launcher${ext}`, binary],
    [`${resources}/version.json`, Buffer.from(JSON.stringify(local))],
  ]
  if (target.platform !== "win") entries.push([`${resources}/app/bun/workers/unix-update-helper.js`, Buffer.from("fixture-helper")])
  if (target.platform === "macos") entries.push([`${app}/Contents/Info.plist`, Buffer.from("<plist><dict><key>CFBundleIdentifier</key><string>org.xneon.launcher</string></dict></plist>")])
  const bytes = tar(entries), archive = nativeArchiveName(target)
  await writeFile(path.join(input, archive), Bun.zstdCompressSync(bytes))
  await writeFile(path.join(input, compatibilityManifestFileName(target)),
    JSON.stringify({ ...local, artifact: { file: archive, tarSize: bytes.length, tarSha256: hash(bytes) } }))
  if (target.platform === "win") await writeFile(path.join(input, `xneon-launcher-${version}-win-x64.exe`), Buffer.alloc(1024 ** 2 + 16))
  if (target.platform !== "linux") return { input, packages: undefined }
  const packages = path.join(root, "distributions"); await mkdir(packages)
  for (const format of unixDistributions) {
    const data = Buffer.alloc(128)
    if (format === "deb") data.write("!<arch>\ndebian-binary")
    else if (format === "rpm") data.writeUInt32BE(0xedabeedb)
    else if (format === "pacman") data.writeUInt32BE(0x28b52ffd)
    else if (format === "appimage") { nativeBinary("linux").copy(data); data.write("AI\x02", 8) }
    else Buffer.from("fd377a585a00", "hex").copy(data)
    await writeFile(path.join(packages, unixDistributionName(version, format)), data)
  }
  return { input, packages }
}

async function fixture<T>(target: UpdateTarget, version: string, action: (root: string, input: string, packages: string | undefined) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xneon-feed-"))
  try {
    const { input, packages } = await nativeFixture(root, target, version)
    return await action(root, input, packages)
  } finally { await rm(root, { recursive: true, force: true }) }
}

test("Manifest v1 macOS: обе копии байт-идентичны, native v2 не изменяется", async () => await fixture(macTarget, "1.0.8", async (root, input) => {
  const before = await readFile(path.join(input, compatibilityManifestFileName(macTarget)))
  const manifest = await generateUpdateFeed(input, undefined, macTarget, "1.0.8")
  expect(manifest.schemaVersion).toBe(1)
  expect(manifest.distributions).toBeUndefined()
  const { privateKey, keys } = keypair(), output = path.join(root, "signed")
  await signUpdateFeed(input, undefined, output, macTarget, "1.0.8", "fixture", privateKey, keys)
  const verified = await verifyUpdateFeed(output, macTarget, "1.0.8", keys)
  expect(verified.manifest.hash).toBe("fixture123")
  expect(await readFile(path.join(output, manifestFileName(macTarget)))).toEqual(await readFile(path.join(output, compatibilityManifestFileName(macTarget))))
  expect(await readFile(path.join(input, compatibilityManifestFileName(macTarget)))).toEqual(before)
  const file = path.join(output, manifestFileName(macTarget))
  await writeFile(file, (await readFile(file, "utf8")).replace("fixture123", "tampered12"))
  await expect(verifyUpdateFeed(output, macTarget, "1.0.8", keys)).rejects.toThrow()
}))

test("Manifest v1 Windows: установщик входит в подпись, v2-алиас совместим", async () => await fixture(winTarget, "1.0.8", async (root, input) => {
  const { privateKey, keys } = keypair(), output = path.join(root, "signed")
  const signed = await signUpdateFeed(input, undefined, output, winTarget, "1.0.8", "fixture", privateKey, keys)
  expect(signed.installer?.file).toBe("xneon-launcher-1.0.8-win-x64.exe")
  const document = JSON.parse(await readFile(path.join(output, compatibilityManifestFileName(winTarget)), "utf8"))
  expect(document.schemaVersion).toBe(1)
  expect(document.installer.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(document.artifact.tarSha256).toMatch(/^[a-f0-9]{64}$/)
  await writeFile(path.join(output, signed.installer!.file), Buffer.alloc(1024 ** 2 + 16, 1))
  await expect(verifyUpdateFeed(output, winTarget, "1.0.8", keys)).rejects.toThrow()
}))

test("Manifest v1 Linux: пять distributions связаны с подписью", async () => await fixture(linuxTarget, "1.0.8", async (root, input, packages) => {
  const { privateKey, keys } = keypair(), output = path.join(root, "signed")
  const signed = await signUpdateFeed(input, packages, output, linuxTarget, "1.0.8", "fixture", privateKey, keys)
  expect(Object.keys(signed.distributions ?? {}).sort()).toEqual([...unixDistributions].sort())
  await writeFile(path.join(output, signed.distributions!.deb!.file), "tampered")
  await expect(verifyUpdateFeed(output, linuxTarget, "1.0.8", keys)).rejects.toThrow()
  await rm(path.join(packages!, signed.distributions!.rpm!.file))
  await expect(generateUpdateFeed(input, packages, linuxTarget, "1.0.8")).rejects.toThrow()
}))

test("одна схема и один ключ: чужая платформа и чужая подпись отвергаются", async () => await fixture(macTarget, "1.0.8", async (root, input) => {
  const { privateKey, keys } = keypair(), output = path.join(root, "signed")
  await signUpdateFeed(input, undefined, output, macTarget, "1.0.8", "fixture", privateKey, keys)
  const bytes = await readFile(path.join(output, manifestFileName(macTarget))), signature = await readFile(path.join(output, manifestFileName(macTarget) + ".sig"))
  await expect(verifyUpdateFeed(output, winTarget, "1.0.8", keys)).rejects.toThrow()
  expect(() => verifySignedUpdateManifest(bytes, signature, keypair().keys, macTarget)).toThrow(/signature/)
  expect(() => verifySignedUpdateManifest(Buffer.from(bytes.toString().replace("fixture123", "evil12345")), signature, keys, macTarget)).toThrow(/signature/)
}))

test("несовпадение версии, канала и архитектуры блокирует подготовку", async () => await fixture(macTarget, "1.0.8", async (_root, input) => {
  await expect(generateUpdateFeed(input, undefined, macTarget, "1.0.9")).rejects.toThrow()
  await expect(generateUpdateFeed(input, undefined, { ...macTarget, arch: "x64" as "arm64" }, "1.0.8")).rejects.toThrow()
}))