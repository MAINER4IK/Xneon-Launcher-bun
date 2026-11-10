import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { compareReleaseVersions, verifySignedWindowsUpdateManifest } from "./verified-update-manifest"
import { updatePublicKeys } from "./update-public-keys"

export type UpdatePreference = "stable" | "beta"
type PackageChannel = "stable" | "canary"
type Manifest = ReturnType<typeof verifySignedWindowsUpdateManifest>
export type VerifiedUpdate = { manifest: Manifest; archiveUrl: string }
const repository = "MAINER4IK/Xneon-Launcher-bun"
const releaseList = `https://api.github.com/repos/${repository}/releases?per_page=30`
const assetHosts = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"])
const versionTag = /^v(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:-pre[1-9]\d{0,8})?$/

async function get(url: string, allowAssetRedirects: boolean, signal: AbortSignal): Promise<Response> {
  for (let hop = 0; hop <= 4; hop++) {
    const response = await fetch(url, { redirect: "manual", signal, headers: { "User-Agent": "Xneon-Launcher-Updater" } })
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (response.ok) return response
      await response.body?.cancel()
      throw new Error(`Update server returned HTTP ${response.status}`)
    }
    const location = response.headers.get("location")
    await response.body?.cancel()
    if (!allowAssetRedirects || !location || hop === 4) throw new Error("Unexpected update redirect")
    const next = new URL(location, url)
    if (next.protocol !== "https:" || next.username || next.password || next.port || !assetHosts.has(next.hostname)) {
      throw new Error("Update redirect points outside GitHub release assets")
    }
    url = next.href
  }
  throw new Error("Too many update redirects")
}

async function readBounded(response: Response, maximum: number): Promise<Buffer> {
  if (!response.body) throw new Error("Empty update response")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > maximum) throw new Error("Update metadata is oversized")
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks, size)
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export function selectUpdateTag(releases: unknown, current: string, preference: UpdatePreference) {
  if (!Array.isArray(releases)) throw new Error("Invalid GitHub release list")
  const eligible = releases.flatMap(item => {
    if (!item || typeof item.tag_name !== "string" || !versionTag.test(item.tag_name) ||
        item.draft !== false || typeof item.prerelease !== "boolean") return []
    const version = item.tag_name.slice(1)
    if (item.prerelease !== version.includes("-pre") || (preference === "stable" && item.prerelease)) return []
    return [version]
  }).sort((a, b) => compareReleaseVersions(b, a))
  return eligible.find(version => compareReleaseVersions(version, current) > 0) ?? null
}

export async function discoverVerifiedUpdate(current: string, channel: PackageChannel, preference: UpdatePreference): Promise<VerifiedUpdate | null> {
  if (Object.keys(updatePublicKeys).length === 0) throw new Error("Trusted update signing keys are not configured")
  const signal = AbortSignal.timeout(45_000)
  const releases = JSON.parse((await readBounded(await get(releaseList, false, signal), 2 * 1024 ** 2)).toString("utf8"))
  const version = selectUpdateTag(releases, current, preference)
  if (!version) return null
  const base = `https://github.com/${repository}/releases/download/v${version}/`
  const name = `${channel}-win-x64-update-v2.json`
  const [bytes, signature] = await Promise.all([
    get(base + name, true, signal).then(response => readBounded(response, 64 * 1024)),
    get(base + name + ".sig", true, signal).then(response => readBounded(response, 1024)),
  ])
  const manifest = verifySignedWindowsUpdateManifest(bytes, signature, updatePublicKeys,
    current, channel, preference === "beta" ? "canary" : "stable")
  if (manifest.version !== version) throw new Error("Signed update version does not match the GitHub tag")
  return { manifest, archiveUrl: base + manifest.artifact.file }
}

export async function stageVerifiedArchive(
  update: VerifiedUpdate, tempDirectory: string, signal: AbortSignal, progress: (bytes: number, total: number) => void,
) {
  const directory = await mkdtemp(path.join(tempDirectory, "xneon-update-"))
  const file = path.join(directory, update.manifest.artifact.file)
  const dispose = () => rm(directory, { recursive: true, force: true })
  const expected = update.manifest.artifact.downloadSize
  try {
    const response = await get(update.archiveUrl, true, signal)
    if (!response.body) throw new Error("Update archive is empty")
    const writer = Bun.file(file).writer()
    const reader = response.body.getReader()
    const digest = createHash("sha256")
    let bytes = 0
    try {
      for (;;) {
        signal.throwIfAborted()
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.length
        if (bytes > expected) throw new Error("Update archive exceeds its signed size")
        digest.update(chunk.value)
        writer.write(chunk.value)
        await writer.flush()
        progress(bytes, expected)
      }
    } finally {
      await reader.cancel().catch(() => {})
      await writer.end()
    }
    if (bytes !== expected || digest.digest("hex") !== update.manifest.artifact.downloadSha256) {
      throw new Error("Compressed update archive does not match signed metadata")
    }
    return { file, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

export function serveVerifiedUpdate(update: VerifiedUpdate, file: string, baseUrl?: string) {
  const address = baseUrl ? new URL(baseUrl) : null
  const prefix = address?.pathname ?? "/" + randomBytes(24).toString("hex") + "/"
  const { manifest } = update
  const server = Bun.serve({
    hostname: "127.0.0.1", port: address ? Number(address.port) : 0,
    fetch(request) {
      const url = new URL(request.url)
      if (request.method !== "GET") return new Response(null, { status: 405 })
      if (url.pathname === prefix + `${manifest.channel}-win-x64-update-v2.json`) return Response.json(manifest)
      if (url.pathname === prefix + manifest.artifact.file) return new Response(Bun.file(file))
      return new Response(null, { status: 404 })
    },
  })
  return { baseUrl: server.url.origin + prefix, stop: () => server.stop(true) }
}
