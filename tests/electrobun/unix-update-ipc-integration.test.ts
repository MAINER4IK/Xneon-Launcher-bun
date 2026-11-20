import { expect, test } from "bun:test"
import { validateInvokeArgs } from "../../electrobun/platform/ipc-validation"
import { mkdtemp, rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import os from "node:os"

test("startup health RPC не принимает nonce/identity/пути от renderer", () => {
  expect(() => validateInvokeArgs("startup:update-ready", [])).not.toThrow()
  expect(() => validateInvokeArgs("startup:update-ready", ["spoofed-nonce"])).toThrow()
})

test("настоящие IPC/controller/signed store и child handshake работают совместно (не native E2E)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xneon-controller-integration-"))
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(new URL("../fixtures/unix-controller-integration.ts", import.meta.url)), root], { stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, stderr).toBe(0)
    expect(stdout).toContain("UNIX_CONTROLLER_PROTOCOL_INTEGRATION_PASS_NOT_NATIVE_E2E")
  } finally { await rm(root, { recursive: true, force: true }) }
}, 20_000)
