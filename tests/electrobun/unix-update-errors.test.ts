import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { unixUpdateErrorCode } from "../../electrobun/main/unix-update-errors"

test("ошибки файловой системы и integrity превращаются в локализуемые Unix коды", () => {
  expect(unixUpdateErrorCode(Object.assign(new Error("disk"), { code: "ENOSPC" }))).toBe("update-insufficient-space")
  expect(unixUpdateErrorCode(Object.assign(new Error("permissions"), { code: "EACCES" }))).toBe("update-no-permission")
  try { assert.equal(1, 2, "signature details") } catch (error) { expect(unixUpdateErrorCode(error)).toBe("update-verification-failed") }
  expect(unixUpdateErrorCode(new Error("update-recovery-required"))).toBe("update-recovery-required")
  expect(unixUpdateErrorCode(new Error("restart-cancelled"))).toBe("restart-cancelled")
})
