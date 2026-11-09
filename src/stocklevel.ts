/**
 * How many ready units to keep: five methods, one default. All pure, so they can be compared side by
 * side and tested with known numbers. Demand is a list of units sold (or assigned) per day, oldest
 * first, ending today.
 *
 * - statistical (default): expected demand over lead time + review period, plus safety stock
 *   z × σ × √(lead time + review period), with z from the service level.
 * - multiplier: average daily demand × days of cover.
 * - minmax: build when ready stock falls to the minimum, up to the maximum.
 * - trend: like statistical, but the expected demand follows a trend (Holt's double exponential
 *   smoothing), for growing, shrinking or seasonal demand.
 * - manual: a number you set. Also the fallback when there's too little history.
 */

export type StockMethod = 'statistical' | 'multiplier' | 'minmax' | 'trend' | 'manual'

export const STOCK_METHODS: { value: StockMethod; label: string; suits: string }[] = [
  {
    value: 'statistical',
    label: 'Safety stock (recommended)',
    suits: 'Steady demand with day-to-day ups and downs. Keeps enough for the build time, plus a margin sized to how much demand varies.',
  },
  { value: 'multiplier', label: 'Days of cover', suits: 'A simple rule you already use, such as "two weeks of sales". Ignores how much demand varies.' },
  { value: 'minmax', label: 'Minimum and maximum', suits: 'Building in set batches when stock gets low, or very low or irregular sales.' },
  { value: 'trend', label: 'Following the trend', suits: 'Demand that is growing, shrinking or seasonal, where last month is a poor guide to next week.' },
  { value: 'manual', label: 'A fixed number', suits: 'New products with no sales yet, or when you know better than the history.' },
]

export type StockSettings = {
  method?: StockMethod
  /** The fixed number (manual), and the fallback for every method without enough history. */
  manual?: number | null
  /** Days from deciding to build to units being ready. Default 5. */
  leadTimeDays?: number
  /** How often you check and build, in days. Default 1. */
  reviewDays?: number
  /** Chance of not running out between builds, 0.5 to 0.999. Default 0.95. */
  serviceLevel?: number
  /** multiplier: days of demand to keep. Default 14. */
  coverDays?: number
  /** minmax */
  min?: number | null
  max?: number | null
  /** trend: how fast the level (alpha) and trend (beta) follow recent days, 0 to 1. Defaults 0.3 and 0.1. */
  alpha?: number
  beta?: number
  /** Weight recent days more: a day this old counts half as much as today. Default 30. 0: all equal. */
  halfLifeDays?: number
  /** Days of history needed (from the first sale) before a method is trusted. Default 28. */
  minHistoryDays?: number
  /** The most built at once. The target is capped at it. */
  maxBatch?: number | null
}

export type Recommendation = {
  method: StockMethod
  /** Units to keep ready, or null when it can't say (no history and no fixed number). */
  target: number | null
  /** How many to build now, given the ready stock passed in (minmax: only once it falls to the minimum). */
  buildNow: number | null
  /** True when the method fell back to the fixed number. */
  fallback: boolean
  /** In plain words, with the numbers that led to it. */
  explanation: string
  figures: { mean: number | null; sd: number | null; trend: number | null; horizon: number | null; z: number | null; historyDays: number; capped: boolean }
}

const r1 = (n: number) => Math.round(n * 10) / 10
const r2 = (n: number) => Math.round(n * 100) / 100
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The z for a service level: the standard normal's inverse (Acklam's approximation, accurate to about
 * 1e-9). 0.95 → 1.645, 0.99 → 2.326.
 */
export function zFor(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError('The service level is between 0 and 1, for example 0.95.')
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const low = 0.02425
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  if (p > 1 - low) return -zFor(1 - p)
  const q = p - 0.5
  const rr = q * q
  return ((((((a[0]! * rr + a[1]!) * rr + a[2]!) * rr + a[3]!) * rr + a[4]!) * rr + a[5]!) * q) / (((((b[0]! * rr + b[1]!) * rr + b[2]!) * rr + b[3]!) * rr + b[4]!) * rr + 1)
}

/** The days from the first sale on (earlier zeros are before the product existed, not no demand). */
export function fromFirstSale(demand: number[]): number[] {
  const first = demand.findIndex((d) => d > 0)
  return first === -1 ? [] : demand.slice(first)
}

