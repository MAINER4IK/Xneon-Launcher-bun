import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { test } from "bun:test"
import { selectUpdateTag, serveVerifiedUpdate, stageVerifiedArchive } from "../../electrobun/main/verified-update-feed.ts"

test("Stable ignores pre-releases and Beta selects the highest newer version", () => {
  const releases = ["v1.0.8-pre3", "v1.0.8", "v1.0.9-pre1", "v1.0.7"].map(tag_name => ({ tag_name, draft: false, prerelease: tag_name.includes("-pre") }))
  assert.equal(selectUpdateTag(releases, "1.0.8-pre2", "stable"), "1.0.8")
  assert.equal(selectUpdateTag(releases, "1.0.8", "beta"), "1.0.9-pre1")
  assert.equal(selectUpdateTag(releases, "1.0.9-pre1", "stable"), null)
  assert.equal(selectUpdateTag([{ ...releases[2], draft: true }], "1.0.8", "beta"), null)
})

test("stage checks signed compressed bytes and the bridge serves only that file", async () => {
  const bytes = Buffer.from("fixture")
  const root = path.resolve(".tmp")
  await mkdir(root, { recursive: true })
  const temp = await mkdtemp(path.join(root, "verified-feed-"))
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/redirect") return Response.redirect("https://example.invalid/")
      return new Response(bytes)
    },
  })
  const artifact = {
    file: "stable-win-x64-XneonLauncher.tar.zst",
    downloadSize: bytes.length,
    downloadSha256: createHash("sha256").update(bytes).digest("hex"),
  }
  const update = { manifest: { channel: "stable", artifact }, archiveUrl: server.url.href }
  const signal = AbortSignal.timeout(5000)
  try {
    await assert.rejects(stageVerifiedArchive({ ...update, archiveUrl: new URL("redirect", server.url).href }, temp, signal, () => {}), /outside GitHub/)
    await assert.rejects(stageVerifiedArchive({ ...update, manifest: { channel: "stable", artifact: { ...artifact, downloadSha256: "0".repeat(64) } } }, temp, signal, () => {}), /signed metadata/)
    await assert.rejects(stageVerifiedArchive({ ...update, manifest: { channel: "stable", artifact: { ...artifact, downloadSize: 1 } } }, temp, signal, () => {}), /signed size/)
    await assert.rejects(stageVerifiedArchive(update, temp, AbortSignal.abort(), () => {}))
    assert.deepEqual(await readdir(temp), [])
    const staged = await stageVerifiedArchive(update, temp, signal, () => {})
    const bridge = serveVerifiedUpdate(update, staged.file)
    try {
      const response = await fetch(bridge.baseUrl + artifact.file)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
      assert.equal((await fetch(bridge.baseUrl + "stable-win-x64-update.json")).status, 404)
      assert.equal((await fetch(new URL(artifact.file, new URL(bridge.baseUrl).origin))).status, 404)
    } finally { bridge.stop(); await staged.dispose() }
  } finally { server.stop(true); await rm(temp, { recursive: true, force: true }) }
})
