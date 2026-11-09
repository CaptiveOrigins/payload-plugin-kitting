import type { CollectionSlug, Payload, PayloadRequest, Where } from 'payload'

import { toBuiltUnit } from './build.js'
import { asInternal, findRecipe, idOf, KittingError, num, suppliesOf, transaction } from './stock.js'
import type { AssignContext, AssignResult, BuiltUnit, ID, RecipeRef, ResolvedSupplies } from './types.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Req = Partial<PayloadRequest>

const sys = { overrideAccess: true, depth: 0 } as const
const list = { ...sys, pagination: false, joins: false } as const

const scopeWhere = (o: ResolvedSupplies, scope: ID | null): Where[] => (o.scopeField ? [{ [o.scopeField]: { equals: scope } }] : [])

async function readyUnits(payload: Payload, o: ResolvedSupplies, req: Req, recipe: Doc, limit: number) {
  const where: Where = { and: [{ recipe: { equals: recipe.id } }, { status: { equals: 'ready' } }, ...scopeWhere(o, o.scopeField ? idOf(recipe[o.scopeField]) : null)] }
  return (await payload.find({ collection: o.units as CollectionSlug, where, sort: ['builtAt', 'id'], limit, pagination: true, ...sys, joins: false, req })).docs as Doc[]
}

const setUnit = (payload: Payload, o: ResolvedSupplies, req: Req, id: ID, data: Doc) =>
  asInternal(req, {}, () => payload.update({ collection: o.units as CollectionSlug, id, data: data as never, ...sys, req })) as Promise<Doc>

/**
 * Give an order `count` units of a recipe, in one transaction: ready units first (oldest built first),
 * and a build request for the rest (unless `queue: false`), which later builds fill in order.
 * Safe to run twice for the same reference: what the reference already holds (assigned or shipped
 * units, and open requests) counts towards `count`, so only the difference is added.
 */
export async function assignUnits(payload: Payload, recipe: RecipeRef, count: number, context: AssignContext): Promise<AssignResult> {
  const o = suppliesOf(payload)
  if (!Number.isInteger(count) || count < 1) throw new KittingError('count', 'The count is a whole number, 1 or more.')
  const reference = String(context.reference ?? '').trim()
  if (!reference) throw new KittingError('reference', 'Say which order this is for.')
  return transaction(payload, context.req, async (req) => {
    const r = await findRecipe(payload, o, req, recipe, context.scope)
    const scope = o.scopeField ? idOf(r[o.scopeField]) : null
    const held = await heldBy(payload, o, req, r, scope, reference)
    const want = count - held.units.length - held.queued
    const now = new Date().toISOString()
    const added: Doc[] = want > 0 ? await readyUnits(payload, o, req, r, want) : []
    for (const unit of added) await setUnit(payload, o, req, unit.id, { status: 'assigned', assignedTo: reference, assignedAt: now })
    const short = Math.max(want - added.length, 0)
    let request: AssignResult['request'] = held.request ? { id: held.request.id, count: num(held.request.count) ?? 0 } : null
    if (short > 0 && context.queue !== false) {
      if (held.request) {
        const total = (num(held.request.count) ?? 0) + short
        await asInternal(req, {}, () => payload.update({ collection: o.requests as CollectionSlug, id: held.request!.id, data: { count: total } as never, ...sys, req }))
        request = { id: held.request.id, count: total }
      } else {
        const doc = (await asInternal(req, {}, () =>
          payload.create({
            collection: o.requests as CollectionSlug,
            data: { reference, recipe: r.id, count: short, filled: 0, status: 'open', units: [], ...(o.scopeField ? { [o.scopeField]: scope } : {}) } as never,
            ...sys,
            req,
          }),
        )) as Doc
        request = { id: doc.id, count: short }
      }
    }
    const assigned = (await heldBy(payload, o, req, r, scope, reference)).units.map((u) => toBuiltUnit(o, u))
    return { recipe: { id: r.id as ID, name: String(r.name) }, assigned, short, request }
  })
}

/** What a reference already holds for a recipe: its assigned or shipped units, and its open request. */
async function heldBy(payload: Payload, o: ResolvedSupplies, req: Req, r: Doc, scope: ID | null, reference: string) {
  const base: Where[] = [{ recipe: { equals: r.id } }, ...scopeWhere(o, scope)]
  const units = (await payload.find({ collection: o.units as CollectionSlug, where: { and: [...base, { assignedTo: { equals: reference } }, { status: { in: ['assigned', 'shipped'] } }] }, sort: ['assignedAt', 'builtAt', 'id'], ...list, req }))
    .docs as Doc[]
  const request = ((await payload.find({ collection: o.requests as CollectionSlug, where: { and: [...base, { reference: { equals: reference } }, { status: { equals: 'open' } }] }, limit: 1, ...list, req })).docs as Doc[])[0]
  const queued = request ? (num(request.count) ?? 0) - (num(request.filled) ?? 0) : 0
  return { units, request: request ?? null, queued }
}