/**
 * Mean and standard deviation, weighting recent days more: a day `halfLifeDays` old counts half as
 * much as today (0: every day equal). The deviation is the weighted population one.
 */
export function weightedStats(demand: number[], halfLifeDays = 30): { mean: number; sd: number } {
  if (!demand.length) return { mean: 0, sd: 0 }
  const n = demand.length
  const w = demand.map((_, i) => (halfLifeDays > 0 ? Math.pow(0.5, (n - 1 - i) / halfLifeDays) : 1))
  const total = w.reduce((t, x) => t + x, 0)
  const mean = demand.reduce((t, x, i) => t + w[i]! * x, 0) / total
  const variance = demand.reduce((t, x, i) => t + w[i]! * (x - mean) ** 2, 0) / total
  return { mean, sd: Math.sqrt(variance) }
}

/** Holt's double exponential smoothing: today's level, the trend per day, and the typical one-day error. */
export function holt(demand: number[], alpha = 0.3, beta = 0.1): { level: number; trend: number; sd: number } {
  if (demand.length < 2) return { level: demand[0] ?? 0, trend: 0, sd: 0 }
  let level = demand[0]!
  let trend = demand[1]! - demand[0]!
  const errors: number[] = []
  for (let i = 1; i < demand.length; i++) {
    const forecast = level + trend
    errors.push(demand[i]! - forecast)
    const prev = level
    level = alpha * demand[i]! + (1 - alpha) * (level + trend)
    trend = beta * (level - prev) + (1 - beta) * trend
  }
  const sd = Math.sqrt(errors.reduce((t, e) => t + e * e, 0) / errors.length)
  return { level, trend, sd }
}

const defaults = (s: StockSettings) => ({
  method: s.method ?? 'statistical',
  manual: typeof s.manual === 'number' && s.manual >= 0 ? s.manual : null,
  lead: s.leadTimeDays ?? 5,
  review: s.reviewDays ?? 1,
  service: s.serviceLevel ?? 0.95,
  cover: s.coverDays ?? 14,
  min: typeof s.min === 'number' ? s.min : null,
  max: typeof s.max === 'number' ? s.max : null,
  alpha: s.alpha ?? 0.3,
  beta: s.beta ?? 0.1,
  halfLife: s.halfLifeDays ?? 30,
  minHistory: s.minHistoryDays ?? 28,
  maxBatch: typeof s.maxBatch === 'number' && s.maxBatch > 0 ? s.maxBatch : null,
})

