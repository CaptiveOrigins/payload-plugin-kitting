import type { CollectionSlug, Payload, PayloadRequest, Where } from 'payload'

import { cheapestPerBox, type LengthUnit, type PackedBox, type ShippingAddress, type ShippingProvider } from './contracts/shipping.js'
import { findRecipe, idOf, KittingError, num, sameID, suppliesOf } from './stock.js'
import type { ID, RecipeRef } from './types.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Req = Partial<PayloadRequest>

const list = { overrideAccess: true, depth: 0, pagination: false, joins: false } as const

/** A box type as packing sees it: how many fit (after its weight limit), and what it costs. */
export type BoxOption = { id: ID; name: string; capacity: number; cost: number; emptyWeight: number; dimensions: PackedBox['dimensions'] | null }

export type Packing = {
  boxes: { box: BoxOption; units: number; weight: number | null; postage: number | null }[]
  boxCost: number
  postage: number | null
  total: number | null
  emptySlots: number
  /** Where the postage came from. */
  basis: 'carrier' | 'postage-rates' | 'none'
  summary: string
}

/** Set when a rate provider was configured but failed: the suggestions use your postage rates instead. */
export type RatesFallback = { provider: string; error: string }

/** A rate provider that isn't a function of the right shape, or gave back something that isn't a rate list. */
export class RateProviderShapeError extends Error {
  override name = 'RateProviderShapeError'
}

/** Throws unless `provider` has a `quoteRates` function. Shared by startup and each suggestion. */
export function assertRateProvider(provider: unknown, where: string): asserts provider is ShippingProvider {
  if (provider && typeof provider === 'object' && typeof (provider as ShippingProvider).quoteRates === 'function') return
  const shippingLike = provider && typeof provider === 'object' && typeof (provider as { quote?: unknown }).quote === 'function'
  throw new RateProviderShapeError(
    `Kitting: ${where} has no \`quoteRates\` function${shippingLike ? ' (it has `quote`, like the Shipping plugin’s carrier provider)' : ''}. ` +
      'To use the Shipping plugin’s rates, pass `shipping: { provider: ratesFromShipping({ quote }) }`, with `quote` imported from the Shipping plugin. Any other provider needs `name` and `quoteRates`.',
  )
}

/** Each provider's failure is logged once per kind of error, so a carrier that's down doesn't flood the log. */
const logged = new WeakMap<object, Set<string>>()
const notAnObject = {}
function logOnce(payload: Payload, provider: object, providerName: string, errorName: string) {
  const seen = logged.get(provider) ?? new Set<string>()
  logged.set(provider, seen)
  if (seen.has(errorName)) return
  seen.add(errorName)
  payload.logger.warn(`kitting: rates unavailable from ${providerName} (${errorName}); box suggestions use your postage rates. Logged once.`)
}

/**
 * The ways to pack `count` units: all in one box type, or one type plus one other box for the rest.
 * Pure, so it can be tested with known boxes.
 */
export function packings(count: number, boxes: BoxOption[]): { box: BoxOption; units: number }[][] {
  const out = new Map<string, { box: BoxOption; units: number }[]>()
  for (const a of boxes) {
    const full = Math.floor(count / a.capacity)
    const rest = count - full * a.capacity
    const main = Array.from({ length: full }, () => ({ box: a, units: a.capacity }))
    const options = rest === 0 ? [main] : boxes.filter((b) => b.capacity >= rest).map((b) => [...main, { box: b, units: rest }])
    for (const p of options) {
      if (!p.length) continue
      const key = p
        .map((x) => `${String(x.box.id)}:${x.units}`)
        .sort()
        .join('|')
      out.set(key, p)
    }
  }
  return [...out.values()]
}

/** The cheapest postage band a parcel of `grams` fits, or null. */
export function postageFor(grams: number | null, rates: { upToGrams: number; cost: number }[]): number | null {
  if (grams === null) return null
  const fitting = rates.filter((r) => r.upToGrams >= grams).map((r) => r.cost)
  return fitting.length ? Math.min(...fitting) : null
}

const money = (n: number, currency: string) => new Intl.NumberFormat('en', { style: 'currency', currency }).format(n)

/** Rank: known total first and cheapest, then fewest boxes, then least empty space. */
export const byCost = (a: Packing, b: Packing) =>
  (a.total ?? Infinity) - (b.total ?? Infinity) || (a.total === null && b.total === null ? a.boxCost - b.boxCost : 0) || a.boxes.length - b.boxes.length || a.emptySlots - b.emptySlots

