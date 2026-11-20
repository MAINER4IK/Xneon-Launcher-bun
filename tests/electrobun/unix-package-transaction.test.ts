// Пакетная транзакция helper: меняет установку только через системный manager и при
// сбое ничего не переустанавливает. Автоматического отката нет.
import { expect, test } from "bun:test"
import { applyUnixPackageTransaction, type UnixPackageTransactionPorts } from "../../electrobun/main/unix-package-transaction"

function fixture(patch: Partial<UnixPackageTransactionPorts> = {}) {
  const events: string[] = []
  const step = (name: string) => async () => { events.push(name) }
  const ports: UnixPackageTransactionPorts = { verifyNextPackage: step("verify-file-B"), ready: step("ready"),
    waitForParentExit: step("exit-A"), backupProfile: step("backup-db"), installNext: step("install-B"), verifyNextInstalled: step("verify-B"),
    startNext: async () => { events.push("start-B"); return { pid: 100 } }, waitHealthy: async () => { events.push("health-B"); return true }, stopNext: step("stop-B"),
    record: async phase => { events.push("phase:" + phase) }, ...patch }
  return { events, ports }
}
test("пакет B устанавливается только после проверки файла и выхода A", async () => {
  const app = fixture()
  expect((await applyUnixPackageTransaction(app.ports)).status).toBe("committed")
  expect(app.events.indexOf("verify-file-B")).toBeLessThan(app.events.indexOf("ready"))
  expect(app.events.indexOf("exit-A")).toBeLessThan(app.events.indexOf("install-B"))
  expect(app.events.indexOf("health-B")).toBeLessThan(app.events.indexOf("phase:committed"))
})
test("непроверенная B не позволяет закрыть текущее приложение", async () => {
  const app = fixture({ verifyNextPackage: async () => { throw new Error("update-verification-failed") } })
  await expect(applyUnixPackageTransaction(app.ports)).rejects.toThrow(/update-verification-failed/)
  expect(app.events).not.toContain("exit-A")
  expect(app.events).not.toContain("install-B")
})
test("неудачный запуск B останавливает его и фиксирует failed, не трогая установку", async () => {
  const app = fixture({ waitHealthy: async () => false })
  await expect(applyUnixPackageTransaction(app.ports)).rejects.toThrow(/update-startup-failed/)
  expect(app.events.indexOf("stop-B")).toBeLessThan(app.events.indexOf("phase:failed"))
  expect(app.events).not.toContain("phase:committed")
})
test("отмена polkit не запускает новый пакет и фиксирует failed", async () => {
  const app = fixture({ installNext: async () => { throw new Error("update-install-cancelled") } })
  await expect(applyUnixPackageTransaction(app.ports)).rejects.toThrow(/update-install-cancelled/)
  expect(app.events).not.toContain("start-B")
  expect(app.events).toContain("phase:failed")
})
test("сбой проверки после установки не объявляет обновление успешным", async () => {
  const app = fixture({ verifyNextInstalled: async () => { throw new Error("update-verification-failed") } })
  await expect(applyUnixPackageTransaction(app.ports)).rejects.toThrow(/update-verification-failed/)
  expect(app.events).not.toContain("start-B")
  expect(app.events).toContain("phase:failed")
})