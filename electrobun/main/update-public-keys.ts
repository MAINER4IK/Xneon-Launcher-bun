// Public Ed25519 keys reviewed before publishing a signed update channel.
export const updatePublicKeys: Readonly<Record<string, string>> = Object.freeze({
  "ed25519-892052829307b55db09f6f02": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAOc0o+//R5yPiWZZLJvRO8TUrVaTIkh5G56D4r3czT0A=\n-----END PUBLIC KEY-----\n",
})

export type UpdateChannelKey = "stable" | "canary"

/**
 * Плоские URL-каталоги обновлений на GitHub Releases (без локального bridge).
 * Stable читает latest-релиз (prereleases исключены GitHub'ом), Beta — rolling-релиз
 * с фиксированным тегом `canary`, помеченный как prerelease, чтобы не перехватывать
 * «Latest».
 */
export const updateBaseUrls: Readonly<Record<UpdateChannelKey, string>> = Object.freeze({
  stable: "https://github.com/MAINER4IK/Xneon-Launcher-bun/releases/latest/download",
  canary: "https://github.com/MAINER4IK/Xneon-Launcher-bun/releases/download/canary",
})

/** База, которую обязана содержать `Resources/version.json` собранного канала. */
export function expectedUpdateBaseUrl(channel: UpdateChannelKey): string {
  const base = updateBaseUrls[channel]
  if (!base) throw new Error(`Unknown update channel: ${channel}`)
  return base
}