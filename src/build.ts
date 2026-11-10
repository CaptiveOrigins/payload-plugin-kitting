import type { CollectionSlug, Payload, PayloadRequest, Where } from 'payload'

import { asInternal, findRecipe, idOf, KittingError, num, planRecipe, round, sameID, sendPendingAlerts, suppliesOf, transaction, useNeeds } from './stock.js'
import { assignBuilt, fillRequests } from './fulfil.js'
import { refreshStockStates } from './readystock.js'
import { compareMethods, dailyDemand, settingsFromRecipe, type Recommendation } from './stocklevel.js'
import type { BuildContext, BuildResult, BuiltUnit, ID, LotUse, RecipeRef, ResolvedSupplies } from './types.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Req = Partial<PayloadRequest>

const sys = { overrideAccess: true, depth: 0 } as const
const list = { ...sys, pagination: false, joins: false } as const

/** Trim, and refuse empty or repeated IDs, naming them. */
export function cleanExternalIds(raw: unknown[]): string[] {
  const ids = raw.map((s) => String(s ?? '').trim())
  if (!ids.length) throw new KittingError('noUnits', 'Scan or type at least one ID.')
  if (ids.some((s) => !s)) throw new KittingError('externalId', 'An ID is empty.')
  const seen = new Set<string>()
  const repeated = [...new Set(ids.filter((s) => (seen.has(s) ? true : (seen.add(s), false))))]
  if (repeated.length) throw new KittingError('duplicateId', `Scanned twice in this batch: ${repeated.join(', ')}.`)
  return ids
}

export const toBuiltUnit = (o: ResolvedSupplies, d: Doc): BuiltUnit => ({
  id: d.id,
  externalId: String(d.externalId),
  status: d.status,
  lotsUsed: ((d.lotsUsed ?? []) as Doc[]).map((l) => ({ item: idOf(l.item)!, lot: idOf(l.lot), quantity: num(l.quantity) ?? 0 })),
  scope: o.scopeField ? idOf(d[o.scopeField]) : null,
})

/**
 * Split what a batch used (per item, in first-to-expire order) between its units in order, so each
 * unit records exactly which lots went into it. The last unit takes any rounding remainder.
 */
export function splitLots(lots: Map<string, { lot: ID | null; quantity: number }[]>, items: Map<string, ID>, count: number): LotUse[][] {
  const perUnit: LotUse[][] = Array.from({ length: count }, () => [])
  for (const [key, parts] of lots) {
    const queue = parts.map((p) => ({ ...p }))
    const total = round(parts.reduce((t, p) => t + p.quantity, 0))
    const each = round(total / count)
    for (let i = 0; i < count; i++) {
      let left = i === count - 1 ? round(total - each * (count - 1)) : each
      while (left > 0 && queue.length) {
        const head = queue[0]!
        const take = round(Math.min(head.quantity, left))
        const prev = perUnit[i]!.find((u) => sameID(u.lot, head.lot) && sameID(u.item, items.get(key)))
        if (prev) prev.quantity = round(prev.quantity + take)
        else perUnit[i]!.push({ item: items.get(key)!, lot: head.lot, quantity: take })
        head.quantity = round(head.quantity - take)
        left = round(left - take)
        if (head.quantity <= 0) queue.shift()
      }
    }
  }
  return perUnit
}

/**
 * Build one unit per external ID from a recipe, in one transaction: the recipe's supplies come off
 * stock (first to expire first, with the shrinkage allowance), each unit records the lots that went into
 * it, and the host's `onBuild` runs for each. Refuses a batch bigger than the recipe's "most to build
 * at once", IDs already used, and (by default) not enough stock, naming what's wrong.
 */
