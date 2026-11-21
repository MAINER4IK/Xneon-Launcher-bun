import type { ModdexReviews } from "@xnlc/types"

function httpsUrl(value: unknown): string {
  try { const url = new URL(String(value)); return url.protocol === "https:" ? url.href : "" } catch { return "" }
}

function category(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 5 ? value : null
}

function histogramAverage(value: unknown): number | null {
  if (!Array.isArray(value)) return null
  let sum = 0, count = 0
  for (const step of value) {
    if (category(step?.rating) !== null && Number.isFinite(step?.count) && step.count > 0) { sum += step.rating * step.count; count += step.count }
  }
  return count ? sum / count : null
}

export async function fetchModdexReviews(project: string, page = 1, request: typeof fetch = fetch, sort: "newest" | "oldest" | "rating" | "helpful" = "newest", source: "modrinth" | "curseforge" = "modrinth", type: "mod" | "modpack" = "mod"): Promise<ModdexReviews> {
  if (typeof project !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(project) || !Number.isInteger(page) || page < 1 || page > 10000) throw new Error("Invalid project or page")
  if (!["newest", "oldest", "rating", "helpful"].includes(sort)) throw new Error("Invalid sort")
  if (source !== "modrinth" && source !== "curseforge") throw new Error("Invalid review source")
  if (type !== "mod" && type !== "modpack") throw new Error("Invalid review project type")
  const lookupUrl = `https://moddex.gg/api/v2/lookup/${source}/${encodeURIComponent(project)}`
  const url = new URL(`${lookupUrl}/reviews`)
  url.searchParams.set("type", type)
  url.searchParams.set("page", String(page))
  url.searchParams.set("sort", sort)
  const response = await request(url, { headers: { Accept: "application/json", "X-Client": "xneon-launcher" }, signal: AbortSignal.timeout(10000) })
  const empty: ModdexReviews = { status: "not-found", reviews: [], average: null, categories: { gameplay: null, performance: null, aesthetics: null }, count: 0, page: 1, lastPage: 1, writeUrl: "https://moddex.gg" }
  if (response.status === 404) return empty
  if (!response.ok) throw new Error(`ModDex HTTP ${response.status}`)
  const payload = await response.json() as any
  if (!Array.isArray(payload.data)) throw new Error("Invalid ModDex response")
  // Неполный ответ — не повод падать в UI: отзывы показываем, а всё, что
  // зависит от meta.project (рейтинг, счётчик, ссылка), остаётся пустым.
  const meta = payload.meta && typeof payload.meta === "object" ? payload.meta : {}
  const projectMeta = meta.project && typeof meta.project === "object" ? meta.project : {}
  const detailsUrl = new URL(lookupUrl)
  detailsUrl.searchParams.set("type", type)
  detailsUrl.searchParams.set("include", "ratings")
  const details = await request(detailsUrl, { headers: { Accept: "application/json", "X-Client": "xneon-launcher" }, signal: AbortSignal.timeout(10000) }).then(response => response.ok ? response.json() : null).catch(() => null) as any
  const histograms = details?.data?.ratings?.categories
  const rating = projectMeta.rating
  const candidate = projectMeta.links?.write_review
  let writeUrl = "https://moddex.gg"
  try { const parsed = new URL(candidate); if (parsed.protocol === "https:" && (parsed.hostname === "moddex.gg" || parsed.hostname.endsWith(".moddex.gg"))) writeUrl = parsed.href } catch {}
  return {
    status: "ok",
    reviews: payload.data.slice(0, 50).map((review: any) => ({
      id: Number(review.id), author: String(review.author?.name ?? ""), avatarUrl: httpsUrl(review.author?.avatar_url), profileUrl: httpsUrl(review.author?.profile_url),
      rating: Number(review.rating) || 0, title: String(review.title ?? ""), content: String(review.content ?? ""), date: String(review.created_at ?? ""),
      edited: Boolean(review.edited_at), isDeveloper: review.is_verified_developer === true,
      categories: { gameplay: category(review.categories?.gameplay), performance: category(review.categories?.performance), aesthetics: category(review.categories?.aesthetics) },
      minecraftVersion: String(review.minecraft_version ?? ""), playtimeHours: typeof review.playtime_hours === "number" ? review.playtime_hours : null,
      helpfulVotes: Number(review.helpful_votes) || 0, developerResponse: String(review.developer_response?.content ?? ""),
    })),
    average: typeof rating?.average === "number" ? rating.average : null,
    categories: { gameplay: histogramAverage(histograms?.gameplay), performance: histogramAverage(histograms?.performance), aesthetics: histogramAverage(histograms?.aesthetics) },
    count: Number(rating?.count) || 0,
    page: Number(meta.current_page) || 1,
    lastPage: Math.max(1, Number(meta.last_page) || 1),
    writeUrl,
  }
}
