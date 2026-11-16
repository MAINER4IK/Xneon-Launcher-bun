// Проверки подсистемы: describe изолируют fixtures и хуки; runtime не подменяется общим состоянием.
import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm, readFile } from "node:fs/promises"
import path from "node:path"
import { describe, test } from "bun:test"
import { selectUpdateTag, serveVerifiedUpdate, stageVerifiedArchive } from "../../electrobun/main/verified-update-feed.ts"
import { verifySignedWindowsUpdateManifest, verifyWindowsUpdateManifest } from "../../electrobun/main/verified-update-manifest.ts"
import { appIdentifier } from "../../electrobun/main/app-identity.ts"
import nodeTest from "node:test"
import vm from "node:vm"
import { OperationGate, withinDeadline } from "../../electrobun/platform/operation-gate.ts"
import { ShutdownCoordinator } from "../../electrobun/platform/shutdown.ts"

{
  describe("verified-update-feed", () => {
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
  })
}

{
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const manifest = {
    schemaVersion: 1, identifier: appIdentifier, channel: "stable",
    version: "1.0.8", hash: "abc123", platform: "win", arch: "x64",
    artifact: { file: "stable-win-x64-XneonLauncher.tar.zst", tarSha256: "a".repeat(64), tarSize: 1000, downloadSha256: "b".repeat(64), downloadSize: 500 },
  }

  function verifyManifest(patch = {}, installed = "1.0.8-pre2", preference = "stable") {
    const bytes = Buffer.from(JSON.stringify({ ...manifest, ...patch }))
    return verifyWindowsUpdateManifest(bytes, sign(null, bytes, privateKey), publicKey, installed, "stable", preference)
  }
  describe("verified-update-manifest", () => {
    test("stable and beta apply version policy without changing the installed channel", () => {
      assert.equal(verifyManifest().version, "1.0.8")
      assert.equal(verifyManifest({ version: "1.0.8-pre3" }, "1.0.8-pre2", "canary").version, "1.0.8-pre3")
      assert.throws(() => verifyManifest({ version: "1.0.8-pre3" }), /stable version/)
      assert.throws(() => verifyManifest({ version: "1.0.8-pre1" }), /newer/)
      assert.throws(() => verifyManifest({}, "1.0.8"), /newer/)
      assert.throws(() => verifyManifest({ channel: "canary" }), /installed package/)
    })

    test("legacy identifier is rejected", () => {
      assert.throws(() => verifyManifest({ identifier: "com.xneonlauncher.app" }), /installed package/)
    })

    test("signature and archive integrity fields are required", () => {
      const original = Buffer.from(JSON.stringify(manifest))
      const changed = Buffer.from(JSON.stringify({ ...manifest, version: "1.0.9" }))
      assert.throws(() => verifyWindowsUpdateManifest(changed, sign(null, original, privateKey), publicKey, "1.0.8", "stable", "stable"), /signature/)
      assert.throws(() => verifyManifest({ artifact: { file: manifest.artifact.file } }), /artifact metadata/)
    })

    test("only a trusted key ID with its own valid signature is accepted", () => {
      const bytes = Buffer.from(JSON.stringify(manifest))
      const other = generateKeyPairSync("ed25519")
      const trusted = { current: publicKey.export({ type: "spki", format: "pem" }) }
      const envelope = (keyId, key) => Buffer.from(JSON.stringify({ keyId, signature: sign(null, bytes, key).toString("base64") }))
      const check = value => verifySignedWindowsUpdateManifest(bytes, value, trusted, "1.0.8-pre2", "stable", "stable")
      assert.equal(check(envelope("current", privateKey)).version, "1.0.8")
      assert.throws(() => check(envelope("unknown", privateKey)), /Unknown update signing key/)
      assert.throws(() => check(envelope("current", other.privateKey)), /manifest signature/)
    })
  })
}

