import packageJson from "../../package.json"
import Electrobun, { Updater } from "electrobun/main"
import { app, rpcRegistry } from "../platform/desktop"
import { launcherOperations, withinDeadline } from "../platform/operation-gate"
import { closeDatabaseForUpdate } from "../db/core"
import { initDatabase } from "../db"
import { stopMcpConnections } from "./agent-mcp"
import { xnConnectManager } from "./xn-connect-manager"
import { isLaunchActive } from "./minecraft-core"
import { sendToRenderer } from "./runtime"

type UpdateChannel = "stable" | "beta"
let downloaded = false
let downloading = false
let installing = false
let restartRequested = false
let nativeQuitAllowed = false
let cancellation: AbortController | undefined

function updateError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  sendToRenderer("update:status", { status: "error", error: message })
  return message
}

export function registerUpdater() {
  if (packageJson.version === "1.0.8-pre1") {
    const error = "In-app updates are disabled in this experimental pre-release. Install builds manually."
    rpcRegistry.handle("update:check", () => ({ available: false, error }))
    rpcRegistry.handle("update:download", () => ({ success: false, error }))
    rpcRegistry.handle("update:install", () => { updateError(error) })
    rpcRegistry.handle("update:cancel-install", () => false)
    rpcRegistry.handle("update:get-channel", async (): Promise<UpdateChannel> =>
      (await Updater.getLocalInfo()).channel === "canary" ? "beta" : "stable")
    return
  }

  Electrobun.events.on("before-quit", event => {
    if (launcherOperations.blocked && !nativeQuitAllowed) event.response = { allow: false }
  })
  Updater.onStatusChange(({ status, details }) => {
    if (installing && status === "launching-new-version") restartRequested = true
    if (installing && status === "error") restartRequested = false
    if (!downloading) return
    if (status === "downloading") sendToRenderer("update:status", { status })
    const transferred = details?.bytesDownloaded
    const total = details?.totalBytes
    if (status === "download-progress" && typeof transferred === "number" && typeof total === "number"
      && Number.isFinite(transferred) && Number.isFinite(total) && transferred >= 0 && total > 0 && transferred <= total) {
      sendToRenderer("update:progress", {
        percent: 100 * transferred / total,
        transferred,
        total,
      })
    }
  })
  rpcRegistry.handle("update:check", async () => {
    if (isLaunchActive()) return { available: false, error: "Minecraft is running." }
    try {
      const local = await Updater.getLocalInfo()
      if (local.channel === "dev" || !local.baseUrl) {
        throw new Error("Electrobun update feed is not configured.")
      }
      sendToRenderer("update:status", { status: "checking" })
      const info = await Updater.checkForUpdate()
      if (info.error) throw new Error(info.error)
      downloaded = info.updateReady
      sendToRenderer("update:status", {
        status: downloaded ? "downloaded" : info.updateAvailable ? "available" : "not-available",
        version: info.version,
      })
      return { available: info.updateAvailable, version: info.version }
    } catch (error) {
      return { available: false, error: updateError(error) }
    }
  })
  rpcRegistry.handle("update:download", async () => {
    if (downloading || isLaunchActive()) return { success: false, error: "Download is currently unavailable." }
    try {
      downloading = true
      sendToRenderer("update:status", { status: "downloading" })
      await Updater.downloadUpdate()
      const info = Updater.updateInfo()
      if (!info.updateReady) throw new Error(info.error || "Update is unavailable.")
      downloaded = true
      sendToRenderer("update:status", { status: "downloaded", version: info.version })
      return { success: true }
    } catch (error) {
      return { success: false, error: updateError(error) }
    } finally {
      downloading = false
    }
  })
  rpcRegistry.handle("update:install", async () => {
    if (installing || restartRequested) return
    if (isLaunchActive()) {
      updateError("Minecraft is running.")
      return
    }
    if (!downloaded || downloading) {
      updateError("Update is unavailable.")
      return
    }
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
      closeDatabaseForUpdate()
      databaseClosed = true
      cancellation = undefined
      nativeQuitAllowed = true
      await Updater.applyUpdate()
      // SDK может вернуть управление после передачи завершения нативному рантайму.
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
  rpcRegistry.handle("update:get-channel", async (): Promise<UpdateChannel> =>
    (await Updater.getLocalInfo()).channel === "canary" ? "beta" : "stable")
}
