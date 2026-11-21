const MS_PER_DAY = 86_400_000

/**
 * Compute the `startTime` epoch (ms) for `chrome.history.search` given a lookback in days.
 * `0` (or negative) means all time (`startTime = 0`).
 */
export function historyStartTime(historyDays: number, now = Date.now()): number {
  if (!Number.isFinite(historyDays) || historyDays <= 0) return 0
  return Math.max(0, now - historyDays * MS_PER_DAY)
}

/**
 * Score how well a candidate (title + url) matches a user search query.
 * Higher score = more likely match. Returns 0 if not all query tokens match.
 */
export function scoreSearchMatch(query: string, title?: string, url?: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0

  const t = (title ?? '').toLowerCase()
  const u = (url ?? '').toLowerCase()
  const tokens = q.split(/\s+/).filter(Boolean)

  for (const tok of tokens) {
    if (!t.includes(tok) && !u.includes(tok)) return 0
  }

  let host = ''
  try {
    host = url ? new URL(url).hostname.toLowerCase() : ''
  } catch {
    host = ''
  }

  let score = 10
  if (t === q) score += 200
  else if (t.startsWith(q)) score += 120
  else if (t.includes(q)) score += 70

  if (host === q || host === `www.${q}`) score += 150
  else if (host.startsWith(q) || host.startsWith(`www.${q}`)) score += 90
  else if (host.includes(q)) score += 50
  else if (u.includes(q)) score += 20

  // Token-level bonuses for multi-word queries
  for (const tok of tokens) {
    const idx = t.indexOf(tok)
    if (idx === 0) score += 25
    else if (idx > 0 && /[\s\-_/.:()[\]]/.test(t[idx - 1])) score += 18
    else if (idx > 0) score += 10
    if (host.includes(tok)) score += 12
  }

  return score
}

/**
 * Filter and rank items by match likelihood (preserving original order on ties).
 */
export function rankSearchItems<T>(
  items: T[],
  query: string,
  getFields: (item: T) => { title?: string; url?: string; tieBreaker?: number }
): T[] {
  const q = query.trim()
  if (!q) return items

  const scored: Array<{ item: T; score: number; tie: number; idx: number }> = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const { title, url, tieBreaker = 0 } = getFields(item)
    const score = scoreSearchMatch(q, title, url)
    if (score > 0) scored.push({ item, score, tie: tieBreaker, idx: i })
  }

  scored.sort((a, b) => b.score - a.score || b.tie - a.tie || a.idx - b.idx)
  return scored.map(s => s.item)
}
