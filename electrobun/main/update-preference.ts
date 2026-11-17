export type UpdatePreference = "stable" | "beta"

/** Новая установленная версия задаёт канал; ручной выбор действует до следующей установки. */
export function resolveUpdatePreference(version: string, savedVersion: unknown, saved: unknown): UpdatePreference {
  if (savedVersion === version && (saved === "stable" || saved === "beta")) return saved
  return version.includes("-pre") ? "beta" : "stable"
}
