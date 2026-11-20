import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { stageTarUpdateRoot } from "../../scripts/package-linux"

test("Unix updater helper собирается отдельно без импорта окон/desktop SDK", async () => {
  const result = await Bun.build({ entrypoints: ["./electrobun/main/unix-update-helper.ts"], target: "bun", format: "cjs", write: false })
  expect(result.success).toBe(true)
  const text = await result.outputs[0].text()
  expect(text).toContain("Unknown update signing key or invalid signature envelope")
  expect(text).toContain("runUnixUpdateHelper")
  expect(text).not.toContain("class DesktopWindow")
  expect(text).not.toContain("XNLC_UPDATE_PRIVATE_KEY")
  expect(text).not.toContain("update-package-helper-not-configured")
  expect(text).toContain("installUnixPackage")
})

test("упаковывается отдельный executable helper entry, а не только библиотека", async () => {
  const bundle = await Bun.build({ entrypoints: ["./electrobun/main/unix-update-helper-entry.ts"], target: "bun", format: "cjs", write: false })
  expect(bundle.success).toBe(true)
  expect(await bundle.outputs[0].text()).toContain("runUnixUpdateHelper")
})

test("TAR marker добавляется только в отдельную TAR staging-копию", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xneon-tar-marker-")), original = path.join(root, "packages")
  try {
    await mkdir(path.join(original, "opt/xneon-launcher/Resources"), { recursive: true })
    await writeFile(path.join(original, "opt/xneon-launcher/Resources/version.json"), "fixture")
    const stage = await stageTarUpdateRoot(original)
    const marker = "opt/xneon-launcher/Resources/update-installation.json"
    expect(JSON.parse(await readFile(path.join(stage, marker), "utf8"))).toEqual({ schemaVersion: 1, identifier: "org.xneon.launcher", format: "tar-xz" })
    await expect(readFile(path.join(original, marker))).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
