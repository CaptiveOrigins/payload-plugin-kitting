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
): Promise<{ packings: Packing[]; notes: string[]; currency: string }> {
  const o = suppliesOf(payload)
  const req = args.req ?? {}
  if (!Number.isInteger(args.count) || args.count < 1) throw new KittingError('count', 'The count is a whole number, 1 or more.')
  const r = await findRecipe(payload, o, req, args.recipe, args.scope)
  const scope = o.scopeField ? idOf(r[o.scopeField]) : null
  const scoped: Where[] = o.scopeField ? [{ [o.scopeField]: { equals: scope } }] : []
  const unitWeight = num(r.unitWeight)
  const notes: string[] = []
  const boxDocs = (await payload.find({ collection: o.boxes as CollectionSlug, where: { and: [{ active: { not_equals: false } }, ...scoped] }, ...list, req })).docs as Doc[]
  const boxes: BoxOption[] = []
  for (const b of boxDocs) {
    const fit = ((b.fits ?? []) as Doc[]).find((f) => sameID(f.recipe, r.id))
    if (!fit) continue
    let capacity = num(fit.units) ?? 0
    const empty = num(b.emptyWeight) ?? 0
    const max = num(b.maxWeight)
    if (max !== null && unitWeight) capacity = Math.min(capacity, Math.floor((max - empty) / unitWeight))
    if (capacity < 1) continue
    const [l, w, h] = [num(b.outsideLength), num(b.outsideWidth), num(b.outsideHeight)]
    boxes.push({ id: b.id, name: String(b.name), capacity, cost: num(b.cost) ?? 0, emptyWeight: empty, dimensions: l && w && h ? { length: l, width: w, height: h, unit: (b.outsideUnit ?? 'cm') as LengthUnit } : null })
  }
  if (!boxes.length) return { packings: [], notes: [`No box in use says how many "${r.name}" fit. Add it under "What fits" on a box.`], currency: o.currency }
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
    try {
      const result = await provider.quoteRates({ boxes: packed, to: args.to, from: args.from, reference: args.reference, scope: scope ?? undefined }, { payload, req })
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
      if (candidates.some((p) => p.basis !== 'carrier')) notes.push(`${provider.name} had no rate for some boxes (are their sizes set?); those use your postage rates.`)
      for (const n of result.notes ?? []) notes.push(`${provider.name}: ${n}`)
      ranked = [...candidates, ...ranked.slice(candidates.length)].sort(byCost)
    } catch (error) {
      payload.logger.warn({ err: error, msg: 'kitting: carrier rates unavailable' })
      notes.push(`Rates unavailable from ${provider.name}; ranked by box cost and your postage rates.`)
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
    p.summary = `${parts.join(' + ')}: ${cost}${p.basis === 'carrier' ? ` (${provider?.name} rates)` : ''}`
  }
  return { packings: ranked.slice(0, args.limit ?? 3), notes, currency: o.currency }
}