export async function buildUnits(payload: Payload, recipe: RecipeRef, externalIds: unknown[], context: BuildContext = {}): Promise<BuildResult> {
  const o = suppliesOf(payload)
  const ids = cleanExternalIds(externalIds)
  const policy = context.negativeStock ?? o.negativeStock
  const joined = Boolean(context.req?.transactionID)
  const result = await transaction(payload, context.req, async (req) => {
    const r = await findRecipe(payload, o, req, recipe, context.scope)
    if (r.active === false) throw new KittingError('recipeInactive', `The recipe "${r.name}" is switched off.`)
    const max = num(r.maxPerBatch)
    if (max !== null && ids.length > max) throw new KittingError('batchLimit', `"${r.name}" is built at most ${max} at a time; this batch has ${ids.length}.`)
    const scope = o.scopeField ? idOf(r[o.scopeField]) : null
    const where: Where = { and: [{ externalId: { in: ids } }, ...(o.scopeField ? [{ [o.scopeField]: { equals: scope } }] : [])] }
    const taken = (await payload.find({ collection: o.units as CollectionSlug, where, ...list, req })).docs as Doc[]
    if (taken.length) throw new KittingError('idTaken', `Already built: ${taken.map((t) => t.externalId).join(', ')}.`)

    const needs = await planRecipe(payload, o, req, r, ids.length)
    if (!needs.size) throw new KittingError('recipeEmpty', `The recipe "${r.name}" has no supplies in it.`)
    const by = idOf(context.user ?? req.user ?? null)
    const used = await useNeeds(payload, o, req, [...needs.values()], {
      policy,
      what: `build ${ids.length} × "${r.name}"`,
      by,
      recipe: r.id,
      count: ids.length,
      reference: context.reference ?? `Build of ${ids.length} × ${r.name}`,
      reason: `Built ${ids.length} × "${r.name}": ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ` and ${ids.length - 5} more` : ''}`,
    })
    const itemIDs = new Map([...needs.values()].map((n) => [String(n.item.id), n.item.id as ID]))
    const perUnit = splitLots(used.lots, itemIDs, ids.length)
    const builtAt = new Date().toISOString()
    const units: BuiltUnit[] = []
    for (const [i, externalId] of ids.entries()) {
      const doc = (await asInternal(req, { by }, () =>
        payload.create({
          collection: o.units as CollectionSlug,
          data: {
            externalId,
            recipe: r.id,
            status: 'ready',
            builtAt,
            builtBy: by,
            reference: context.reference ?? null,
            lotsUsed: perUnit[i],
            ...(o.scopeField ? { [o.scopeField]: scope } : {}),
          } as never,
          ...sys,
          req,
        }),
      )) as Doc
      const unit = toBuiltUnit(o, doc)
      if (o.onBuild) await o.onBuild({ payload, req, unit, recipe: { id: r.id, name: String(r.name), key: String(r.key) } })
      units.push(unit)
    }
    // Built at packing for one order: it gets these units first (fulfil.ts, assignBuilt).
    const forOrder = context.assignTo !== undefined ? await assignBuilt(payload, req, r, context.assignTo, units) : null
    const rest = forOrder ? forOrder.leftover : units
    // Released units are ready again, so waiting requests can take them along with the leftovers.
    const freed = forOrder ? forOrder.given.flatMap((g) => (g.released ? [g.released] : [])) : []
    const queued = context.fillRequests === false ? [] : await fillRequests(payload, req, r, [...rest, ...freed])
    await refreshStockStates(payload, { req, scope })
    return {
      recipe: { id: r.id as ID, name: String(r.name) },
      units,
      movements: used.movements,
      shortages: used.shortages,
      filled: queued.map((q) => ({ externalId: q.unit.externalId, request: q.request, reference: q.reference })),
      assigned: (forOrder?.given ?? []).map((g) => ({ externalId: g.unit.externalId, reference: String(context.assignTo), released: g.released?.externalId ?? null, fromRequest: g.fromRequest })),
    }
  })
  if (!joined) await sendPendingAlerts(payload).catch((error) => payload.logger.error({ err: error, msg: 'kitting: low-stock alerts not sent' }))
  return result
}

export type VoidReason = 'dud' | 'damaged' | 'mistake' | 'other'

/**
 * Take a built unit out of use. A dud or damaged unit's supplies are gone, so stock doesn't change.
 * With `returnToStock` (a unit taken apart, or built by mistake), what went into it goes back to the
 * same lots as `adjusted` movements. Shipped units can't be voided.
 */
