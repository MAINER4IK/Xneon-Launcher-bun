import packageJson from "../../package.json"
import { spawn } from "node:child_process"
import Electrobun, { Updater } from "electrobun/main"
import { app, rpcRegistry } from "../platform/desktop"
import { launcherOperations, withinDeadline } from "../platform/operation-gate"
import { closeDatabaseForUpdate } from "../db/core"
import { initDatabase } from "../db"
import { isPortable } from "./profile-path"
import { expectedUpdateBaseUrl } from "./update-public-keys"
import { installedPreference, resolveVerifiedUpdate, type PackageChannel, type VerifiedUpdate } from "./verified-update-feed"
import { downloadChannelInstaller } from "./channel-switch"
import { stopMcpConnections } from "./agent-mcp"
import { xnConnectManager } from "./xn-connect-manager"
import { isLaunchActive } from "./minecraft-core"
import { sendToRenderer } from "./runtime"
import { launcherShutdown } from "../platform/shutdown"

/** Канал устанавливает сама сборка: тег версии `-preN`/`-betaN` собирается как canary. */
function installedChannel(): PackageChannel {
  return /-(?:pre|beta)\d+$/.test(packageJson.version) ? "canary" : "stable"
}

let available: VerifiedUpdate | null = null
let checking = false
let downloaded = false
let downloading = false
let installing = false
let restartRequested = false
let nativeQuitAllowed = false
let cancellation: AbortController | undefined
let switching = false

function updateError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  sendToRenderer("update:status", { status: "error", error: message })
  return message
}

