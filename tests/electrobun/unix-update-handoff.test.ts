import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm, realpath, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { prepareUnixHelperFiles, waitForUnixHelperReady, readActiveUnixUpdate } from "../../electrobun/main/unix-update-handoff"

const nonce = "a".repeat(32)
async function fixture(action: (profile: string, runtime: string, helper: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "xneon-handoff-")))
  try {
    const profile = path.join(root, "profile"), runtime = path.join(root, "bun"), helper = path.join(root, "helper.js")
    await mkdir(profile); await writeFile(runtime, "runtime"); await writeFile(helper, "helper")
    await action(profile, runtime, helper)
  } finally { await rm(root, { recursive: true, force: true }) }
}
test("handoff копирует runtime/helper, создаёт приватное immutable job вне app", () => fixture(async (profile, runtime, helper) => {
  const files = await prepareUnixHelperFiles(profile, nonce, runtime, helper, { nonce })
  expect(await readFile(files.runtime, "utf8")).toBe("runtime")
  expect(await readFile(files.helper, "utf8")).toBe("helper")
  expect(JSON.parse(await readFile(files.job, "utf8"))).toEqual({ nonce })
  expect((await lstat(files.runtime)).ino).not.toBe((await lstat(runtime)).ino)
  await expect(prepareUnixHelperFiles(profile, nonce, runtime, helper, { nonce })).rejects.toThrow()
}))
test("symlink вместо private root отвергается до копирования", () => fixture(async (profile, runtime, helper) => {
  const cache = path.join(profile, "system-cache"), outside = path.join(profile, "outside")
  await mkdir(cache); await mkdir(outside)
  await symlink(outside, path.join(cache, "unix-update-helper"), process.platform === "win32" ? "junction" : "dir")
  await expect(prepareUnixHelperFiles(profile, nonce, runtime, helper, { nonce })).rejects.toThrow()
}))
test("ready требует точного nonce/PID и живого helper", () => fixture(async (profile, runtime, helper) => {
  const files = await prepareUnixHelperFiles(profile, nonce, runtime, helper, { nonce })
  await writeFile(files.ready, JSON.stringify({ schemaVersion: 1, nonce, pid: 321 }))
  expect(await waitForUnixHelperReady(files, 321, () => true)).toBeUndefined()
  await expect(waitForUnixHelperReady(files, 123, () => true)).rejects.toThrow()
  await expect(waitForUnixHelperReady(files, 321, () => false)).rejects.toThrow()
}))
test("отмена ожидания не разрешает закрыть A", () => fixture(async (profile, runtime, helper) => {
  const files = await prepareUnixHelperFiles(profile, nonce, runtime, helper, { nonce }), controller = new AbortController()
  controller.abort(new Error("restart-cancelled"))
  await expect(waitForUnixHelperReady(files, 321, () => true, controller.signal)).rejects.toThrow(/restart-cancelled/)
}))
test("active marker с потерянным job не превращается в отсутствие обновления", () => fixture(async (profile, runtime, helper) => {
  const files = await prepareUnixHelperFiles(profile, nonce, runtime, helper, { nonce })
  await writeFile(files.active, JSON.stringify({ schemaVersion: 1, nonce: "b".repeat(32) }), { mode: 0o600 })
  await expect(readActiveUnixUpdate(profile)).rejects.toThrow()
}))
