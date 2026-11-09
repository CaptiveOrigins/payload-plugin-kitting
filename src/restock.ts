import type { CollectionSlug, Payload, Where } from 'payload'

import { readyStatus } from './readystock.js'
import { idOf, planRecipe, round, sameID, stockReport, suppliesOf } from './stock.js'
import type { ID } from './types.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** One supply to buy (crossing `kitting-restock`, docs in payload-plugin-restock). */
export type RestockNeed = {
  item: ID
  name: string
  unit: string
  onHand: number
  usable: number
  lowStockLevel: number | null
  reorderQuantity: number | null
  /** In the supply's unit: the larger of its reorder suggestion when below level, and what's needed to build every recipe up to its number to keep, minus usable stock. */
  suggested: number
  why: string
  supplier: ID | null
}

/**
 * What a site should buy, per supply, for a purchasing plugin such as Restock. Read-only: it changes
 * nothing. Only supplies with something to buy, and not retired.
 */
export async function restockNeeds(payload: Payload, options: { scope?: ID; req?: Partial<import('payload').PayloadRequest> } = {}): Promise<RestockNeed[]> {
  const o = suppliesOf(payload)
  const req = options.req ?? {}
  const scope = options.scope ?? null
  if (o.scopeField && scope === null) throw new Error(`Kitting: say which ${o.scopeField} to work out needs for.`)
  const { rows } = await stockReport(payload, { req })
  const mine = rows.filter((r) => !r.retired && (!o.scopeField || sameID(r.scope, scope)))
  // What building every recipe up to its number to keep would take, per supply.
  const forReady = new Map<string, { quantity: number; why: string[] }>()
  const where: Where = { and: [{ 'readyStock.baseline': { exists: true } }, { active: { not_equals: false } }, ...(o.scopeField ? [{ [o.scopeField]: { equals: scope } }] : [])] }
  const recipes = (await payload.find({ collection: o.recipes as CollectionSlug, where, overrideAccess: true, depth: 0, pagination: false, req })).docs as Doc[]
  for (const r of recipes) {
    const status = await readyStatus(payload, r, req)
    if (status.toBuild <= 0) continue
    for (const need of (await planRecipe(payload, o, req, r, status.toBuild)).values()) {
      const key = String(need.item.id)
      const prev = forReady.get(key) ?? { quantity: 0, why: [] }
      prev.quantity = round(prev.quantity + need.base + need.allowance)
      prev.why.push(`${status.toBuild} ${r.name} to build`)
      forReady.set(key, prev)
    }
  }
  const out: RestockNeed[] = []
  for (const row of mine) {
    const below = row.below ? row.suggestedReorder : 0
    const ready = forReady.get(String(row.id))
    const short = ready ? Math.max(round(ready.quantity - row.usable), 0) : 0
    const suggested = Math.max(below, short)
    if (suggested <= 0) continue
    const why = [
      ...(row.below ? [`below its level (${row.onHand} of ${row.lowStockLevel} ${row.unit})`] : []),
      ...(short > 0 && ready ? [`${ready.why.join(', ')} need ${ready.quantity} ${row.unit}, ${row.usable} usable`] : []),
    ].join('; ')
    out.push({
      item: row.id,
      name: row.name,
      unit: row.unit,
      onHand: row.onHand,
      usable: row.usable,
      lowStockLevel: row.lowStockLevel,
      reorderQuantity: row.reorderQuantity,
      suggested,
      why,
      supplier: idOf(row.supplier?.id ?? null),
    })
  }
  return out
}
