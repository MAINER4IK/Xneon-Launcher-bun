import packageJson from "../../package.json"
import Electrobun, { Updater } from "electrobun/main"
import { app, rpcRegistry } from "../platform/desktop"
import { launcherOperations, withinDeadline } from "../platform/operation-gate"
import { closeDatabaseForUpdate } from "../db/core"
import { dbHelpers, initDatabase } from "../db"
import { lstat, readFile, unlink } from "node:fs/promises"
import path from "node:path"
import { verifiedUpdateBridgeUrl } from "./update-public-keys"
import { discoverVerifiedUpdate, stageVerifiedArchive, serveVerifiedUpdate, type VerifiedUpdate } from "./verified-update-feed"
import { stopMcpConnections } from "./agent-mcp"
import { xnConnectManager } from "./xn-connect-manager"
import { isLaunchActive } from "./minecraft-core"
import { sendToRenderer } from "./runtime"

type UpdateChannel = "stable" | "beta"
let available: VerifiedUpdate | null = null
let preparedRecord: { file: string; bytes: Buffer } | undefined
let checking = false
let changingChannel = false
let downloaded = false
let downloading = false
let installing = false
let restartRequested = false
let nativeQuitAllowed = false
let cancellation: AbortController | undefined

async function readPreparedRecord(file: string): Promise<Buffer> {
  const metadata = await lstat(file)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) throw new Error("Invalid prepared update record")
  return readFile(file)
}

function updateError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  sendToRenderer("update:status", { status: "error", error: message })
  return message
}