/**
 * Suggest how to pack `count` units of a recipe, best by cost first: box cost plus postage, from a
 * shipping plugin's real rates when there is one, otherwise your postage rates. Says which it used,
 * and why when it fell back.
 */
export async function recommendBoxes(
  payload: Payload,
  args: { recipe: RecipeRef; count: number; scope?: ID; to?: ShippingAddress; from?: ShippingAddress; reference?: string; limit?: number; req?: Req; provider?: ShippingProvider | null },
): Promise<{ packings: Packing[]; notes: string[]; currency: string; fallback?: RatesFallback }> {
  const o = suppliesOf(payload)
  const req = args.req ?? {}
  if (!Number.isInteger(args.count) || args.count < 1) throw new KittingError('count', 'The count is a whole number, 1 or more.')
  const r = await findRecipe(payload, o, req, args.recipe, args.scope)
  const scope = o.scopeField ? idOf(r[o.scopeField]) : null
  const scoped: Where[] = o.scopeField ? [{ [o.scopeField]: { equals: scope } }] : []
  const unitWeight = num(r.unitWeight)
  const notes: string[] = []
  let fallback: RatesFallback | undefined
  const boxes: BoxOption[] = []
  const fitBox = (b: { id: ID; name: string; capacity: number; cost?: number; emptyWeight?: number; maxWeight?: number | null; dimensions?: BoxOption['dimensions'] }) => {
    let capacity = b.capacity
    const empty = b.emptyWeight ?? 0
    if (b.maxWeight != null && unitWeight) capacity = Math.min(capacity, Math.floor((b.maxWeight - empty) / unitWeight))
    if (capacity >= 1) boxes.push({ id: b.id, name: b.name, capacity, cost: b.cost ?? 0, emptyWeight: empty, dimensions: b.dimensions ?? null })
  }
  if (o.boxSource) {
    for (const b of await o.boxSource({ payload, req, recipe: { id: r.id, key: String(r.key), name: String(r.name) }, scope })) fitBox(b)
  } else {
    const boxDocs = (await payload.find({ collection: o.boxes as CollectionSlug, where: { and: [{ active: { not_equals: false } }, ...scoped] }, ...list, req })).docs as Doc[]
    for (const b of boxDocs) {
      const fit = ((b.fits ?? []) as Doc[]).find((f) => sameID(f.recipe, r.id))
      if (!fit) continue
      const [l, w, h] = [num(b.outsideLength), num(b.outsideWidth), num(b.outsideHeight)]
      fitBox({
        id: b.id,
        name: String(b.name),
        capacity: num(fit.units) ?? 0,
        cost: num(b.cost) ?? 0,
        emptyWeight: num(b.emptyWeight) ?? 0,
        maxWeight: num(b.maxWeight),
        dimensions: l && w && h ? { length: l, width: w, height: h, unit: (b.outsideUnit ?? 'cm') as LengthUnit } : null,
      })
    }
  }
  if (!boxes.length)
    return { packings: [], notes: [o.boxSource ? `No box in your list takes "${r.name}".` : `No box in use says how many "${r.name}" fit. Add it under "What fits" on a box.`], currency: o.currency }
  if (!unitWeight) notes.push(`"${r.name}" has no packed weight, so postage can’t be worked out. Ranked by box cost.`)
  const rates = ((await payload.find({ collection: o.postage as CollectionSlug, where: { and: scoped }, ...list, req })).docs as Doc[]).map((d) => ({ upToGrams: num(d.upToGrams) ?? 0, cost: num(d.cost) ?? 0 }))

  const build = (p: { box: BoxOption; units: number }[]): Packing => {
    const boxesOut = p.map((x) => {
      const weight = unitWeight ? x.box.emptyWeight + x.units * unitWeight : null
      return { box: x.box, units: x.units, weight, postage: postageFor(weight, rates) }
    })
    const boxCost = boxesOut.reduce((t, x) => t + x.box.cost, 0)
    const postage = boxesOut.every((x) => x.postage !== null) ? boxesOut.reduce((t, x) => t + (x.postage ?? 0), 0) : null
    return {
      boxes: boxesOut,
      boxCost,
      postage,
      total: postage === null ? null : boxCost + postage,
      emptySlots: boxesOut.reduce((t, x) => t + (x.box.capacity - x.units), 0),
      basis: postage === null ? 'none' : 'postage-rates',
      summary: '',
    }
  }
  let ranked = packings(args.count, boxes).map(build).sort(byCost)
  if (unitWeight && rates.length === 0) notes.push('No postage rates are set, so postage isn’t included. Ranked by box cost.')

  const provider = args.provider === null ? undefined : (args.provider ?? o.shippingProvider ?? (payload.config.custom?.shipping?.provider as ShippingProvider | undefined))
  const providerName = typeof provider?.name === 'string' && provider.name ? provider.name : 'the rate provider'
  if (provider && unitWeight) {
    const candidates = ranked.slice(0, Math.max((args.limit ?? 3) * 2, 6))
    const packed: PackedBox[] = []
    const keyOf = new Map<PackedBox, { p: Packing; i: number }>()
    candidates.forEach((p, pi) =>
      p.boxes.forEach((x, i) => {
        if (!x.box.dimensions) return
        const pb: PackedBox = { id: `${pi}-${i}`, boxType: x.box.name, dimensions: x.box.dimensions, weight: { value: x.weight!, unit: 'g' }, contents: [{ recipe: String(r.key), units: x.units }] }
        packed.push(pb)
        keyOf.set(pb, { p, i })
      }),
    )
    const before = candidates.map((p) => ({ postage: p.postage, total: p.total, basis: p.basis, boxes: p.boxes.map((x) => x.postage) }))
    try {
      assertRateProvider(provider, 'the shipping provider')
      const result = await provider.quoteRates({ boxes: packed, to: args.to, from: args.from, reference: args.reference, scope: scope ?? undefined }, { payload, req })
      if (!result || !Array.isArray(result.rates)) throw new RateProviderShapeError('quoteRates gave no `rates` list.')
      const best = cheapestPerBox(result, packed)
      for (const p of candidates) {
        const ids = p.boxes.map((_, i) => `${candidates.indexOf(p)}-${i}`)
        if (ids.every((id) => best.has(id))) {
          p.boxes.forEach((x, i) => (x.postage = best.get(ids[i]!)!.amount))
          p.postage = p.boxes.reduce((t, x) => t + (x.postage ?? 0), 0)
          p.total = p.boxCost + p.postage
          p.basis = 'carrier'
        }
      }
      const priced = candidates.filter((p) => p.basis === 'carrier')
      if (!priced.length) notes.push(`${providerName} gave no rates; ranked by box cost and your postage rates.`)
      else if (priced.length < candidates.length)
        notes.push(`${providerName} had no rate for some packings, so they are listed after the ones it priced: their postage comes from your postage rates and isn’t comparable.`)
      for (const n of result.notes ?? []) notes.push(`${providerName}: ${n}`)
      // A carrier's price (which may include a return label) and your postage rates don't compare:
      // packings it priced come first, then all the others (unpriced or not sent), each group by cost.
      const rest = [...candidates.filter((p) => p.basis !== 'carrier'), ...ranked.slice(candidates.length)]
      ranked = [...priced.sort(byCost), ...rest.sort(byCost)]
    } catch (error) {
      // Packing never waits on a carrier: fall back to your postage rates, and say so on every suggestion.
      candidates.forEach((p, i) => {
        const b = before[i]!
        Object.assign(p, { postage: b.postage, total: b.total, basis: b.basis })
        p.boxes.forEach((x, j) => (x.postage = b.boxes[j]!))
      })
      fallback = { provider: providerName, error: error instanceof Error ? error.name : 'Error' }
      logOnce(payload, typeof provider === 'object' ? provider : notAnObject, providerName, fallback.error)
      notes.push(`Rates unavailable from ${providerName}; ranked by box cost and your postage rates.`)
    }
  }
  for (const p of ranked) {
    const groups = new Map<string, { name: string; units: number; n: number }>()
    for (const x of p.boxes) {
      const k = `${x.box.name}|${x.units}`
      const g = groups.get(k) ?? { name: x.box.name, units: x.units, n: 0 }
      g.n++
      groups.set(k, g)
    }
    const parts = [...groups.values()].map((g) => `${g.n} × ${g.name} (${g.units} each)`)
    const cost =
      p.total === null ? `boxes ${money(p.boxCost, o.currency)}` : `boxes ${money(p.boxCost, o.currency)} + postage ${money(p.postage!, o.currency)} = ${money(p.total, o.currency)}`
    const source = p.basis === 'carrier' ? ` (${providerName} rates)` : fallback && p.basis === 'postage-rates' ? ` (your postage rates: ${fallback.provider} unavailable)` : ''
    p.summary = `${parts.join(' + ')}: ${cost}${source}`
  }
  return { packings: ranked.slice(0, args.limit ?? 3), notes, currency: o.currency, ...(fallback ? { fallback } : {}) }
}
