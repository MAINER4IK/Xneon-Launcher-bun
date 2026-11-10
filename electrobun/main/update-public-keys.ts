// Add reviewed Ed25519 public keys before publishing a signed update channel.
export const updatePublicKeys: Readonly<Record<string, string>> = Object.freeze({
  "ed25519-892052829307b55db09f6f02": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAOc0o+//R5yPiWZZLJvRO8TUrVaTIkh5G56D4r3czT0A=\n-----END PUBLIC KEY-----\n",
})

// Must match the native helper identity recorded in Resources/version.json.
export const verifiedUpdateBridgeUrl = "http://127.0.0.1:53749/xneon-verified-update/"
