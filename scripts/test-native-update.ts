import assert from "node:assert/strict"
import { mock } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appIdentifier } from "../electrobun/main/app-identity"
import { nativeTarExecutable } from "./native-tar"

assert.equal(process.platform, "win32")
const repo = path.resolve(import.meta.dir, "..")
const [channel, childRoot] = process.argv.slice(2)
assert.ok(channel === "stable" || channel === "canary")
const prefix = channel + "-win-x64"
const temp = path.join(repo, ".tmp")
mkdirSync(temp, { recursive: true })
const root = childRoot ?? mkdtempSync(path.join(temp, "native-update-" + channel + "-"))
assert.match(path.relative(temp, root), /^native-update-(stable|canary)-[\w-]+$/)
const artifacts = path.join(repo, "release-electrobun", channel)
// Electrobun 2.0.7 читает канонические документы: манифест и отдельный checksum архива.
const manifest = JSON.parse(readFileSync(path.join(artifacts, prefix + "-update.json"), "utf8"))
const checksum = JSON.parse(readFileSync(path.join(artifacts, prefix + "-checksum.json"), "utf8"))
assert.equal(manifest.identifier, appIdentifier)
assert.equal(manifest.channel, channel)
assert.equal(manifest.artifact.file, path.basename(manifest.artifact.file))
assert.equal(checksum.hash, manifest.hash, "Checksum belongs to another build")
assert.match(checksum.tarSha256, /^[a-f0-9]{64}$/)
const archive = path.join(artifacts, manifest.artifact.file)
process.env.LOCALAPPDATA = path.join(root, "local")
process.env.APPDATA = path.join(root, "roaming")
process.env.TEMP = process.env.TMP = path.join(root, "temp")
mkdirSync(process.env.TEMP, { recursive: true })
const channelRoot = path.join(process.env.LOCALAPPDATA, manifest.identifier, channel)
const app = path.join(channelRoot, "app")
const bin = path.join(app, "bin")
if (!childRoot) {
  mkdirSync(app, { recursive: true })
  const extract = Bun.spawnSync([nativeTarExecutable(), "-xf", archive, "-C", app, "--strip-components", "1"])
  assert.equal(extract.exitCode, 0, extract.stderr.toString())
  const child = Bun.spawnSync([path.join(bin, "bun.exe"), import.meta.path, channel, root], {
    env: process.env, stdout: "inherit", stderr: "inherit",
  })
  process.exit(child.exitCode)
}

// Локальный сервер заменяет GitHub Releases на время проверки: SDK принимает только
// https или loopback http, поэтому 127.0.0.1 подходит. Канал задаёт само содержимое
// version.json — bridge с проекцией канала больше не нужен.
// Опубликованный feed не содержит -checksum.json (см. updateFeedFiles), и native core
// 2.0.7 в этом случае льёт полный архив: так проверяется штатная раскладка релиза.
// Порченый checksum подаётся отдельно, чтобы сохранить проверку ArchiveHashMismatch.
let mode: "bad-checksum" | "published" = "bad-checksum"
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const name = new URL(request.url).pathname.slice(1)
    if (name === prefix + "-update.json") return Response.json(manifest)
    if (name === prefix + "-checksum.json") {
      return mode === "bad-checksum"
        ? Response.json({ ...checksum, tarSha256: "0".repeat(64) })
        : new Response("Not found", { status: 404 })
    }
    if (name === manifest.artifact.file) return new Response(Bun.file(archive))
    return new Response("Not found", { status: 404 })
  },
})

try {
  const metadata = path.join(app, "Resources", "version.json")
  const local = JSON.parse(readFileSync(metadata, "utf8"))
  assert.equal(local.hash, manifest.hash)
  // Локальная версия старее выпущенной: манифест обязан пройти по каналу и быть новее.
  const source = { ...local, version: "1.0.7", hash: "0000000000001", baseUrl: server.url.href }
  writeFileSync(metadata, JSON.stringify(source))
  // Изолируем интерфейс завершения процесса. Проверка и нативная подготовка
  // архива идут через настоящий SDK и бинарный helper.
  mock.module(path.join(repo, ".hutch/devkit/api/sdks/main/core/Utils.ts"), () => ({
    requestQuitApproval: () => null,
    quitAfterApproval: () => { throw new Error("Unexpected native quit") },
    cancelQuitApproval: () => {},
  }))
  process.chdir(bin)
  const { Updater } = await import("../.hutch/devkit/api/sdks/main/core/Updater.ts")
  Updater.onStatusChange(({ status, message }) => console.log(channel, status, message))
  // Сначала подпорченный digest архива: нативный core обязан отклонить загрузку.
  assert.equal((await Updater.checkForUpdate()).updateAvailable, true)
  await Updater.downloadUpdate()
  assert.equal(Updater.updateInfo().updateReady, false)
  assert.match(Updater.updateInfo().error, /ArchiveHashMismatch/)
  // Штатная раскладка релиза: тот же канал, checksum отсутствует, подготовка до ready.
  mode = "published"
  assert.equal((await Updater.checkForUpdate()).updateAvailable, true)
  await Updater.downloadUpdate()
  assert.equal(Updater.updateInfo().updateReady, true, Updater.updateInfo().error)
  assert.deepEqual(JSON.parse(readFileSync(metadata, "utf8")), source)
  // 2.0.7 публикует запись подготовки в <channelRoot>/self-extraction — именно её
  // читает electrobun/main/update-state.ts после перезапуска.
  const preparedFile = path.join(channelRoot, "self-extraction", ".electrobun-prepared-update.json")
  assert.ok(existsSync(preparedFile), "SDK did not publish the prepared-update record")
  const prepared = JSON.parse(readFileSync(preparedFile, "utf8"))
  for (const key of ["identifier", "channel", "version", "hash", "platform", "arch"]) {
    assert.equal(prepared[key], manifest[key], "Prepared record differs from the manifest in " + key)
  }
  assert.equal(prepared.artifact_file, manifest.artifact.file)
  console.log("Native update prepared without replacing the source installation:", root)
} finally {
  server.stop(true)
}