export function registerUpdater() {
  const readChannel = async (): Promise<UpdateChannel> => {
    const saved = await dbHelpers.getSetting("launcherUpdateChannel")
    if (saved === "stable" || saved === "beta") return saved
    return (await Updater.getLocalInfo()).channel === "canary" ? "beta" : "stable"
  }
  rpcRegistry.handle("update:get-channel", readChannel)
  rpcRegistry.handle("update:set-channel", async (_event, channel: UpdateChannel) => {
    if (channel !== "stable" && channel !== "beta") throw new Error("Unknown update channel")
    if (checking || changingChannel || downloading || installing || restartRequested) throw new Error("Update is in progress")
    changingChannel = true
    try {
      await dbHelpers.setSetting("launcherUpdateChannel", channel)
      available = null
      downloaded = false
      preparedRecord = undefined
    } finally { changingChannel = false }
  })

  if (packageJson.version === "1.0.8-pre1") {
    const error = "In-app updates are disabled in this experimental pre-release. Install builds manually."
    rpcRegistry.handle("update:check", () => ({ available: false, error }))
    rpcRegistry.handle("update:download", () => ({ success: false, error }))
    rpcRegistry.handle("update:install", () => { updateError(error) })
    rpcRegistry.handle("update:cancel-install", () => false)
    return
  }

  Electrobun.events.on("before-quit", event => {
    if (launcherOperations.blocked && !nativeQuitAllowed) event.response = { allow: false }
  })
  Updater.onStatusChange(({ status }) => {
    if (installing && status === "launching-new-version") restartRequested = true
    if (installing && status === "error") restartRequested = false
  })
  rpcRegistry.handle("update:check", async () => {
    if (checking || changingChannel || downloading || installing || restartRequested || isLaunchActive()) {
      return { available: false, error: "Update check is currently unavailable." }
    }
    checking = true
    available = null
    downloaded = false
    preparedRecord = undefined
    try {
      const local = await Updater.getLocalInfo()
      if (process.platform !== "win32" || process.arch !== "x64" ||
          (local.channel !== "stable" && local.channel !== "canary") || local.version !== packageJson.version || local.baseUrl !== verifiedUpdateBridgeUrl) {
        throw new Error("This package does not support signed Windows updates.")
      }
      const preference = await readChannel()
      sendToRenderer("update:status", { status: "checking" })
      available = await discoverVerifiedUpdate(local.version, local.channel, preference)
      if (available?.manifest.hash === local.hash) throw new Error("Update manifest reuses the installed build hash")
      sendToRenderer("update:status", { status: available ? "available" : "not-available", version: available?.manifest.version })
      return { available: !!available, version: available?.manifest.version }
    } catch (error) {
      available = null
      return { available: false, error: updateError(error) }
    } finally { checking = false }
  })
  rpcRegistry.handle("update:download", async () => {
    const update = available
    if (!update || checking || changingChannel || downloading || installing || restartRequested || isLaunchActive()) {
      return { success: false, error: "Download is currently unavailable." }
    }
    downloading = true
    downloaded = false
    preparedRecord = undefined
    try {
      sendToRenderer("update:status", { status: "downloading" })
      const staged = await stageVerifiedArchive(update, app.getPath("temp"), AbortSignal.timeout(15 * 60_000), (bytes, total) =>
        sendToRenderer("update:progress", { percent: bytes * 100 / total, transferred: bytes, total }))
      try {
        const local = await Updater.getLocalInfo()
        const directory = path.join(await Updater.appDataFolder(), "self-extraction")
        const dirStat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
          return null
        })
        if (dirStat && (!dirStat.isDirectory() || dirStat.isSymbolicLink())) throw new Error("Invalid update staging directory")
        const file = path.join(directory, ".electrobun-prepared-update.json")
        // SDK matches cached records by version/hash/filename, without the signed digest.
        await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error })
        if (local.baseUrl !== verifiedUpdateBridgeUrl) throw new Error("Invalid native update feed identity.")
        const bridge = serveVerifiedUpdate(update, staged.file, local.baseUrl)
        try {
          const checked = await Updater.checkForUpdate()
          if (checked.error || !checked.updateAvailable || checked.hash !== update.manifest.hash) {
            throw new Error(checked.error || "SDK rejected the verified update manifest.")
          }
          await Updater.downloadUpdate()
          const info = Updater.updateInfo()
          if (!info.updateReady || info.hash !== update.manifest.hash || info.version !== update.manifest.version) {
            throw new Error(info.error || "SDK did not prepare the verified update.")
          }
          const bytes = await readPreparedRecord(file)
          const record = JSON.parse(bytes.toString("utf8"))
          if (record.schema_version !== 2 || record.hash !== update.manifest.hash ||
              record.version !== update.manifest.version || record.artifact_file !== update.manifest.artifact.file) {
            throw new Error("Prepared update does not match the signed manifest.")
          }
          preparedRecord = { file, bytes }
        } finally {
          bridge.stop()
        }
      } finally { await staged.dispose() }
      downloaded = true
      sendToRenderer("update:status", { status: "downloaded", version: update.manifest.version })
      return { success: true }
    } catch (error) {
      preparedRecord = undefined
      return { success: false, error: updateError(error) }
    } finally { downloading = false }
  })
  rpcRegistry.handle("update:install", async () => {
    if (installing || restartRequested) return
    if (isLaunchActive()) {
      updateError("Minecraft is running.")
      return
    }
    if (!downloaded || !preparedRecord || downloading || changingChannel || checking) {
      updateError("Update is unavailable.")
      return
    }
    const prepared = preparedRecord
    installing = true
    launcherOperations.blocked = true
    const controller = new AbortController()
    cancellation = controller
    let databaseClosed = false
    try {
      sendToRenderer("update:status", { status: "preparing" })
      await launcherOperations.drain(15_000)
      controller.signal.throwIfAborted()
      if (isLaunchActive()) throw new Error("Minecraft is running.")
      await withinDeadline(
        Promise.allSettled([stopMcpConnections(true), xnConnectManager.stopAll()]).then(results => {
          for (const result of results) if (result.status === "rejected") throw result.reason
        }),
        10_000,
        "MCP or relay shutdown timed out.",
      )
      controller.signal.throwIfAborted()
      if (!(await readPreparedRecord(prepared.file)).equals(prepared.bytes)) throw new Error("Prepared update changed after verification.")
      controller.signal.throwIfAborted()
      closeDatabaseForUpdate()
      databaseClosed = true
      cancellation = undefined
      nativeQuitAllowed = true
      await Updater.applyUpdate()
      // SDK РјРѕР¶РµС‚ РІРµСЂРЅСѓС‚СЊ СѓРїСЂР°РІР»РµРЅРёРµ РїРѕСЃР»Рµ РїРµСЂРµРґР°С‡Рё Р·Р°РІРµСЂС€РµРЅРёСЏ РЅР°С‚РёРІРЅРѕРјСѓ СЂР°РЅС‚Р°Р№РјСѓ.
      if (restartRequested) return
      const info = Updater.updateInfo()
      downloaded = info.updateReady
      throw new Error(info.error || "Update restart did not start.")
    } catch (error) {
      restartRequested = false
      nativeQuitAllowed = false
      if (databaseClosed) {
        try {
          await initDatabase()
        } catch (recoveryError) {
          updateError(`Update failed and the database could not be reopened: ${String(recoveryError)}`)
          return
        }
      }
      launcherOperations.blocked = false
      app.emit("reopen")
      updateError(error)
    } finally {
      cancellation = undefined
      installing = false
    }
  })
  rpcRegistry.handle("update:cancel-install", () => {
    if (!cancellation) return false
    cancellation.abort(new Error("Update restart was cancelled."))
    return true
  })
}