{
  const test = nodeTest
  const source = await readFile(new URL("../../dist-electrobun-tests/main/updater.js", import.meta.url), "utf8")

  function fixture(overrides = {}, cleanup = {}) {
    const handlers = new Map()
    const events = []
    const manifest = { version: "1.0.9", hash: "next123", artifact: { file: "stable-win-x64-XneonLauncher.tar.zst" } }
    const info = { updateAvailable: true, updateReady: true, version: manifest.version, hash: manifest.hash, error: "" }
    const local = { channel: "stable", version: "1.0.8-pre2", hash: "old123", baseUrl: "http://127.0.0.1:53749/xneon-verified-update/" }
    let channel
    let prepared = Buffer.from(JSON.stringify({ schema_version: 2, hash: manifest.hash, version: manifest.version, artifact_file: manifest.artifact.file }))
    let emit
    const order = []
    const gate = new OperationGate()
    const shutdown = new ShutdownCoordinator({ log() {} })
    if (cleanup.files) shutdown.register("files", cleanup.files)
    let beforeQuit
    const Updater = {
      onStatusChange: callback => { emit = callback },
      getLocalInfo: async () => local,
      appDataFolder: async () => "fixture-root",
      downloadUpdate: async () => {},
      checkForUpdate: async () => info,
      updateInfo: () => info,
      applyUpdate: async () => { order.push("apply") },
      ...overrides,
    }
    const dependencies = {
      "electrobun/main": { Updater, default: { events: { on(name, callback) { if (name === "before-quit") beforeQuit = callback } } }, __esModule: true },
      "../../package.json": { version: "1.0.8-pre2" },
      "./profile-path": { isPortable: false },
      "../platform/desktop": { app: { emit() {}, getPath: () => "fixture-temp" }, rpcRegistry: { handle: (name, handler) => handlers.set(name, handler) } },
      "../platform/operation-gate": { launcherOperations: gate, withinDeadline: (op, ms, message) => withinDeadline(op, cleanup.timeout ?? ms, message) },
      "../platform/shutdown": { launcherShutdown: shutdown },
      "../db/core": { closeDatabaseForUpdate: () => order.push("db-close") },
      "../db": { initDatabase: async () => order.push("db-reopen"), dbHelpers: {
        getSetting: async () => channel, setSetting: async (_key, value) => { channel = value },
      } },
      "node:path": { join: (...parts) => parts.join("/") },
      "node:fs/promises": {
        lstat: async file => ({ isFile: () => file.endsWith(".json"), isDirectory: () => !file.endsWith(".json"), isSymbolicLink: () => false, size: prepared.length }),
        unlink: async () => {},
        readFile: async () => prepared,
      },
      "./update-public-keys": { verifiedUpdateBridgeUrl: local.baseUrl },
      "./verified-update-feed": {
        discoverVerifiedUpdate: async () => ({ manifest }),
        stageVerifiedArchive: async (_update, _temp, _signal, report) => {
          report(50, 200)
          return { file: "fixture-archive", dispose: async () => {} }
        },
        serveVerifiedUpdate: () => ({ baseUrl: "http://127.0.0.1:12345/private/", stop() {} }),
      },
      "./agent-mcp": { stopMcpConnections: cleanup.mcp ?? (async () => order.push("mcp")) },
      "./xn-connect-manager": { xnConnectManager: { stopAll: cleanup.relay ?? (async () => order.push("relay")) } },
      "./minecraft-core": { isLaunchActive: () => false },
      "./runtime": { isDev: false, sendToRenderer: (_, event) => events.push(event) },
    }
    const module = { exports: {} }
    vm.runInNewContext(source, { module, require: name => dependencies[name], Error, AbortController, AbortSignal, process: { platform: "win32", arch: "x64" } })
    module.exports.registerUpdater()
    return { check: handlers.get("update:check"), install: handlers.get("update:install"),
      download: handlers.get("update:download"), changeChannel: value => handlers.get("update:set-channel")(null, value),
      changeRecord: () => { prepared = Buffer.from("{}") }, cancel: handlers.get("update:cancel-install"), events, info, emit, gate, order, shutdown, beforeQuit }
  }
  describe("updater", () => {
    test("SDK update ждёт общий cleanup файлов до закрытия БД", async () => {
      const files = Promise.withResolvers(), started = Promise.withResolvers()
      const app = fixture({}, { files: async () => { started.resolve(); await files.promise; app.order.push("files") } })
      await app.check()
      await app.download()
      const installing = app.install()
      await started.promise
      assert.deepEqual(app.order, ["mcp", "relay"])
      files.resolve()
      await installing
      assert.deepEqual(app.order, ["mcp", "relay", "files", "db-close", "apply", "db-reopen"])
      assert.equal(app.shutdown.started, false, "Отказ SDK сбрасывает подготовленный барьер")
    })

    test("update veto не блокирует обычный выход после общего cleanup", async () => {
      const app = fixture()
      app.gate.blocked = true
      const preparing = {}
      app.beforeQuit(preparing)
      assert.equal(preparing.response.allow, false)
      await app.shutdown.run("quit")
      const completed = {}
      app.beforeQuit(completed)
      assert.equal(completed.response, undefined)
    })

    test("ошибка чтения локальных метаданных возвращается по RPC", async () => {
      const app = fixture({ getLocalInfo: async () => { throw new Error("Cannot read version") } })
      assert.equal((await app.check()).error, "Cannot read version")
      assert.equal(app.events.at(-1).status, "error")
    })

    test("проверка канала использует метаданные пакета, dev не обращается к feed", async () => {
      const app = fixture({ getLocalInfo: async () => ({ channel: "dev", baseUrl: "http://localhost" }),
        checkForUpdate: async () => { throw new Error("unexpected feed access") },
      })
      assert.match((await app.check()).error, /does not support signed Windows updates/)
    })

    test("ошибка нативной установки отображается, даже если SDK разрешил Promise", async () => {
      const app = fixture({ applyUpdate: async () => {
        app.emit({ status: "launching-new-version" })
        app.info.error = "Native helper failed"
        app.emit({ status: "error" })
      } })
      await app.check()
      assert.equal((await app.download()).success, true)
      await app.install()
      assert.equal(app.events.at(-1).status, "error")
      assert.equal(app.events.at(-1).error, "Native helper failed")
      assert.deepEqual(app.order, ["mcp", "relay", "db-close", "db-reopen"])
      assert.equal(app.gate.blocked, false)
    })

    test("повторные запросы не запускают вторую очистку и отмена блокирует применение", async () => {
      let drained
      const app = fixture()
      const pending = app.gate.run(() => new Promise(resolve => { drained = resolve }))
      await app.check()
      assert.equal((await app.download()).success, true)
      const first = app.install()
      await app.install()
      assert.equal(app.cancel(), true)
      drained()
      await pending
      await first
      assert.deepEqual(app.order, [])
      assert.equal(app.events.at(-1).error, "Update restart was cancelled.")
      assert.equal(app.gate.blocked, false)
    })

    test("таймаут очистки MCP сохраняет открытой БД и не вызывает updater", async () => {
      const app = fixture({}, { mcp: () => new Promise(() => {}), timeout: 20 })
      await app.check()
      assert.equal((await app.download()).success, true)
      await app.install()
      assert.deepEqual(app.order, ["relay"])
      assert.match(app.events.at(-1).error, /shutdown timed out/)
    })

    test("отказ SDK без handoff восстанавливает доступ к хранилищу", async () => {
      const app = fixture()
      await app.check()
      assert.equal((await app.download()).success, true)
      await app.install()
      assert.deepEqual(app.order, ["mcp", "relay", "db-close", "apply", "db-reopen"])
      assert.match(app.events.at(-1).error, /restart did not start/)
    })

    test("прогресс берётся из проверяемой загрузки, а не из нативной подготовки", async () => {
      const app = fixture()
      await app.check()
      assert.equal((await app.download()).success, true)
      assert.deepEqual(app.events.filter(event => "percent" in event).map(event => event.percent), [25])
    })

    test("смена канала сбрасывает подготовленный пакет", async () => {
      const app = fixture()
      await app.check()
      assert.equal((await app.download()).success, true)
      await app.changeChannel("beta")
      await app.install()
      assert.deepEqual(app.order, [])
    })

    test("изменение подготовленной записи блокирует передачу управления", async () => {
      const app = fixture()
      await app.check()
      assert.equal((await app.download()).success, true)
      app.changeRecord()
      await app.install()
      assert.deepEqual(app.order, ["mcp", "relay"])
      assert.match(app.events.at(-1).error, /changed after verification/)
    })
  })
}
