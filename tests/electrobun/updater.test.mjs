import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import vm from "node:vm"
import { OperationGate, withinDeadline } from "../../electrobun/platform/operation-gate.ts"

const source = await readFile(new URL("../../dist-electrobun-tests/main/updater.js", import.meta.url), "utf8")

function fixture(overrides = {}, cleanup = {}) {
  const handlers = new Map()
  const events = []
  const info = { updateAvailable: true, updateReady: true, version: "1.0.9", error: "" }
  let emit
  const order = []
  const gate = new OperationGate()
  const Updater = {
    onStatusChange: callback => { emit = callback },
    getLocalInfo: async () => ({ channel: "stable", baseUrl: "http://localhost" }),
    checkForUpdate: async () => info,
    updateInfo: () => info,
    applyUpdate: async () => { order.push("apply") },
    ...overrides,
  }
  const dependencies = {
    "electrobun/main": { Updater, default: { events: { on() {} } }, __esModule: true },
    "../platform/desktop": { app: { emit() {} }, rpcRegistry: { handle: (name, handler) => handlers.set(name, handler) } },
    "../platform/operation-gate": { launcherOperations: gate, withinDeadline: (op, ms, message) => withinDeadline(op, cleanup.timeout ?? ms, message) },
    "../db/core": { closeDatabaseForUpdate: () => order.push("db-close") },
    "../db": { initDatabase: async () => order.push("db-reopen") },
    "./agent-mcp": { stopMcpConnections: cleanup.mcp ?? (async () => order.push("mcp")) },
    "./xn-connect-manager": { xnConnectManager: { stopAll: cleanup.relay ?? (async () => order.push("relay")) } },
    "./minecraft-core": { isLaunchActive: () => false },
    "./runtime": { isDev: false, sendToRenderer: (_, event) => events.push(event) },
  }
  const module = { exports: {} }
  vm.runInNewContext(source, { module, require: name => dependencies[name], Error, AbortController })
  module.exports.registerUpdater()
  return { check: handlers.get("update:check"), install: handlers.get("update:install"),
    download: handlers.get("update:download"), cancel: handlers.get("update:cancel-install"), events, info, emit, gate, order }
}

test("ошибка чтения локальных метаданных возвращается по RPC", async () => {
  const app = fixture({ getLocalInfo: async () => { throw new Error("Cannot read version") } })
  assert.equal((await app.check()).error, "Cannot read version")
  assert.equal(app.events.at(-1).status, "error")
})

test("проверка канала использует метаданные пакета, dev не обращается к feed", async () => {
  const app = fixture({ getLocalInfo: async () => ({ channel: "dev", baseUrl: "http://localhost" }),
    checkForUpdate: async () => { throw new Error("unexpected feed access") },
  })
  assert.match((await app.check()).error, /feed is not configured/)
})

test("ошибка нативной установки отображается, даже если SDK разрешил Promise", async () => {
  const app = fixture({ applyUpdate: async () => {
    app.emit({ status: "launching-new-version" })
    app.info.error = "Native helper failed"
    app.emit({ status: "error" })
  } })
  await app.check()
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
  await app.install()
  assert.deepEqual(app.order, ["relay"])
  assert.match(app.events.at(-1).error, /shutdown timed out/)
})

test("отказ SDK без handoff восстанавливает доступ к хранилищу", async () => {
  const app = fixture()
  await app.check()
  await app.install()
  assert.deepEqual(app.order, ["mcp", "relay", "db-close", "apply", "db-reopen"])
  assert.match(app.events.at(-1).error, /restart did not start/)
})

test("процент обновления передаётся только при наличии корректных счётчиков байтов", async () => {
  const app = fixture({ downloadUpdate: async () => {
    app.emit({ status: "download-progress", details: { progress: 90 } })
    app.emit({ status: "download-progress", details: { bytesDownloaded: 50, totalBytes: 200, progress: 99 } })
  } })
  await app.download()
  assert.deepEqual(app.events.filter(event => "percent" in event).map(event => event.percent), [25])
})