/** One method's recommendation, with its reasoning. `ready` is how many are ready now. */
export function recommend(demand: number[], settings: StockSettings = {}, ready?: number, methodOverride?: StockMethod): Recommendation {
  const s = defaults(settings)
  const method = methodOverride ?? s.method
  const history = fromFirstSale(demand)
  const figures: Recommendation['figures'] = { mean: null, sd: null, trend: null, horizon: null, z: null, historyDays: history.length, capped: false }
  const build = (target: number | null) => (target === null || ready === undefined ? null : Math.max(target - ready, 0))
  const manual = (why: string | null): Recommendation => ({
    method,
    target: s.manual,
    buildNow: build(s.manual),
    fallback: why !== null,
    figures,
    explanation:
      (why ? `${why} ` : '') + (s.manual === null ? 'Set a fixed number to keep ready until there is.' : `${why ? 'Using the fixed number: keep' : 'A fixed number you set: keep'} ${s.manual} ready.`),
  })
  const cap = (target: number, text: string): Recommendation => {
    let t = Math.max(Math.ceil(target - 1e-9), 0)
    let explanation = text.replace('{target}', String(t))
    if (s.maxBatch !== null && t > s.maxBatch) {
      t = s.maxBatch
      figures.capped = true
      explanation += ` Capped at ${s.maxBatch}, the most you build at once.`
    }
    return { method, target: t, buildNow: build(t), fallback: false, figures, explanation }
  }

  if (method === 'manual') return manual(null)
  if (method === 'minmax') {
    if (s.min === null || s.max === null || s.max < s.min) return manual('Set a minimum and a maximum (at least the minimum) first.')
    const now = ready === undefined ? null : ready <= s.min ? Math.max(s.max - ready, 0) : 0
    const explanation =
      `Build when ready stock falls to ${s.min}, up to ${s.max}.` +
      (ready === undefined ? '' : ready <= s.min ? ` You have ${ready}, so build ${now}.` : ` You have ${ready}, so nothing to build yet.`)
    return { method, target: s.max, buildNow: now, fallback: false, figures, explanation }
  }
  if (history.length < s.minHistory)
    return manual(history.length === 0 ? 'No sales in the history yet.' : `Not enough history yet: ${plural(history.length, 'day')} since the first sale (needs ${s.minHistory}).`)

  const horizon = s.lead + s.review
  figures.horizon = horizon
  const since = `over the last ${plural(history.length, 'day')}`
  const timing = `a ${s.lead}-day build and ${s.review === 1 ? 'a daily check' : `a check every ${s.review} days`}`
  if (method === 'multiplier') {
    const { mean } = weightedStats(history, s.halfLife)
    figures.mean = mean
    return cap(mean * s.cover, `About ${r1(mean)} a day ${since} × ${plural(s.cover, 'day')} of cover → keep {target} ready.`)
  }
  const z = zFor(s.service)
  figures.z = z
  const pct = `${r1(s.service * 100)}%`
  if (method === 'trend') {
    const h = holt(history, s.alpha, s.beta)
    figures.mean = h.level
    figures.trend = h.trend
    figures.sd = h.sd
    let expected = 0
    for (let i = 1; i <= horizon; i++) expected += Math.max(h.level + i * h.trend, 0)
    const safety = z * h.sd * Math.sqrt(horizon)
    const direction = Math.abs(h.trend) < 0.05 ? 'steady' : h.trend > 0 ? `rising by about ${r2(h.trend)} a day` : `falling by about ${r2(-h.trend)} a day`
    return cap(
      expected + safety,
      `About ${r1(h.level)} a day now and ${direction}, ${timing}, ${pct} service → keep {target} ready (${r1(expected)} expected, plus ${r1(safety)} safety stock).`,
    )
  }
  const { mean, sd } = weightedStats(history, s.halfLife)
  figures.mean = mean
  figures.sd = sd
  const expected = mean * horizon
  const safety = z * sd * Math.sqrt(horizon)
  return cap(expected + safety, `About ${r1(mean)} a day ${since}, ${timing}, ${pct} service → keep {target} ready (${r1(expected)} expected, plus ${r1(safety)} safety stock).`)
}

/** Every method side by side, the chosen one first, so the admin can compare before choosing. */
export function compareMethods(demand: number[], settings: StockSettings = {}, ready?: number): Recommendation[] {
  const chosen = settings.method ?? 'statistical'
  return [chosen, ...STOCK_METHODS.map((m) => m.value).filter((m) => m !== chosen)].map((m) => recommend(demand, settings, ready, m))
}

/**
 * Daily demand from dated sales, oldest first, ending today: `windowDays` numbers (default 90),
 * zeros on days without sales. Days are UTC days.
 */
export function dailyDemand(sales: { at: string | Date; quantity?: number }[], windowDays = 90, now = new Date()): number[] {
  const day = (t: number) => Math.floor(t / 86_400_000)
  const today = day(now.getTime())
  const out = new Array<number>(windowDays).fill(0)
  for (const s of sales) {
    const age = today - day(new Date(s.at).getTime())
    if (age >= 0 && age < windowDays) out[windowDays - 1 - age]! += s.quantity ?? 1
  }
  return out
}

/** A recipe's "Ready stock" settings as the methods take them (service level stored as a %). */
export function settingsFromRecipe(recipe: Record<string, any>): StockSettings & { windowDays: number } { // eslint-disable-line @typescript-eslint/no-explicit-any
  const g = recipe.readyStock ?? {}
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const service = n(g.serviceLevel)
  return {
    method: g.method ?? undefined,
    manual: n(g.manual) ?? null,
    leadTimeDays: n(g.leadTimeDays),
    reviewDays: n(g.reviewDays),
    serviceLevel: service === undefined ? undefined : Math.min(Math.max(service / 100, 0.5), 0.999),
    coverDays: n(g.coverDays),
    min: n(g.min) ?? null,
    max: n(g.max) ?? null,
    maxBatch: n(recipe.maxPerBatch) ?? null,
    windowDays: n(g.windowDays) ?? 90,
  }
}
