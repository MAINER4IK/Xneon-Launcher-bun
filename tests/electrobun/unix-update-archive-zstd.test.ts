import { expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, lstat, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createZstdCompress } from "node:zlib"
import os from "node:os"
import path from "node:path"
import {
  assertZstdSize, decompressUnixUpdateArchive, extractUnixUpdateArchive, inspectUnixUpdateTar,
} from "../../electrobun/main/unix-update-archive"

const root = "XneonLauncher"
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex")

/** Реальный потоковый Zstd-кадр: энкодер не знает итоговый размер и Content Size не пишет. */
async function streamingFrame(data: Buffer) {
  const stream = createZstdCompress()
  const chunks: Buffer[] = []
  stream.on("data", chunk => chunks.push(chunk))
  const done = new Promise<void>((resolve, reject) => { stream.once("end", resolve); stream.once("error", reject) })
  for (let offset = 0; offset < data.length; offset += 64 * 1024) stream.write(data.subarray(offset, offset + 64 * 1024))
  stream.end()
  await done
  return Buffer.concat(chunks)
}

/** Реальный кадр с объявленным Content Size. */
function sizedFrame(data: Buffer) {
  return Buffer.from(Bun.zstdCompressSync(data))
}

type Entry = { name: string; data?: string; type?: string; link?: string }
function tar(entries: Entry[]) {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "")
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100, "utf8"); header.write("0000755\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116)
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124)
    header.fill(32, 148, 156); header.write(entry.type ?? "0", 156); header.write(entry.link ?? "", 157, 100, "utf8"); header.write("ustar\0", 257)
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148)
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512))
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)])
}
const bundle = () => tar([{ name: root, type: "5" }, { name: `${root}/bin/bun`, data: "executable" }, { name: `${root}/bin/bun Helper`, type: "2", link: "bun" }])

/** Тестовые данные под три типа блоков: сжимаемые, несжимаемые и RLE. */
const compressible = Buffer.alloc(400_000); for (let index = 0; index < compressible.length; index++) compressible[index] = (index * 31) % 251
const payloads = {
  compressible,
  incompressible: randomBytes(300_000),
  repeated: Buffer.alloc(300_000, 7),
}

test("объявленный Content Size реального кадра совпадает с подписанным tarSize", () => {
  const data = bundle(), frame = sizedFrame(data)
  expect(frame[4] >> 6).not.toBe(0)
  expect(() => assertZstdSize(frame, data.length)).not.toThrow()
  expect(() => assertZstdSize(frame, data.length + 1)).toThrow(/content size differs/)
})

test("потоковый кадр без Content Size принимается: размер проверяется распаковкой", async () => {
  const data = bundle(), frame = await streamingFrame(data)
  expect(frame[4] >> 6).toBe(0)
  expect(() => assertZstdSize(frame, data.length)).not.toThrow()
  expect(await decompressUnixUpdateArchive(frame, data.length)).toEqual(data)
})

for (const [name, payload] of Object.entries(payloads)) test(`потоковый кадр (${name}) распаковывается ровно в подписанный размер`, async () => {
  const frame = await streamingFrame(payload)
  expect(await decompressUnixUpdateArchive(frame, payload.length)).toEqual(payload)
})

test("несколько кадров подряд суммируются в подписанный размер", async () => {
  const first = sizedFrame(compressible), second = await streamingFrame(payloads.repeated)
  const archive = Buffer.concat([first, second])
  expect(await decompressUnixUpdateArchive(archive, compressible.length + payloads.repeated.length))
    .toEqual(Buffer.concat([compressible, payloads.repeated]))
})

test("потоковый архив, который разворачивается больше подписанного размера, отвергается", async () => {
  const frame = await streamingFrame(compressible)
  await expect(decompressUnixUpdateArchive(frame, compressible.length - 1)).rejects.toThrow(/exceeds signed tar size/)
})

test("потоковый архив, который разворачивается меньше подписанного размера, отвергается", async () => {
  const frame = await streamingFrame(compressible)
  await expect(decompressUnixUpdateArchive(frame, compressible.length + 1)).rejects.toThrow(/Update tar size mismatch/)
})

test("усечённые данные кадра, усечённый заголовок блока и мусор после кадра отвергаются", async () => {
  const frame = await streamingFrame(bundle())
  await expect(decompressUnixUpdateArchive(frame.subarray(0, frame.length - 12), bundle().length)).rejects.toThrow(/Truncated Zstd/)
  await expect(decompressUnixUpdateArchive(frame.subarray(0, 7), bundle().length)).rejects.toThrow(/Truncated Zstd/)
  await expect(decompressUnixUpdateArchive(Buffer.concat([frame, Buffer.from("junk")]), bundle().length)).rejects.toThrow(/Invalid Zstd frame/)
  await expect(decompressUnixUpdateArchive(Buffer.alloc(0), bundle().length)).rejects.toThrow(/Empty Zstd update/)
})

test("Zstd-словарь и неподдерживаемые флаги кадра отвергаются", async () => {
  const frame = await streamingFrame(bundle())
  const dictionary = Buffer.from(frame); dictionary[4] |= 1
  expect(() => assertZstdSize(dictionary, bundle().length)).toThrow(/dictionary/)
  const reserved = Buffer.from(frame); reserved[4] |= 8
  expect(() => assertZstdSize(reserved, bundle().length)).toThrow(/Unsupported Zstd frame flags/)
})

test("потоковый архив извлекается целиком и сохраняет внутреннюю ссылку", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xneon-update-zstd-"))
  try {
    const data = bundle(), frame = await streamingFrame(data)
    const artifact = { file: "fixture.tar.zst", format: "electrobun-tar-zstd" as const, downloadSize: frame.length, downloadSha256: sha(frame), tarSize: data.length, tarSha256: sha(data) }
    const source = path.join(directory, "archive.zst")
    await writeFile(source, frame)
    const destination = path.join(directory, "stage")
    await extractUnixUpdateArchive(source, destination, root, artifact)
    expect((await lstat(path.join(destination, root, "bin/bun Helper"))).isSymbolicLink()).toBe(true)
    expect((await readFile(path.join(destination, root, "bin/bun"))).toString()).toBe("executable")
    expect(inspectUnixUpdateTar(data, root).map(entry => entry.name)).toEqual([root, `${root}/bin/bun`, `${root}/bin/bun Helper`])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

for (const [name, apply] of [
  ["неверный SHA-256 tar", (base: { tarSize: number; tarSha256: string }) => ({ ...base, tarSha256: "0".repeat(64) })],
  ["неверный размер tar", (base: { tarSize: number; tarSha256: string }) => ({ ...base, tarSize: base.tarSize + 512 })],
] as const) test(`извлечение отвергает ${name} и не публикует каталог`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xneon-update-zstd-"))
  try {
    const data = bundle(), frame = await streamingFrame(data)
    const artifact = apply({ tarSize: data.length, tarSha256: sha(data) })
    const source = path.join(directory, "archive.zst")
    await writeFile(source, frame)
    await expect(extractUnixUpdateArchive(source, path.join(directory, "stage"), root, {
      file: "fixture.tar.zst", format: "electrobun-tar-zstd", downloadSize: frame.length, downloadSha256: sha(frame), ...artifact,
    })).rejects.toThrow()
    expect((await readdir(directory)).includes("stage")).toBe(false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})