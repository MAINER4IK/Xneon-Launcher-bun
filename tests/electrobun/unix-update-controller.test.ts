import { expect, test } from "bun:test"
import { createUnixUpdateController } from "../../electrobun/main/unix-update-controller"

function fixture() {
  const events: string[] = [], local = { identifier: "org.xneon.launcher", platform: "linux", arch: "x64", channel: "stable", version: "1.0.8", hash: "old" }
  let pending: any = null, selected = "stable"
  const update: any = { manifest: { version: "1.0.9", hash: "new", channel: "stable" } }
  const ports: any = {
    context: async () => ({ local, installation: { kind: "directory", target: "/app", platform: "linux" } }),
    store: { getChannel: async () => selected, selectChannel: async (value: string) => { selected = value; pending = null },
      peek: async () => pending, stage: async () => { pending = { update, path: "/payload", deferred: false } }, defer: async () => { pending.deferred = true } },
    resolve: async () => update, download: async () => { events.push("download"); return "/payload" },
    handoff: async () => { events.push("ready"); return { cancel: async () => { events.push("cancel") } } },
    drain: async () => { events.push("drain") }, cleanup: async () => { events.push("cleanup") }, closeDatabase: () => { events.push("close-db") },
    reopen: async () => { events.push("reopen") }, quit: async () => { events.push("quit") }, block: (value: boolean) => { events.push(`block:${value}`) },
    activeLaunch: () => false, send: () => {},
  }
  return { ports, events, controller: createUnixUpdateController(ports) }
}
test("выбор канала не скачивает и не запускает helper", async () => {
  const { controller, events } = fixture()
  expect(await controller.setChannel("beta")).toEqual({ state: "selected" })
  expect(await controller.getChannel()).toBe("beta")
  expect(events).toEqual([])
})
test("check/download/defer восстанавливаются через существующий update state", async () => {
  const { controller, events } = fixture()
  expect((await controller.check()).available).toBe(true)
  expect(await controller.download()).toEqual({ success: true })
  expect(await controller.defer()).toEqual({ success: true })
  expect(await controller.getState()).toEqual({ status: "downloaded", version: "1.0.9", deferred: true })
  expect(events).toEqual(["download"])
})
test("main закрывает БД и выходит только после helper ready и cleanup", async () => {
  const { controller, events } = fixture()
  await controller.check(); await controller.download(); await controller.install()
  expect(events).toEqual(["download", "block:true", "drain", "ready", "cleanup", "close-db", "quit"])
})
test("неудача cleanup отменяет helper, оставляет A и снимает restart barrier", async () => {
  const { controller, ports, events } = fixture()
  ports.cleanup = async () => { throw new Error("cleanup-failed") }
  await controller.check(); await controller.download(); await controller.install()
  expect(events).toContain("cancel")
  expect(events).not.toContain("quit")
  expect(events.at(-1)).toBe("block:false")
})
test("работающая Minecraft не позволяет начать handoff", async () => {
  const { controller, ports, events } = fixture()
  await controller.check(); await controller.download(); ports.activeLaunch = () => true
  await controller.install()
  expect(events).not.toContain("ready")
})