/** A unit by its id or by its external ID (within a scope). */
async function findUnit(payload: Payload, o: ResolvedSupplies, req: Req, ref: { id: ID } | { externalId: string }, scope?: ID | null): Promise<Doc> {
  if ('id' in ref) {
    const unit = (await payload.findByID({ collection: o.units as CollectionSlug, id: ref.id, ...sys, joins: false, disableErrors: true, req })) as Doc | null
    if (!unit) throw new KittingError('unitNotFound', 'That unit doesn’t exist.')
    return unit
  }
  if (o.scopeField && (scope === undefined || scope === null)) throw new KittingError('scope', `Say which ${o.scopeField} ${ref.externalId} belongs to.`)
  const where: Where = { and: [{ externalId: { equals: String(ref.externalId).trim() } }, ...scopeWhere(o, scope ?? null)] }
  const unit = ((await payload.find({ collection: o.units as CollectionSlug, where, limit: 1, ...list, req })).docs as Doc[])[0]
  if (!unit) throw new KittingError('unitNotFound', `${ref.externalId} hasn’t been built.`)
  return unit
}

/**
 * At packing, the scanned unit decides: give `take` to the order `reference`. If the scanned unit is
 * already the order's, nothing changes. Otherwise it must be ready. If the order is still waiting for
 * units of that recipe (an open build request), it fills one of those places. If not, it takes the place
 * of one of the order's assigned (not shipped) units, which goes back to ready. Refuses if the order
 * holds nothing of that recipe.
 */
export async function swapUnit(
  payload: Payload,
  args: { reference: string; take: { id: ID } | { externalId: string }; scope?: ID; req?: Req },
): Promise<{ taken: BuiltUnit; released: BuiltUnit | null; fromRequest: ID | null }> {
  const o = suppliesOf(payload)
  const reference = String(args.reference ?? '').trim()
  if (!reference) throw new KittingError('reference', 'Say which order this is for.')
  return transaction(payload, args.req, async (req) => {
    const unit = await findUnit(payload, o, req, args.take, args.scope)
    if (unit.status === 'assigned' && unit.assignedTo === reference) return { taken: toBuiltUnit(o, unit), released: null, fromRequest: null }
    if (unit.status !== 'ready') throw new KittingError('unitStatus', `${unit.externalId} is ${unit.status === 'assigned' ? `kept for ${unit.assignedTo}` : unit.status}, so it can’t go to ${reference}.`)
    const r = await findRecipe(payload, o, req, { id: idOf(unit.recipe)! })
    const scope = o.scopeField ? idOf(r[o.scopeField]) : null
    const held = await heldBy(payload, o, req, r, scope, reference)
    const now = new Date().toISOString()
    if (held.request && held.queued > 0) {
      const taken = toBuiltUnit(o, await setUnit(payload, o, req, unit.id, { status: 'assigned', assignedTo: reference, assignedAt: now }))
      const filled = (num(held.request.filled) ?? 0) + 1
      await asInternal(req, {}, () =>
        payload.update({
          collection: o.requests as CollectionSlug,
          id: held.request!.id,
          data: { filled, status: filled >= (num(held.request!.count) ?? 0) ? 'filled' : 'open', units: [...((held.request!.units ?? []) as unknown[]).map(idOf), unit.id] } as never,
          ...sys,
          req,
        }),
      )
      return { taken, released: null, fromRequest: held.request.id }
    }
    const swapOut = [...held.units].reverse().find((u) => u.status === 'assigned')
    if (swapOut) {
      const released = toBuiltUnit(o, await setUnit(payload, o, req, swapOut.id, { status: 'ready', assignedTo: null, assignedAt: null }))
      const taken = toBuiltUnit(o, await setUnit(payload, o, req, unit.id, { status: 'assigned', assignedTo: reference, assignedAt: now }))
      return { taken, released, fromRequest: null }
    }
    throw new KittingError('nothingReserved', `${reference} has no ${r.name} kept for it.`)
  })
}

/**
 * Give back what an order holds (unpacking, or a cancelled order): its assigned units go back to ready,
 * oldest built first for the next order. With `unit`, only that one. Without, every assigned unit of
 * the reference (optionally of one recipe) and its open build requests, which are cancelled.
 * Shipped units are never released.
 */