export function registerUpdater() {
  rpcRegistry.handle("update:get-channel", () => installedPreference(installedChannel()))

  rpcRegistry.handle("update:set-channel", async (_event, channel: "stable" | "beta") => {
    if (channel !== "stable" && channel !== "beta") throw new Error("Unknown update channel")
    if (checking || downloading || installing || restartRequested || switching) throw new Error("Update is in progress")
    const target: PackageChannel = channel === "beta" ? "canary" : "stable"
    if (target === installedChannel()) return { state: "current" as const }
    // SDK принимает только манифест своего канала, поэтому смена канала — это
    // установка сборки другого канала через подписанный NSIS-установщик.
    if (isPortable) return { state: "error" as const, error: "Portable builds require manual updates." }
    switching = true
    let databaseClosed = false
    let prepared = false
    try {
      sendToRenderer("update:status", { status: "downloading" })
      sendToRenderer("update:progress", { percent: 0, transferred: 0, total: 0 })
      const installer = await downloadChannelInstaller(target, progress => sendToRenderer("update:progress", progress))
      sendToRenderer("update:status", { status: "preparing" })
      launcherOperations.blocked = true
      const cleanup = await launcherShutdown.prepare("update")
      prepared = true
      if (cleanup.status !== "completed" || cleanup.failed.length || cleanup.timedOut.length) throw new Error("Update cleanup did not finish successfully.")
      closeDatabaseForUpdate()
      databaseClosed = true
      const child = spawn(installer.path, ["/S", "--force-run"], { detached: true, stdio: "ignore" })
      child.on("error", error => console.error("[Updater] Channel installer failed to start", error))
      child.unref()
      nativeQuitAllowed = true
      sendToRenderer("update:status", { status: "preparing", version: installer.version })
      // prepare уже выполнил задачи cleanup; run только отдаёт выход нативному слою.
      await launcherShutdown.run("update")
      return { state: "switching" as const, version: installer.version }
    } catch (error) {
      nativeQuitAllowed = false
      if (prepared && launcherShutdown.finished) launcherShutdown.resetAfterCancelledUpdate()
      if (databaseClosed) {
        try {
          await initDatabase()
        } catch (recoveryError) {
          const message = `Channel switch failed and the database could not be reopened: ${String(recoveryError)}`
          sendToRenderer("update:status", { status: "error", error: message })
          return { state: "error" as const, error: message }
        }
      }
      launcherOperations.blocked = false
      app.emit("reopen")
      return { state: "error" as const, error: updateError(error) }
    } finally { switching = false }
  })

  if (isPortable) {
    const error = "Portable builds require manual updates."
    rpcRegistry.handle("update:check", () => ({ available: false, error }))
    rpcRegistry.handle("update:download", () => ({ success: false, error }))
    rpcRegistry.handle("update:install", () => { updateError(error) })
    rpcRegistry.handle("update:cancel-install", () => false)
    return
  }

  Electrobun.events.on("before-quit", event => {
    if (launcherOperations.blocked && !nativeQuitAllowed && !launcherShutdown.exiting) event.response = { allow: false }
  })
  Updater.onStatusChange(({ status, details }) => {
    if (status === "launching-new-version" && installing) restartRequested = true
    if (status === "error" && installing) restartRequested = false
    if (downloading || installing) {
      if (status === "download-progress" && details?.progress != null) {
        sendToRenderer("update:progress", { percent: details.progress, transferred: details.bytesDownloaded ?? 0, total: details.totalBytes ?? 0 })
      } else if (["downloading", "downloading-full-bundle", "fetching-patch", "downloading-patch", "extracting", "decompressing", "applying"].includes(status)) {
        sendToRenderer("update:status", { status: "downloading" })
      }
    }
  })

  rpcRegistry.handle("update:check", async () => {
    if (checking || downloading || installing || restartRequested || isLaunchActive()) {
      return { available: false, error: "Update check is currently unavailable." }
    }
    checking = true
    available = null
    downloaded = false
    try {
      const local = await Updater.getLocalInfo()
      if (process.platform !== "win32" || process.arch !== "x64" ||
          (local.channel !== "stable" && local.channel !== "canary") || local.version !== packageJson.version ||
          local.baseUrl !== expectedUpdateBaseUrl(local.channel)) {
        throw new Error("This package does not support signed Windows updates.")
      }
      const channel = local.channel as PackageChannel
      sendToRenderer("update:status", { status: "checking" })
      available = await resolveVerifiedUpdate(local.version, channel)
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
    if (!update || checking || downloading || installing || restartRequested || isLaunchActive()) {
      return { success: false, error: "Download is currently unavailable." }
    }
    downloading = true
    downloaded = false
    try {
      sendToRenderer("update:status", { status: "downloading" })
      const checked = await Updater.checkForUpdate()
      if (checked.error || !checked.updateAvailable || checked.hash !== update.manifest.hash) {
        throw new Error(checked.error || "SDK rejected the verified update manifest.")
      }
      await Updater.downloadUpdate()
      const info = Updater.updateInfo()
      if (!info.updateReady || info.hash !== update.manifest.hash || info.version !== update.manifest.version) {
        throw new Error(info.error || "SDK did not prepare the verified update.")
      }
      downloaded = true
      sendToRenderer("update:status", { status: "downloaded", version: update.manifest.version })
      return { success: true }
    } catch (error) {
      return { success: false, error: updateError(error) }
    } finally { downloading = false }
  })

  rpcRegistry.handle("update:install", async () => {
    if (installing || restartRequested) return
    if (isLaunchActive()) {
      updateError("Minecraft is running.")
      return
    }
    if (!downloaded || downloading || checking) {
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
      if (!Updater.updateInfo().updateReady) throw new Error("Update is not prepared.")
      await withinDeadline(
        Promise.allSettled([stopMcpConnections(true), xnConnectManager.stopAll()]).then(results => {
          for (const result of results) if (result.status === "rejected") throw result.reason
        }),
        10_000,
        "MCP or relay shutdown timed out.",
      )
      const cleanup = await launcherShutdown.prepare("update")
      if (cleanup.status !== "completed" || cleanup.failed.length || cleanup.timedOut.length) throw new Error("Update cleanup did not finish successfully.")
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
      if (launcherShutdown.finished) launcherShutdown.resetAfterCancelledUpdate()
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
