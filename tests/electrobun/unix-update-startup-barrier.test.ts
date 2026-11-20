import { expect, test } from "bun:test"
import { UnixUpdateStartupBarrier } from "../../electrobun/platform/unix-update-startup-barrier"

test("ack и чтение темы не ждут commit, auth/launch и фоновые side effects ждут", async () => {
  const barrier = new UnixUpdateStartupBarrier(), commit = Promise.withResolvers<void>()
  barrier.hold(commit.promise)
  expect(barrier.waitForRpc("startup:update-ready")).toBeNull()
  expect(barrier.waitForRpc("startup:ready")).toBeNull()
  expect(barrier.waitForRpc("settings:get-many")).toBeNull()
  let invoked = false
  const delayed = barrier.waitForRpc("auth:microsoft-login")!.then(() => { invoked = true })
  await Promise.resolve(); expect(invoked).toBe(false)
  commit.resolve(); await delayed; expect(invoked).toBe(true)
  expect(barrier.waitForRpc("minecraft:launch")).toBeNull()
})