export async function release(
  payload: Payload,
  args: { reference: string; unit?: { id: ID } | { externalId: string }; recipe?: RecipeRef; scope?: ID; req?: Req },
): Promise<{ released: BuiltUnit[]; cancelledRequests: ID[] }> {
  const o = suppliesOf(payload)
  const reference = String(args.reference ?? '').trim()
  if (!reference) throw new KittingError('reference', 'Say which order this is for.')
  return transaction(payload, args.req, async (req) => {
    if (args.unit) {
      const unit = await findUnit(payload, o, req, args.unit, args.scope)
      if (unit.assignedTo !== reference || unit.status !== 'assigned') throw new KittingError('unitStatus', `${unit.externalId} isn’t kept for ${reference}.`)
      return { released: [toBuiltUnit(o, await setUnit(payload, o, req, unit.id, { status: 'ready', assignedTo: null, assignedAt: null }))], cancelledRequests: [] }
    }
    if (o.scopeField && (args.scope === undefined || args.scope === null) && !args.recipe) throw new KittingError('scope', `Say which ${o.scopeField} ${reference} belongs to.`)
    const r = args.recipe ? await findRecipe(payload, o, req, args.recipe, args.scope) : null
    const scope = r && o.scopeField ? idOf(r[o.scopeField]) : (args.scope ?? null)
    const base: Where[] = [...(r ? [{ recipe: { equals: r.id } }] : []), ...scopeWhere(o, scope)]
    const units = (await payload.find({ collection: o.units as CollectionSlug, where: { and: [...base, { assignedTo: { equals: reference } }, { status: { equals: 'assigned' } }] }, ...list, req })).docs as Doc[]
    const released: BuiltUnit[] = []
    for (const u of units) released.push(toBuiltUnit(o, await setUnit(payload, o, req, u.id, { status: 'ready', assignedTo: null, assignedAt: null })))
    const requests = (await payload.find({ collection: o.requests as CollectionSlug, where: { and: [...base, { reference: { equals: reference } }, { status: { equals: 'open' } }] }, ...list, req })).docs as Doc[]
    for (const q of requests) await asInternal(req, {}, () => payload.update({ collection: o.requests as CollectionSlug, id: q.id, data: { status: 'cancelled' } as never, ...sys, req }))
    return { released, cancelledRequests: requests.map((q) => q.id as ID) }
  })
}

/**
 * Give freshly built units to open build requests for the same recipe, oldest request first. Runs
 * inside the build's transaction. Returns the units it assigned, with the request each went to.
 */
export async function fillRequests(payload: Payload, req: Req, recipe: Doc, units: BuiltUnit[]): Promise<{ unit: BuiltUnit; request: ID; reference: string }[]> {
  const o = suppliesOf(payload)
  const where: Where = { and: [{ recipe: { equals: recipe.id } }, { status: { equals: 'open' } }, ...scopeWhere(o, o.scopeField ? idOf(recipe[o.scopeField]) : null)] }
  const open = (await payload.find({ collection: o.requests as CollectionSlug, where, sort: 'createdAt', ...list, req })).docs as Doc[]
  const out: { unit: BuiltUnit; request: ID; reference: string }[] = []
  const queue = [...units]
  const now = new Date().toISOString()
  for (const request of open) {
    const filled = num(request.filled) ?? 0
    const wanted = (num(request.count) ?? 0) - filled
    const given: ID[] = []
    while (given.length < wanted && queue.length) {
      const unit = queue.shift()!
      const doc = await setUnit(payload, o, req, unit.id, { status: 'assigned', assignedTo: request.reference, assignedAt: now })
      Object.assign(unit, toBuiltUnit(o, doc))
      given.push(unit.id)
      out.push({ unit, request: request.id, reference: String(request.reference) })
    }
    if (!given.length) break
    await asInternal(req, {}, () =>
      payload.update({
        collection: o.requests as CollectionSlug,
        id: request.id,
        data: { filled: filled + given.length, status: filled + given.length >= (num(request.count) ?? 0) ? 'filled' : 'open', units: [...((request.units ?? []) as unknown[]).map(idOf), ...given] } as never,
        ...sys,
        req,
      }),
    )
    if (!queue.length) break
  }
  return out
}

async function changeStatus(payload: Payload, ids: ID[], from: string[], to: Doc, what: string, req?: Req): Promise<BuiltUnit[]> {
  const o = suppliesOf(payload)
  return transaction(payload, req, async (r) => {
    const out: BuiltUnit[] = []
    for (const id of ids) {
      const unit = (await payload.findByID({ collection: o.units as CollectionSlug, id, ...sys, joins: false, disableErrors: true, req: r })) as Doc | null
      if (!unit) throw new KittingError('unitNotFound', 'That unit doesn’t exist.')
      if (!from.includes(unit.status)) throw new KittingError('unitStatus', `${unit.externalId} is ${unit.status}, so it can’t be ${what}.`)
      out.push(toBuiltUnit(o, await setUnit(payload, o, r, unit.id, to)))
    }
    return out
  })
}

/** Mark assigned units as shipped. */
export const shipUnits = (payload: Payload, ids: ID[], options: { req?: Req } = {}) => changeStatus(payload, ids, ['assigned'], { status: 'shipped', shippedAt: new Date().toISOString() }, 'shipped', options.req)
