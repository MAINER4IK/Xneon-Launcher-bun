// Проверки подсистемы: describe изолируют fixtures и хуки; runtime не подменяется общим состоянием.
import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { readFile } from "node:fs/promises"
import { describe, test } from "bun:test"
import { installedPreference, isAllowedUpdateRedirect, manifestUrls, releaseChannelOf } from "../../electrobun/main/verified-update-feed.ts"
import { verifySignedWindowsUpdateManifest, verifyWindowsUpdateManifest } from "../../electrobun/main/verified-update-manifest.ts"
import { appIdentifier } from "../../electrobun/main/app-identity.ts"
import nodeTest from "node:test"
import vm from "node:vm"
import { OperationGate, withinDeadline } from "../../electrobun/platform/operation-gate.ts"
import { ShutdownCoordinator } from "../../electrobun/platform/shutdown.ts"

{
  describe("verified-update-feed", () => {
    test("канал по версии и его отображение в UI", () => {
      assert.equal(releaseChannelOf("1.0.8"), "stable")
      assert.equal(releaseChannelOf("1.0.8-pre2"), "canary")
      assert.equal(releaseChannelOf("1.0.8-beta1"), "canary")
      assert.equal(installedPreference("stable"), "stable")
      assert.equal(installedPreference("canary"), "beta")
    })

    test("манифест канала читается из плоского URL-каталога GitHub без API и фиксированного порта", () => {
      const stable = manifestUrls("stable")
      assert.equal(stable.base, "https://github.com/MAINER4IK/Xneon-Launcher-bun/releases/latest/download")
      assert.equal(stable.manifestUrl, stable.base + "/stable-win-x64-update-v2.json")
      assert.equal(stable.signatureUrl, stable.base + "/stable-win-x64-update-v2.json.sig")
      const canary = manifestUrls("canary")
      assert.equal(canary.base, "https://github.com/MAINER4IK/Xneon-Launcher-bun/releases/download/canary")
      assert.equal(canary.manifestUrl, canary.base + "/canary-win-x64-update-v2.json")
      assert.equal(canary.signatureUrl, canary.base + "/canary-win-x64-update-v2.json.sig")
    })

    test("редирект latest/download через канонический тег разрешён, посторонние хосты — нет", () => {
      assert.equal(isAllowedUpdateRedirect(new URL("https://github.com/MAINER4IK/Xneon-Launcher-bun/releases/download/v1.0.10/stable-win-x64-update-v2.json")), true)
      assert.equal(isAllowedUpdateRedirect(new URL("https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r")), true)
      assert.equal(isAllowedUpdateRedirect(new URL("https://objects.githubusercontent.com/x")), true)
      assert.equal(isAllowedUpdateRedirect(new URL("https://github.com/other/repo/releases/download/v1/x.json")), false)
      assert.equal(isAllowedUpdateRedirect(new URL("https://evil.example/x.json")), false)
      assert.equal(isAllowedUpdateRedirect(new URL("http://github.com/MAINER4IK/Xneon-Launcher-bun/releases/download/v1/x.json")), false)
      assert.equal(isAllowedUpdateRedirect(new URL("https://github.com:8443/MAINER4IK/Xneon-Launcher-bun/releases/download/v1/x.json")), false)
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

  function fixture(overrides = {}, cleanup = {}, installed = "1.0.8-pre2") {
    const handlers = new Map()
    const events = []
    const opened = []
    const local = {
      channel: /-(?:pre|beta)\d+$/.test(installed) ? "canary" : "stable",
      version: installed, hash: "old123",
      baseUrl: /-(?:pre|beta)\d+$/.test(installed)
        ? "https://github.com/MAINER4IK/Xneon-Launcher-bun/releases/download/canary"
        : "https://github.com/MAINER4IK/Xneon-Launcher-bun/releases/latest/download",
    }
    const manifest = { version: "1.0.9", channel: local.channel, hash: "next123", artifact: { file: `${local.channel}-win-x64-XneonLauncher.tar.zst` } }
    const info = { updateAvailable: true, updateReady: true, version: manifest.version, hash: manifest.hash, error: "" }
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
      "../../package.json": { version: installed },
      "./profile-path": { isPortable: false },
      "../platform/desktop": {
        app: { emit() {}, getPath: () => "fixture-temp" },
        rpcRegistry: { handle: (name, handler) => handlers.set(name, handler) },
        shell: { openExternal: async url => opened.push(url) },
      },
      "../platform/operation-gate": { launcherOperations: gate, withinDeadline: (op, ms, message) => withinDeadline(op, cleanup.timeout ?? ms, message) },
      "../platform/shutdown": { launcherShutdown: shutdown },
      "../db/core": { closeDatabaseForUpdate: () => order.push("db-close") },
      "../db": { initDatabase: async () => order.push("db-reopen") },
      "./update-public-keys": { expectedUpdateBaseUrl: channel => channel === local.channel ? local.baseUrl : "http://wrong" },
      "./verified-update-feed": {
        resolveVerifiedUpdate: async () => ({ manifest, archiveUrl: local.baseUrl + "/" + manifest.artifact.file }),
        installedPreference: channel => channel === "canary" ? "beta" : "stable",
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
      getChannel: handlers.get("update:get-channel"),
      download: handlers.get("update:download"), changeChannel: value => handlers.get("update:set-channel")(null, value),
      cancel: handlers.get("update:cancel-install"), events, opened, info, emit, gate, order, shutdown, beforeQuit }
  }

  describe("updater", () => {
    test("канал задаёт сборка; выбор другой ветки открывает её релизы, а не меняет канал на месте", async () => {
      const app = fixture()
      assert.equal(await app.getChannel(), "beta")
      assert.deepEqual({ ...(await app.changeChannel("beta")) }, { state: "current" })
      assert.deepEqual({ ...(await app.changeChannel("stable")) }, { state: "opened" })
      assert.deepEqual(app.opened, ["https://github.com/MAINER4IK/Xneon-Launcher-bun/releases/latest"])
    })

    test("stable-сборка на 'Beta' открывает список релизов (канареечные видны вручную)", async () => {
      const app = fixture({}, {}, "1.0.8")
      assert.equal(await app.getChannel(), "stable")
      assert.deepEqual({ ...(await app.changeChannel("beta")) }, { state: "opened" })
      assert.deepEqual(app.opened, ["https://github.com/MAINER4IK/Xneon-Launcher-bun/releases"])
    })

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

    test("проверка требует канал и address identity пакета, иначе не ходит в feed", async () => {
      const app = fixture({ getLocalInfo: async () => ({ channel: "dev", version: "1.0.8-pre2", baseUrl: "http://localhost" }),
        checkForUpdate: async () => { throw new Error("unexpected feed access") } })
      assert.match((await app.check()).error, /does not support signed Windows updates/)
      const wrong = fixture({ getLocalInfo: async () => ({ channel: "canary", version: "1.0.8-pre2", baseUrl: "https://evil.example/" }) })
      assert.match((await wrong.check()).error, /does not support signed Windows updates/)
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

    test("прогресс транслируется из SDK download-progress", async () => {
      const app = fixture({ downloadUpdate: async () => { app.emit({ status: "download-progress", details: { progress: 25 } }) } })
      await app.check()
      assert.equal((await app.download()).success, true)
      assert.ok(app.events.some(event => "percent" in event && event.percent === 25))
    })

    test("скачивание не растягивается когда SDK уже приготовил обновление", async () => {
      const app = fixture()
      await app.check()
      assert.equal((await app.download()).success, true)
      assert.equal(app.events.at(-1).status, "downloaded")
    })
  })
}