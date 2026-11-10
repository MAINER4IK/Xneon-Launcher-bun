import { useState, useEffect, useCallback } from "react"
import { IconRefresh, IconDownload, IconCheck, IconPlayerPlay, IconLoader2, IconGitBranch } from "@tabler/icons-react"
import { APP_VERSION } from "@/lib/app-meta"
import { ActionConfirmDialog } from "@/components/launcher/instance/action-confirm-dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useTranslation } from "react-i18next"

type UpdateStatus = "idle" | "checking" | "downloading" | "available" | "downloaded" | "preparing" | "error" | "not-available"
type UpdateChannel = "stable" | "beta"

export function SettingsUpdate() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<UpdateStatus>("idle")
  const [remoteVersion, setRemoteVersion] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [channel, setChannel] = useState<UpdateChannel>("stable")
  const [pendingChannel, setPendingChannel] = useState<UpdateChannel | null>(null)
  const [savingChannel, setSavingChannel] = useState(false)
  const busy = savingChannel || status === "checking" || status === "downloading" || status === "preparing"
  const showError = useCallback((error: unknown) => {
    setStatus("error")
    setErrorMsg(error instanceof Error ? error.message : String(error))
  }, [])

  useEffect(() => {
    const api = window.electrobunAPI
    if (!api) return
    // Загружаем текущий канал обновлений.
    void api.updateGetChannel?.().then((ch) => {
      if (ch) setChannel(ch)
    }).catch(showError)
    const unsubStatus = api.onUpdateStatus((s) => {
      if (s.status === "available") {
        setStatus("available")
        setRemoteVersion(s.version ?? null)
      } else if (s.status === "downloaded") {
        setStatus("downloaded")
        setRemoteVersion(s.version ?? null)
      } else if (s.status === "downloading") {
        setStatus("downloading")
      } else if (s.status === "preparing") {
        setStatus("preparing")
      } else if (s.status === "checking") {
        setStatus("checking")
      } else if (s.status === "not-available") {
        setStatus("not-available")
      } else if (s.status === "error") {
        setStatus("error")
        setErrorMsg(s.error ?? "Unknown error")
      }
    })
    const unsubProgress = api.onUpdateProgress((p) => {
      setProgress(p.percent)
    })
    return () => { unsubStatus(); unsubProgress() }
  }, [showError])

  const confirmChannel = async () => {
    const api = window.electrobunAPI
    if (!api || !pendingChannel || busy) return
    const next = pendingChannel
    setPendingChannel(null)
    setSavingChannel(true)
    try {
      await api.updateSetChannel(next)
      setChannel(next)
      setStatus("idle")
      setRemoteVersion(null)
      setProgress(null)
      setErrorMsg(null)
    } catch (error) {
      showError(error)
    } finally { setSavingChannel(false) }
  }

  const handleCheck = useCallback(async () => {
    setStatus("checking")
    setErrorMsg(null)
    setProgress(null)
    try {
      const result = await window.electrobunAPI?.updateCheck()
      if (!result) setStatus("idle")
      else if (result.error) showError(result.error)
    } catch (error) {
      showError(error)
    }
  }, [showError])

  const handleDownload = useCallback(async () => {
    setProgress(null)
    setStatus("downloading")
    try {
      const result = await window.electrobunAPI?.updateDownload()
      if (!result?.success) showError(result?.error ?? "Download failed")
    } catch (error) {
      showError(error)
    }
  }, [showError])

  const handleInstall = useCallback(() => {
    void window.electrobunAPI?.updateInstall().catch(showError)
  }, [showError])

  const statusLabel = (() => {
    switch (status) {
      case "checking": return t("launcherUpdate.checking")
      case "available": return t("launcherUpdate.available", { version: remoteVersion })
      case "downloaded": return t("launcherUpdate.downloaded", { version: remoteVersion })
      case "not-available": return t("launcherUpdate.notAvailable")
      case "error": return t("launcherUpdate.error", { message: errorMsg })
      default: return null
    }
  })()

  return (
    <div data-ui="settings-settings-update-div-1" data-component="settings-update" data-settings-tone="green" className="space-y-4 pt-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-medium text-foreground">
            <IconGitBranch className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            {t("launcherUpdate.channel")}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{APP_VERSION}</div>
        </div>
        <Select value={channel} disabled={busy} onValueChange={value => { if (value === "stable" || value === "beta") setPendingChannel(value) }}>
          <SelectTrigger aria-label={t("launcherUpdate.channel")} className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="stable">{t("launcherUpdate.channelStable")}</SelectItem>
            <SelectItem value="beta">{t("launcherUpdate.channelBeta")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {channel === "stable" && APP_VERSION.includes("-pre") && (
        <p className="text-xs text-muted-foreground">{t("launcherUpdate.stableReturn")}</p>
      )}
      <ActionConfirmDialog
        open={pendingChannel !== null}
        onClose={() => setPendingChannel(null)}
        onConfirm={() => { void confirmChannel() }}
        title={t("launcherUpdate.channel")}
        description={t(pendingChannel === "beta" ? "launcherUpdate.channelDescBeta" : "launcherUpdate.stableReturn")}
        variant="info"
        icon="info"
      />

      <div data-ui="settings-settings-update-div-12" className="border-t border-border" />

      <div data-ui="settings-settings-update-div-2" className="flex items-center justify-between">
        <div data-ui="settings-settings-update-div-3">
          <div data-ui="settings-settings-update-div-4" className="flex items-center gap-2 font-medium text-foreground"><IconDownload className="h-4 w-4 shrink-0 text-primary" strokeWidth={1.7} aria-hidden="true" />{t("launcherUpdate.title")}</div>
        </div>
        {status === "idle" && (
          <button data-ui="settings-settings-update-button-1"
            onClick={handleCheck}
            disabled={savingChannel}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors"
          >
            <IconRefresh className="w-4 h-4" strokeWidth={2} />
            {t("launcherUpdate.check")}
          </button>
        )}
        {status === "checking" && (
          <button data-ui="settings-settings-update-button-2" disabled className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-muted text-muted-foreground font-medium">
            <IconLoader2 className="w-4 h-4 text-primary animate-spin" strokeWidth={2} />
            {t("launcherUpdate.checking")}
          </button>
        )}
        {status === "available" && (
          <button data-ui="settings-settings-update-button-3"
            onClick={handleDownload}
            disabled={savingChannel}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors"
          >
            <IconDownload className="w-4 h-4" strokeWidth={2} />
            {t("launcherUpdate.download")}
          </button>
        )}
        {status === "downloaded" && (
          <button data-ui="settings-settings-update-button-4"
            onClick={handleInstall}
            disabled={savingChannel}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors"
          >
            <IconPlayerPlay className="w-4 h-4" strokeWidth={2} />
            {t("launcherUpdate.restart")}
          </button>
        )}
        {status === "preparing" && (
          <button onClick={() => { void window.electrobunAPI?.updateCancelInstall().catch(showError) }}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-muted text-muted-foreground font-medium">
            <IconLoader2 className="w-4 h-4 animate-spin" strokeWidth={2} />
            {t("common.cancel")}
          </button>
        )}
        {(status === "not-available" || status === "error") && (
          <button data-ui="settings-settings-update-button-5"
            onClick={handleCheck}
            disabled={savingChannel}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-muted text-muted-foreground font-medium hover:bg-muted/80 transition-colors"
          >
            <IconRefresh className="w-4 h-4" strokeWidth={2} />
            {t("launcherUpdate.checkAgain")}
          </button>
        )}
      </div>

      {status === "downloading" && (
        <div data-ui="settings-settings-update-div-5" className="space-y-2">
          <div data-ui="settings-settings-update-div-6" className="w-full h-2 rounded-full bg-muted overflow-hidden"
            role="progressbar" aria-label={t("launcherUpdate.download")} aria-valuenow={progress ?? undefined}>
            <div data-ui="settings-settings-update-div-7"
              className={cn("h-full rounded-full bg-primary transition-all duration-300", progress === null && "animate-pulse")}
              style={{ width: progress === null ? "100%" : `${progress}%` }}
            />
          </div>
          {progress !== null && <p data-ui="settings-settings-update-p-2" className="text-xs text-muted-foreground text-right">{Math.round(progress)}%</p>}
        </div>
      )}

      {statusLabel && (
        <p data-ui="settings-settings-update-p-3" className={cn(
          "text-sm",
          status === "error" ? "text-destructive" :
          status === "downloaded" ? "text-success" :
          "text-muted-foreground"
        )}>
          {statusLabel}
        </p>
      )}
    </div>
  )
}