export async function voidUnit(
  payload: Payload,
  unitID: ID,
  args: { reason: VoidReason; note?: string; returnToStock?: boolean; req?: Req; user?: { id: ID } | null },
): Promise<BuiltUnit> {
  const o = suppliesOf(payload)
  const joined = Boolean(args.req?.transactionID)
  const result = await transaction(payload, args.req, async (req) => {
    const unit = (await payload.findByID({ collection: o.units as CollectionSlug, id: unitID, ...sys, joins: false, disableErrors: true, req })) as Doc | null
    if (!unit) throw new KittingError('unitNotFound', 'That unit doesn’t exist.')
    if (unit.status === 'void') throw new KittingError('unitVoid', `${unit.externalId} is already void.`)
    if (unit.status === 'shipped') throw new KittingError('unitShipped', `${unit.externalId} has shipped, so it can’t be voided.`)
    const by = idOf(args.user ?? req.user ?? null)
    if (args.returnToStock)
      for (const use of toBuiltUnit(o, unit).lotsUsed) {
        if (use.quantity <= 0) continue
        await asInternal(req, { by }, () =>
          payload.create({
            collection: o.movements as CollectionSlug,
            data: { item: use.item, kind: 'adjusted', quantity: use.quantity, lot: use.lot, reference: unit.externalId, reason: `Returned from ${unit.externalId} (${args.reason})` } as never,
            ...sys,
            req,
          }),
        )
      }
    const doc = (await asInternal(req, { by }, () =>
      payload.update({
        collection: o.units as CollectionSlug,
        id: unit.id,
        data: { status: 'void', voidReason: args.reason, voidNote: args.note ?? null, voidedAt: new Date().toISOString(), returnedToStock: Boolean(args.returnToStock) } as never,
        ...sys,
        req,
      }),
    )) as Doc
    await refreshStockStates(payload, { req, scope: o.scopeField ? idOf(unit[o.scopeField]) : null })
    return toBuiltUnit(o, doc)
  })
  if (!joined) await sendPendingAlerts(payload).catch(() => undefined)
  return result
}

/** Does `manage` allow this person to change this document? A query result must match it. */
export async function mayManageDoc(req: PayloadRequest, o: ResolvedSupplies, collection: string, id: ID): Promise<boolean> {
  const access = await o.manage({ req } as never)
  if (access === true) return true
  if (!access) return false
  const found = await req.payload.count({ collection: collection as CollectionSlug, where: { and: [{ id: { equals: id } }, access as Where] }, overrideAccess: true, req })
  return found.totalDocs > 0
}

/**
 * The ready-stock recommendation for a recipe, every method side by side (the chosen one first).
 * Demand is the units assigned per day over the recipe's history window, or the `sales` you pass
 * (for example from your shop's orders). Ready is the number of units built and not yet assigned.
 */
export async function recommendReadyStock(
  payload: Payload,
  recipeID: ID,
  options: { sales?: { at: string | Date; quantity?: number }[]; now?: Date; req?: Req } = {},
): Promise<{ ready: number; recommendations: Recommendation[] }> {
  const o = suppliesOf(payload)
  const req = options.req ?? {}
  const r = await findRecipe(payload, o, req, { id: recipeID })
  const settings = settingsFromRecipe(r)
  const now = options.now ?? new Date()
  const since = new Date(now.getTime() - settings.windowDays * 86_400_000).toISOString()
  const sales =
    options.sales ??
    ((await payload.find({ collection: o.units as CollectionSlug, where: { and: [{ recipe: { equals: r.id } }, { assignedAt: { greater_than_equal: since } }] }, ...list, req })).docs as Doc[]).map(
      (u) => ({ at: String(u.assignedAt) }),
    )
  const ready = (await payload.count({ collection: o.units as CollectionSlug, where: { and: [{ recipe: { equals: r.id } }, { status: { equals: 'ready' } }] }, overrideAccess: true, req })).totalDocs
  return { ready, recommendations: compareMethods(dailyDemand(sales, settings.windowDays, now), settings, ready) }
}
