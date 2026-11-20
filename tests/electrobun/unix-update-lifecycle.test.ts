import { expect, test } from "bun:test"
import { unixUpdateStartupAction } from "../../electrobun/main/unix-update-lifecycle"
import { readFile } from "node:fs/promises"

const base = { nonce: "a".repeat(32), current: "old" as "old" | "next", inheritedNonce: undefined as string | undefined,
  live: false, ready: true, journal: true, result: undefined as string | undefined }
test("только ожидаемая B с nonce живого helper допускается к trial startup", () => {
  expect(unixUpdateStartupAction({ ...base, current: "next", live: true, inheritedNonce: base.nonce })).toBe("trial")
  expect(unixUpdateStartupAction({ ...base, current: "next", live: true })).toBe("busy")
  expect(() => unixUpdateStartupAction({ ...base, live: true, inheritedNonce: "b".repeat(32) })).toThrow()
})
test("незавершённая транзакция не открывает БД с непроверенным payload", () => {
  expect(unixUpdateStartupAction(base)).toBe("finish")
  expect(unixUpdateStartupAction({ ...base, ready: false, journal: false })).toBe("abandon")
  expect(unixUpdateStartupAction({ ...base, ready: false, journal: false, current: "next" })).toBe("blocked")
})
test("result не принимается за успех другого установленного payload", () => {
  expect(unixUpdateStartupAction({ ...base, current: "next", result: "committed" })).toBe("finish")
  expect(unixUpdateStartupAction({ ...base, result: "failed" })).toBe("finish")
  expect(() => unixUpdateStartupAction({ ...base, result: "committed" })).toThrow()
  expect(unixUpdateStartupAction({ ...base, current: "next", result: "failed" })).toBe("blocked")
})
test("resumeUnixUpdates вызывается до CEF, иначе сбойная B останется необнаруженной", async () => {
  const source = await readFile(new URL("../../electrobun/main/bootstrap.ts", import.meta.url), "utf8")
  expect(source.indexOf("resumeUnixUpdates(bundledWorker")).toBeLessThan(source.indexOf("assertLinuxCefRuntime(path.dirname"))
})
