import { APIError, type CollectionSlug, type Payload, type PayloadRequest, type Where } from 'payload'

import { refreshStockStates, sendStockAlerts } from './readystock.js'
import { conversionFactor, normalizeUnit, unitsFor } from './units.js'
import type { AlertItem, AlertStatus, ApplyRecipeContext, ApplyRecipeResult, ID, NegativeStock, RecipeRef, ResolvedSupplies, Shortage } from './types.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Req = Partial<PayloadRequest>

/** Request-context key for writes the plugin makes itself. Hosts never set it. */
export const INTERNAL = 'kittingInternal'
/**
 * Request-context key that lets a trusted script delete movements (for example when a whole site
 * or a sandbox is removed). Nothing else can delete or edit a movement.
 */
export const ALLOW_DELETE = 'kittingAllowDelete'

export type Internal = { by?: ID | null; negativeStock?: NegativeStock; opening?: boolean; recipe?: ID; count?: number; allowance?: number }

export const suppliesOf = (payload: Payload): ResolvedSupplies => {
  const o = payload.config.custom?.kitting as ResolvedSupplies | undefined
  if (!o) throw new Error('payload-plugin-kitting is not installed in this Payload config.')
  return o
}

export const idOf = (v: unknown): ID | null => (v && typeof v === 'object' ? ((v as { id: ID }).id ?? null) : v === undefined || v === null || v === '' ? null : (v as ID))
export const sameID = (a: unknown, b: unknown) => String(idOf(a) ?? '') === String(idOf(b) ?? '')
/** Quantities may be fractional (ml, metres); keep sums free of floating-point dust. */
export const round = (n: number) => Math.round(n * 1e6) / 1e6
export const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** An item is below level when a level is set and on hand is under it. */
export const isBelowLevel = (onHand: number, level: unknown) => num(level) !== null && onHand < (level as number)

/** The reorder quantity, or enough to get back to the level if that's more. */
export const suggestedReorder = (item: { onHand?: unknown; lowStockLevel?: unknown; reorderQuantity?: unknown }) => {
  const onHand = num(item.onHand) ?? 0
  const level = num(item.lowStockLevel)
  const toLevel = level === null ? 0 : Math.max(round(level - onHand), 0)
  return Math.max(num(item.reorderQuantity) ?? 0, toLevel)
}

/**
 * Alert fields after on hand or the level changes. Crossing below the level marks one alert as
 * pending; staying below changes nothing (no repeats); getting back to the level clears it.
 */
export function alertFields(prev: Doc, onHand: number, level: unknown, now = new Date()): Doc {
  const below = isBelowLevel(onHand, level)
  if (below && !prev.belowLevelSince) return { belowLevelSince: now.toISOString(), alertStatus: 'pending', alertAt: null, alertNote: null }
  if (!below && prev.belowLevelSince) return { belowLevelSince: null, alertStatus: null, alertAt: null, alertNote: null }
  return {}
}

export class KittingError extends APIError<{ code: string; shortages?: Shortage[] }> {
  code: string
  shortages?: Shortage[]
  constructor(code: string, message: string, shortages?: Shortage[]) {
    super(message, 400, { code, shortages }, true)
    this.code = code
    this.shortages = shortages
  }
}

/** Run in the caller's transaction when there is one, otherwise in our own. */
export async function transaction<T>(payload: Payload, req: Req | undefined, fn: (req: Req) => Promise<T>): Promise<T> {
  if (req?.transactionID) return fn(req)
  const transactionID = (await payload.db.beginTransaction?.()) ?? undefined
  const own: Req = { ...req, transactionID, context: { ...req?.context } }
  try {
    const result = await fn(own)
    if (transactionID) await payload.db.commitTransaction(transactionID)
    return result
  } catch (error) {
    if (transactionID) await payload.db.rollbackTransaction(transactionID)
    throw error
  }
}

/** Mark a write as the plugin's own for the length of `fn`, then put the context back. */
export async function asInternal<T>(req: Req, value: Internal, fn: () => Promise<T>): Promise<T> {
  req.context ??= {}
  const before = req.context[INTERNAL]
  req.context[INTERNAL] = value
  try {
    return await fn()
  } finally {
    req.context[INTERNAL] = before
  }
}

// Reads inside a transaction run one query at a time (Mongo refuses parallel work on one session).
const sys = { overrideAccess: true, depth: 0 } as const
const list = { ...sys, pagination: false, joins: false } as const

const nameOf = (item: Doc) => String(item.name ?? 'Unnamed supply')
const unitOf = (item: Doc) => String(item.unit || 'each')
const plural = (n: number, unit: string) => `${n} ${unit}`

export async function findRecipe(payload: Payload, o: ResolvedSupplies, req: Req, ref: RecipeRef | Doc, scope?: ID): Promise<Doc> {
  if ('key' in ref && typeof ref.key === 'string' && !('id' in ref)) {
    if (o.scopeField && (scope === undefined || scope === null)) throw new KittingError('scope', `Say which ${o.scopeField} the recipe "${ref.key}" belongs to.`)
    const where: Where = o.scopeField ? { and: [{ key: { equals: ref.key } }, { [o.scopeField]: { equals: scope } }] } : { key: { equals: ref.key } }
    const found = (await payload.find({ collection: o.recipes as CollectionSlug, where, limit: 1, ...list, req })).docs[0] as Doc | undefined
    if (!found) throw new KittingError('recipeNotFound', `No recipe with the key "${ref.key}".`)
    return found
  }
  const id = idOf(ref)
  const found = id === null ? null : ((await payload.findByID({ collection: o.recipes as CollectionSlug, id, ...sys, joins: false, disableErrors: true, req })) as Doc | null)
  if (!found) throw new KittingError('recipeNotFound', 'That recipe doesn’t exist.')
  if (o.scopeField && scope !== undefined && scope !== null && !sameID(found[o.scopeField], scope)) throw new KittingError('scope', 'That recipe belongs somewhere else.')
  return found
}

export const getItem = async (payload: Payload, o: ResolvedSupplies, req: Req, id: unknown) =>
  idOf(id) === null ? null : ((await payload.findByID({ collection: o.items as CollectionSlug, id: idOf(id)!, ...sys, joins: false, disableErrors: true, req })) as Doc | null)

// ---------------------------------------------------------------------------------------------
// Shrinkage allowance

const percentOf = (v: unknown) => (num(v) === null ? null : Math.min(Math.max(v as number, 0), 100))

/**
 * The shrinkage allowance % that applies: the recipe line's own, else the recipe's, else the item's,
 * else the plugin's default. Zero when allowances are switched off.
 */
export function shrinkagePercent(o: Pick<ResolvedSupplies, 'shrinkage'>, item: Doc, recipe?: Doc | null, line?: Doc | null): number {
  if (!o.shrinkage.enabled) return 0
  return percentOf(line?.shrinkagePercent) ?? percentOf(recipe?.shrinkagePercent) ?? percentOf(item.shrinkagePercent) ?? o.shrinkage.defaultPercent
}

/** "18 g of Beans + 5% shrinkage allowance": a recipe line in plain words. */
export function describeUse(args: { quantity: number; unit: string; name: string; percent: number; per?: string }) {
  const counted = args.unit === 'each' || args.unit === ''
  const base = `${fmt(args.quantity)}${counted ? ' ×' : ` ${args.unit} of`} ${args.name}${args.per ? ` per ${args.per}` : ''}`
  return args.percent > 0 ? `${base} + ${fmt(args.percent)}% shrinkage allowance` : base
}

const fmt = (n: number) => String(round(n))

// ---------------------------------------------------------------------------------------------
// Lots and use-by dates

const DAY = 24 * 60 * 60 * 1000

/** A lot is expired once its use-by day has passed (the whole day is still usable). */
export const isExpired = (expiresOn: unknown, now = new Date()) => {
  if (!expiresOn) return false
  const t = new Date(String(expiresOn)).getTime()
  return Number.isFinite(t) && now.getTime() >= startOfDayUTC(t) + DAY
}
export const expiresWithin = (expiresOn: unknown, days: number, now = new Date()) => {
  if (!expiresOn || isExpired(expiresOn, now)) return false
  const t = new Date(String(expiresOn)).getTime()
  return Number.isFinite(t) && startOfDayUTC(t) + DAY - now.getTime() <= days * DAY
}
const startOfDayUTC = (t: number) => {
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}
const dateOnly = (d: Date) => new Date(startOfDayUTC(d.getTime())).toISOString()

/** First to expire first; lots without a date after dated ones; then oldest received. */
export const byExpiry = (a: Doc, b: Doc) => {
  const ea = a.expiresOn ? new Date(a.expiresOn).getTime() : Infinity
  const eb = b.expiresOn ? new Date(b.expiresOn).getTime() : Infinity
  if (ea !== eb) return ea - eb
  return String(a.receivedOn ?? a.createdAt ?? '').localeCompare(String(b.receivedOn ?? b.createdAt ?? ''))
}

export async function lotsOf(payload: Payload, o: ResolvedSupplies, req: Req, itemID: ID): Promise<Doc[]> {
  const docs = (await payload.find({ collection: o.lots as CollectionSlug, where: { item: { equals: itemID } }, ...list, req })).docs as Doc[]
  return docs.sort(byExpiry)
}

const lotName = (lot: Doc) => (lot.lotNumber ? `lot ${lot.lotNumber}` : `the lot received ${String(lot.receivedOn ?? lot.createdAt ?? '').slice(0, 10)}`)

async function createLot(payload: Payload, o: ResolvedSupplies, req: Req, item: Doc, lotNumber: unknown, expiresOn: unknown): Promise<Doc> {
  const now = new Date()
  const shelf = num(item.shelfLifeDays)
  const expiry = expiresOn ? String(expiresOn) : shelf !== null ? dateOnly(new Date(now.getTime() + shelf * DAY)) : null
  return (await asInternal(req, {}, () =>
    payload.create({
      collection: o.lots as CollectionSlug,
      data: {
        item: item.id,
        lotNumber: lotNumber ? String(lotNumber).trim() : null,
        expiresOn: expiry,
        receivedOn: now.toISOString(),
        onHand: 0,
        ...(o.scopeField ? { [o.scopeField]: idOf(item[o.scopeField]) } : {}),
      } as never,
      ...sys,
      req,
    }),
  )) as Doc
}

/** Usable stock of an item: unexpired lots, plus any stock from before lots were tracked. */
export function usable(item: Doc, lots: Doc[], now = new Date()) {
  const fresh = lots.filter((l) => !isExpired(l.expiresOn, now) && (num(l.onHand) ?? 0) > 0)
  const inLots = round(lots.reduce((t, l) => t + Math.max(num(l.onHand) ?? 0, 0), 0))
  const unlotted = Math.max(round((num(item.onHand) ?? 0) - inLots), 0)
  return { fresh, unlotted, total: round(fresh.reduce((t, l) => t + (num(l.onHand) as number), 0) + unlotted) }
}

/**
 * Take `quantity` from an item, first to expire first, skipping expired lots. Stock from before lots
 * were tracked goes last. Anything left over (a shortage) comes back with no lot.
 */
export function allocate(item: Doc, lots: Doc[], quantity: number, now = new Date()): { lot: ID | null; quantity: number }[] {
  if (!item.trackLots) return [{ lot: null, quantity }]
  const { fresh } = usable(item, lots, now)
  const out: { lot: ID | null; quantity: number }[] = []
  let left = quantity
  for (const lot of fresh) {
    if (left <= 0) break
    const take = Math.min(num(lot.onHand) as number, left)
    out.push({ lot: lot.id, quantity: round(take) })
    left = round(left - take)
  }
  // What's left comes from stock from before lots were tracked, or is a shortage: either way, no lot.
  if (left > 0) out.push({ lot: null, quantity: left })
  return out.filter((p) => p.quantity > 0)
}

// ---------------------------------------------------------------------------------------------
// Using a recipe

export type Need = { item: Doc; base: number; allowance: number; percent: number }

/**
 * What `count` of a recipe takes from each item, in the item's unit, with the shrinkage allowance.
 * Lines that use another recipe are expanded into that recipe's supplies (scaled by what it makes),
 * however deep, and refused if a recipe would use itself.
 */
export async function planRecipe(payload: Payload, o: ResolvedSupplies, req: Req, top: Doc, count: number): Promise<Map<string, Need>> {
  const needs = new Map<string, Need>()
  const expand = async (r: Doc, times: number, path: string[]): Promise<void> => {
    if (path.length > 8) throw new KittingError('recipeDepth', 'Recipes can be nested 8 deep at most.')
    for (const line of (r.lines ?? []) as Doc[]) {
      const quantity = num(line.quantity)
      if (quantity === null || quantity <= 0) continue
      if (line.type === 'recipe') {
        const subID = idOf(line.recipe)
        if (subID === null) continue
        if (path.includes(String(subID))) throw new KittingError('recipeCycle', `"${r.name}" uses a recipe that uses it back.`)
        const sub = await findRecipe(payload, o, req, { id: subID })
        if (o.scopeField && !sameID(sub[o.scopeField], r[o.scopeField])) throw new KittingError('scope', `"${sub.name}" belongs somewhere else than "${r.name}".`)
        const makes = num(sub.makes) ?? 1
        const factor = conversionFactor(line.unit || sub.makesUnit || 'each', sub.makesUnit || 'each')
        if (factor === null) throw new KittingError('unit', `"${r.name}" uses "${sub.name}" in ${line.unit}, but it makes ${sub.makesUnit}.`)
        await expand(sub, (times * quantity * factor) / makes, [...path, String(subID)])
        continue
      }
      if (idOf(line.item) === null) continue
      const item = await getItem(payload, o, req, line.item)
      if (!item) throw new KittingError('itemNotFound', `A supply in "${r.name}" no longer exists. Edit the recipe.`)
      if (o.scopeField && !sameID(item[o.scopeField], r[o.scopeField])) throw new KittingError('scope', `"${nameOf(item)}" belongs somewhere else than the recipe "${r.name}".`)
      const factor = conversionFactor(line.unit || item.unit, item.unit, item.packs ?? [])
      if (factor === null) throw new KittingError('unit', `"${r.name}" uses ${nameOf(item)} in ${line.unit}, which can’t be converted to ${unitOf(item)}.`)
      const base = round(quantity * factor * times)
      const percent = shrinkagePercent(o, item, r, line)
      const allowance = round((base * percent) / 100)
      const prev = needs.get(String(item.id))
      needs.set(String(item.id), { item: prev?.item ?? item, base: round((prev?.base ?? 0) + base), allowance: round((prev?.allowance ?? 0) + allowance), percent })
    }
  }
  await expand(top, count, [String(top.id)])
  return needs
}

/**
 * Use a recipe's supplies to make `count` of something, in one transaction: one `used` movement per
 * item and lot (first to expire first), or nothing at all. Each item's shrinkage allowance is added and
 * recorded on the movement. Refuses when any item hasn't enough usable stock (unless `negativeStock`
 * is `warn`), naming every item that's short.
 */
export async function applyRecipe(payload: Payload, recipe: RecipeRef, count: number, context: ApplyRecipeContext = {}): Promise<ApplyRecipeResult> {
  const o = suppliesOf(payload)
  if (!Number.isInteger(count) || count < 1) throw new KittingError('count', 'The count is a whole number, 1 or more.')
  const policy = context.negativeStock ?? o.negativeStock
  const joined = Boolean(context.req?.transactionID)
  const result = await transaction(payload, context.req, async (req) => {
    const r = await findRecipe(payload, o, req, recipe, context.scope)
    if (r.active === false) throw new KittingError('recipeInactive', `The recipe "${r.name}" is switched off.`)
    const needs = await planRecipe(payload, o, req, r, count)
    if (!needs.size) throw new KittingError('recipeEmpty', `The recipe "${r.name}" has no supplies in it.`)
    const used = await useNeeds(payload, o, req, [...needs.values()], {
      policy,
      what: `make ${count} with "${r.name}"`,
      by: idOf(context.user ?? req.user ?? null),
      recipe: r.id,
      count,
      reference: context.reference ?? null,
      reason: context.reason ?? `Used by recipe "${r.name}" × ${count}`,
    })
    await refreshStockStates(payload, { req, scope: o.scopeField ? idOf(r[o.scopeField]) : null })
    return { recipe: { id: r.id as ID, name: String(r.name) }, count, ...used }
  })
  // Our own transaction is committed: send the alert now. A caller's transaction isn't, so the
  // alert stays pending until they call sendPendingAlerts, or the next save sends it.
  if (!joined) await sendPendingAlerts(payload).catch((error) => payload.logger.error({ err: error, msg: 'kitting: low-stock alerts not sent' }))
  return result
}

/** Check every need against usable stock, then write the movements (one per item and lot). */
export async function useNeeds(
  payload: Payload,
  o: ResolvedSupplies,
  req: Req,
  needs: Need[],
  args: { policy: NegativeStock; what: string; by: ID | null; recipe?: ID; count?: number; reference: string | null; reason: string },
): Promise<{ movements: ApplyRecipeResult['movements']; shortages: Shortage[]; lots: Map<string, { lot: ID | null; quantity: number }[]> }> {
  const plans: { need: Need; parts: { lot: ID | null; quantity: number }[] }[] = []
  const shortages: Shortage[] = []
  for (const need of needs) {
    const lots = need.item.trackLots ? await lotsOf(payload, o, req, need.item.id) : []
    const total = round(need.base + need.allowance)
    const available = need.item.trackLots ? usable(need.item, lots).total : (num(need.item.onHand) ?? 0)
    if (total > available) shortages.push({ item: need.item.id, name: nameOf(need.item), unit: unitOf(need.item), onHand: available, needed: total, short: round(total - available) })
    plans.push({ need, parts: allocate(need.item, lots, total) })
  }
  if (shortages.length && args.policy === 'refuse')
    throw new KittingError(
      'notEnoughStock',
      `Not enough to ${args.what}: ` + shortages.map((s) => `${s.name} has ${plural(s.onHand, s.unit)}, needs ${plural(s.needed, s.unit)}`).join('; ') + '.',
      shortages,
    )
  const movements: ApplyRecipeResult['movements'] = []
  const lotsUsed = new Map<string, { lot: ID | null; quantity: number }[]>()
  for (const { need, parts } of plans) {
    const total = round(need.base + need.allowance)
    lotsUsed.set(String(need.item.id), parts)
    for (const part of parts) {
      const allowance = total > 0 ? round((need.allowance * part.quantity) / total) : 0
      const doc = (await asInternal(req, { by: args.by, negativeStock: args.policy, recipe: args.recipe, count: args.count, allowance }, () =>
        payload.create({
          collection: o.movements as CollectionSlug,
          data: { item: need.item.id, kind: 'used', quantity: part.quantity, unit: unitOf(need.item), lot: part.lot, reference: args.reference, reason: args.reason } as never,
          ...sys,
          req,
        }),
      )) as Doc
      movements.push({ id: doc.id, item: need.item.id, lot: part.lot, change: doc.change, shrinkageAllowance: allowance, onHandAfter: doc.onHandAfter })
    }
  }
  return { movements, shortages, lots: lotsUsed }
}

/** Does `manage` let this person change the item? A query result must match the item. */
export async function mayManage(req: PayloadRequest, o: ResolvedSupplies, itemID: ID): Promise<boolean> {
  const access = await o.manage({ req } as never)
  if (access === true) return true
  if (!access) return false
  const found = await req.payload.count({ collection: o.items as CollectionSlug, where: { and: [{ id: { equals: itemID } }, access as Where] }, overrideAccess: true, req })
  return found.totalDocs > 0
}

const KINDS = ['received', 'used', 'adjusted', 'written-off']

/**
 * The movement hook: converts the entered unit to the item's, works out the change, picks or makes
 * the lot, refuses going below zero, records who.
 */
export async function prepareMovement(req: PayloadRequest, data: Doc): Promise<Doc> {
  const payload = req.payload
  const o = suppliesOf(payload)
  const internal = req.context?.[INTERNAL] as Internal | undefined
  const item = await getItem(payload, o, req, data.item)
  if (!item) throw new KittingError('itemNotFound', 'Choose a supply.')
  // A movement takes its owner from the item, so the person must be able to manage that item.
  if (!internal && req.user && !(await mayManage(req, o, item.id))) throw new KittingError('forbidden', 'You can’t record stock for that supply.')
  const onHand = num(item.onHand) ?? 0
  const unit = normalizeUnit(data.unit || item.unit) || unitOf(item)
  const factor = conversionFactor(unit, item.unit, item.packs ?? [])
  if (factor === null)
    throw new KittingError('unit', `${nameOf(item)} is counted in ${unitOf(item)}. Use one of: ${unitsFor(item.unit, item.packs ?? []).join(', ')}.`)
  const quantity = num(data.quantity)
  let change: number
  if (internal?.opening) {
    change = onHand
  } else if (!KINDS.includes(data.kind)) {
    throw new KittingError('kind', 'Choose received, used, written off or adjusted.')
  } else if (data.kind === 'adjusted') {
    if (quantity === null || quantity === 0) throw new KittingError('quantity', 'An adjustment adds (+) or takes away (−) something: it can’t be zero.')
    change = quantity * factor
  } else {
    if (quantity === null || quantity <= 0) throw new KittingError('quantity', 'The quantity is more than zero.')
    change = data.kind === 'received' ? quantity * factor : -quantity * factor
  }
  change = round(change)
  const after = internal?.opening ? onHand : round(onHand + change)
  const policy = internal?.negativeStock ?? o.negativeStock
  if (after < 0 && policy === 'refuse')
    throw new KittingError('notEnoughStock', `Not enough ${nameOf(item)}: ${plural(onHand, unitOf(item))} on hand, this would leave ${plural(after, unitOf(item))}.`, [
      { item: item.id, name: nameOf(item), unit: unitOf(item), onHand, needed: -change, short: round(-after) },
    ])

  // Lots: stock in goes into a lot (given, found by number, or new); stock out comes from one.
  let lot: Doc | null = null
  if (item.trackLots) {
    const lots = await lotsOf(payload, o, req, item.id)
    const given = idOf(data.lot)
    if (given !== null) {
      lot = lots.find((l) => sameID(l.id, given)) ?? null
      if (!lot) throw new KittingError('lot', `That lot isn’t a lot of ${nameOf(item)}.`)
    } else if (change > 0 && data.lotNumber) {
      lot = lots.find((l) => String(l.lotNumber ?? '') === String(data.lotNumber).trim()) ?? (await createLot(payload, o, req, item, data.lotNumber, data.expiresOn))
    } else if (change > 0 && (data.kind === 'received' || internal?.opening)) {
      lot = await createLot(payload, o, req, item, null, data.expiresOn)
    } else if (change > 0) {
      lot = lots.at(-1) ?? (await createLot(payload, o, req, item, null, data.expiresOn))
    } else if (change < 0 && !internal) {
      // By hand: the first-to-expire lot that covers it. Several lots: record one movement per lot.
      const { fresh } = usable(item, lots)
      lot = fresh.find((l) => (num(l.onHand) as number) >= -change) ?? null
      if (!lot && fresh.length)
        throw new KittingError(
          'lot',
          `No single lot of ${nameOf(item)} has ${plural(-change, unitOf(item))}. Record it lot by lot: ` +
            fresh.map((l) => `${lotName(l)} has ${plural(num(l.onHand) as number, unitOf(item))}`).join('; ') +
            '.',
        )
    }
    if (lot && change < 0 && !internal && (num(lot.onHand) ?? 0) + change < 0 && policy === 'refuse')
      throw new KittingError('notEnoughStock', `${lotName(lot)} of ${nameOf(item)} has only ${plural(num(lot.onHand) ?? 0, unitOf(item))}.`)
  }

  const out: Doc = { ...data, unit, change, onHandAfter: after, lot: lot?.id ?? null, by: internal ? (internal.by ?? null) : req.user && req.user.collection === o.userSlug ? req.user.id : null }
  delete out.lotNumber
  delete out.expiresOn
  out.writeOffReason = data.kind === 'written-off' ? data.writeOffReason || 'other' : null
  // Only the plugin links a movement to a recipe or records a shrinkage allowance.
  out.recipe = internal?.recipe ?? null
  out.count = internal?.count ?? null
  out.shrinkageAllowance = internal?.allowance ?? 0
  if (internal?.opening) out.kind = 'adjusted'
  if (o.scopeField) out[o.scopeField] = idOf(item[o.scopeField])
  return out
}

/** After a movement is saved: bring the item's (and lot's) on hand and alert state in line, in the same transaction. */
export async function applyMovementToItem(req: PayloadRequest, doc: Doc) {
  const payload = req.payload
  const o = suppliesOf(payload)
  const internal = req.context?.[INTERNAL] as Internal | undefined
  if (idOf(doc.lot) !== null) {
    const lot = (await payload.findByID({ collection: o.lots as CollectionSlug, id: idOf(doc.lot)!, ...sys, joins: false, req })) as Doc
    await asInternal(req, { ...internal }, () =>
      payload.update({ collection: o.lots as CollectionSlug, id: lot.id, data: { onHand: round((num(lot.onHand) ?? 0) + doc.change) } as never, ...sys, req }),
    )
  }
  if (internal?.opening) return
  const item = (await payload.findByID({ collection: o.items as CollectionSlug, id: idOf(doc.item)!, ...sys, joins: false, req })) as Doc
  await asInternal(req, { ...internal }, () =>
    payload.update({
      collection: o.items as CollectionSlug,
      id: item.id,
      data: { onHand: doc.onHandAfter, ...alertFields(item, doc.onHandAfter, item.retired ? null : item.lowStockLevel) } as never,
      ...sys,
      req,
    }),
  )
}

/**
 * Write off every lot past its use-by day that still has stock, as `written-off` (expired), one lot per
 * transaction. Run it from a scheduled job; the overview also runs it when `lots.autoWriteOff` is on.
 */
export async function writeOffExpired(payload: Payload, options: { now?: Date } = {}): Promise<{ lots: number }> {
  const o = suppliesOf(payload)
  const now = options.now ?? new Date()
  const candidates = (await payload.find({ collection: o.lots as CollectionSlug, where: { onHand: { greater_than: 0 } }, ...list })).docs as Doc[]
  let written = 0
  for (const lot of candidates.filter((l) => isExpired(l.expiresOn, now))) {
    try {
      await transaction(payload, undefined, async (req) => {
        const fresh = (await payload.findByID({ collection: o.lots as CollectionSlug, id: lot.id, ...sys, joins: false, disableErrors: true, req })) as Doc | null
        const left = num(fresh?.onHand) ?? 0
        if (!fresh || left <= 0) return
        await asInternal(req, { negativeStock: 'warn' }, () =>
          payload.create({
            collection: o.movements as CollectionSlug,
            data: { item: idOf(fresh.item), kind: 'written-off', writeOffReason: 'expired', quantity: left, lot: fresh.id, reason: `Expired (use by ${String(fresh.expiresOn).slice(0, 10)})` } as never,
            ...sys,
            req,
          }),
        )
        await refreshStockStates(payload, { req, scope: o.scopeField ? idOf(fresh[o.scopeField]) : null })
        written++
      })
    } catch (error) {
      payload.logger.error({ err: error, msg: `kitting: couldn’t write off expired lot ${lot.id}` })
    }
  }
  if (written) await sendPendingAlerts(payload).catch(() => undefined)
  return { lots: written }
}

/**
 * Suggest an item's shrinkage allowance from what really happened over the last `days` (default 90):
 * the allowance already taken, plus recorded write-offs, minus what recounts found extra, as a share of
 * what recipes used. Needs at least `minUses` (default 10) recipe uses; otherwise says why not.
 */
export async function suggestShrinkagePercent(
  payload: Payload,
  itemID: ID,
  options: { days?: number; minUses?: number; now?: Date; req?: Req } = {},
): Promise<{ percent: number | null; explanation: string; basis: { used: number; shrinkageAllowance: number; writtenOff: number; corrections: number; uses: number } }> {
  const o = suppliesOf(payload)
  const days = options.days ?? 90
  const minUses = options.minUses ?? 10
  const since = new Date((options.now ?? new Date()).getTime() - days * DAY).toISOString()
  const item = await getItem(payload, o, options.req ?? {}, itemID)
  if (!item) throw new KittingError('itemNotFound', 'That supply doesn’t exist.')
  const ms = (await payload.find({ collection: o.movements as CollectionSlug, where: { and: [{ item: { equals: itemID } }, { createdAt: { greater_than_equal: since } }] }, ...list, req: options.req }))
    .docs as Doc[]
  let used = 0
  let allowance = 0
  let wasted = 0
  let corrections = 0
  let uses = 0
  for (const m of ms) {
    const change = num(m.change) ?? 0
    if (m.kind === 'used' && idOf(m.recipe) !== null) {
      const a = num(m.shrinkageAllowance) ?? 0
      used += -change - a
      allowance += a
      uses++
    } else if (m.kind === 'written-off') wasted += -change
    else if (m.kind === 'adjusted' && m.reason !== 'Opening stock') corrections += change
  }
  const basis = { used: round(used), shrinkageAllowance: round(allowance), writtenOff: round(wasted), corrections: round(corrections), uses }
  const unit = unitOf(item)
  if (uses < minUses || used <= 0)
    return { percent: null, basis, explanation: `Not enough history yet: ${uses} recipe use${uses === 1 ? '' : 's'} of ${nameOf(item)} in ${days} days (needs ${minUses}).` }
  const loss = allowance + wasted - corrections
  const percent = Math.max(Math.round((loss / used) * 1000) / 10, 0)
  return {
    percent,
    basis,
    explanation:
      `Over ${days} days recipes used ${plural(basis.used, unit)} of ${nameOf(item)}. ` +
      `The shrinkage allowance took ${plural(basis.shrinkageAllowance, unit)}, ${plural(basis.writtenOff, unit)} was written off, ` +
      `and counts found ${plural(Math.abs(basis.corrections), unit)} ${basis.corrections >= 0 ? 'more' : 'less'} than expected. ` +
      `That’s about ${percent}% lost.`,
  }
}

async function alertItemOf(payload: Payload, o: ResolvedSupplies, item: Doc, req?: Req): Promise<AlertItem> {
  const supplierID = idOf(item.supplier)
  const supplier = supplierID === null ? null : ((await payload.findByID({ collection: o.suppliers as CollectionSlug, id: supplierID, ...sys, joins: false, disableErrors: true, req })) as Doc | null)
  return {
    id: item.id,
    name: nameOf(item),
    unit: unitOf(item),
    sku: item.sku ?? null,
    onHand: num(item.onHand) ?? 0,
    lowStockLevel: num(item.lowStockLevel) ?? 0,
    suggestedReorder: suggestedReorder(item),
    supplier: supplier ? { id: supplier.id, name: String(supplier.name ?? '') } : null,
    scope: o.scopeField ? idOf(item[o.scopeField]) : null,
  }
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function defaultAlertEmail({ item, adminURL }: { item: AlertItem; adminURL: string | null }) {
  const lines = [
    `${item.name}${item.sku ? ` (${item.sku})` : ''} is below its low-stock level.`,
    `On hand: ${plural(item.onHand, item.unit)}. Level: ${plural(item.lowStockLevel, item.unit)}.`,
    `Suggested reorder: ${plural(item.suggestedReorder, item.unit)}${item.supplier?.name ? ` from ${item.supplier.name}` : ''}.`,
    'You won’t get another email about it until it’s back at or above the level.',
  ]
  return {
    subject: `Low stock: ${item.name}`,
    text: [...lines, ...(adminURL ? ['', adminURL] : [])].join('\n'),
    html: lines.map((l) => `<p>${escape(l)}</p>`).join('') + (adminURL ? `<p><a href="${escape(adminURL)}">Open it in the admin</a></p>` : ''),
  }
}

async function deliver(payload: Payload, o: ResolvedSupplies, item: Doc, req?: Req): Promise<{ status: AlertStatus; note: string | null }> {
  if (!(await o.canSend({ payload }))) return { status: 'not-sent', note: 'Email is off here.' }
  const alertItem = await alertItemOf(payload, o, item, req)
  const to = [...new Set((Array.isArray(o.recipients) ? o.recipients : await o.recipients({ payload, item: alertItem })).map((a) => a.trim()).filter(Boolean))]
  if (!to.length) return { status: 'not-sent', note: 'No alert addresses are set.' }
  const base = payload.config.serverURL
  const adminURL = base ? `${base}${payload.config.routes.admin}/collections/${o.items}/${item.id}` : null
  const email = (o.render ?? defaultAlertEmail)({ item: alertItem, adminURL })
  try {
    if (o.sendEmail) await o.sendEmail({ payload, to, ...email })
    else await payload.sendEmail({ to, subject: email.subject, html: email.html, text: email.text })
    return { status: 'sent', note: null }
  } catch (error) {
    payload.logger.error({ err: error, msg: `kitting: low-stock email for ${item.id} failed` })
    return { status: 'failed', note: String((error as Error)?.message ?? error).slice(0, 200) }
  }
}

/**
 * Send every pending low-stock email, once each. With `req`, only the given items, inside that
 * request's transaction (the admin's own saves). Without, each item is claimed in its own short
 * transaction first, so two callers at once can't both send it.
 */
export async function sendPendingAlerts(payload: Payload, options: { req?: Req; ids?: ID[] } = {}): Promise<{ sent: number; notSent: number; failed: number }> {
  const o = suppliesOf(payload)
  const report = { sent: 0, notSent: 0, failed: 0 }
  const where: Where = options.ids ? { and: [{ alertStatus: { equals: 'pending' } }, { id: { in: options.ids } }] } : { alertStatus: { equals: 'pending' } }
  const pending = (await payload.find({ collection: o.items as CollectionSlug, where, ...list, req: options.req })).docs as Doc[]
  const mark = (id: ID, data: Doc, req: Req = {}) => asInternal(req, {}, () => payload.update({ collection: o.items as CollectionSlug, id, data: data as never, ...sys, req }))
  for (const item of pending) {
    let claimed: Doc | null
    if (options.req) claimed = item
    else
      try {
        claimed = await transaction(payload, undefined, async (req) => {
          const fresh = (await payload.findByID({ collection: o.items as CollectionSlug, id: item.id, ...sys, joins: false, disableErrors: true, req })) as Doc | null
          if (fresh?.alertStatus !== 'pending') return null
          await mark(item.id, { alertStatus: 'sending' }, req)
          return fresh
        })
      } catch {
        claimed = null // someone else claimed it first
      }
    if (!claimed) continue
    const { status, note } = await deliver(payload, o, claimed, options.req)
    await mark(item.id, { alertStatus: status, alertAt: new Date().toISOString(), alertNote: note }, options.req)
    if (status === 'sent') report.sent++
    else if (status === 'failed') report.failed++
    else report.notSent++
  }
  // Ready-stock emails are claimed the same way; only outside a caller's transaction.
  if (!options.req) await sendStockAlerts(payload).catch((error) => payload.logger.error({ err: error, msg: 'kitting: ready-stock alerts not sent' }))
  return report
}

export type StockRow = {
  id: ID
  name: string
  unit: string
  sku: string | null
  onHand: number
  lowStockLevel: number | null
  reorderQuantity: number | null
  suggestedReorder: number
  below: boolean
  retired: boolean
  belowLevelSince: string | null
  alertStatus: AlertStatus | null
  alertAt: string | null
  alertNote: string | null
  supplier: { id: ID; name: string; email?: string | null; phone?: string | null; website?: string | null } | null
  scope: ID | null
  scopeName: string | null
  /** Lots with stock, first to expire first (supplies with lots tracked). */
  lots: LotRow[]
  /** On hand minus expired lots not yet written off. */
  usable: number
  /** The item's own shrinkage allowance, or the default (null when allowances are off). */
  shrinkagePercent: number | null
}

export type LotRow = { id: ID; label: string; lotNumber: string | null; expiresOn: string | null; onHand: number; expired: boolean; expiringSoon: boolean }

/**
 * Every item someone can see, with what's below level and how much to reorder. Pass the signed-in
 * user to apply their access (the admin overview does); without one it reads everything.
 */
export async function stockReport(
  payload: Payload,
  options: { user?: Doc | null; req?: Req; now?: Date } = {},
): Promise<{ rows: StockRow[]; below: StockRow[]; expiring: (LotRow & { item: StockRow })[] }> {
  const o = suppliesOf(payload)
  const now = options.now ?? new Date()
  const access = options.user !== undefined ? { overrideAccess: false, user: options.user } : { overrideAccess: true }
  const docs = (await payload.find({ collection: o.items as CollectionSlug, ...access, depth: 1, pagination: false, sort: 'name', req: options.req })).docs as Doc[]
  const lotDocs = docs.some((d) => d.trackLots)
    ? ((await payload.find({ collection: o.lots as CollectionSlug, where: { onHand: { greater_than: 0 } }, ...access, depth: 0, pagination: false, req: options.req })).docs as Doc[])
    : []
  const rows = docs.map((d): StockRow => {
    const warn = num(d.expiryWarningDays) ?? o.lotWarningDays
    const lots: LotRow[] = d.trackLots
      ? lotDocs
          .filter((l) => sameID(l.item, d.id))
          .sort(byExpiry)
          .map((l) => ({
            id: l.id,
            label: String(l.label ?? l.lotNumber ?? ''),
            lotNumber: l.lotNumber ?? null,
            expiresOn: l.expiresOn ?? null,
            onHand: num(l.onHand) ?? 0,
            expired: isExpired(l.expiresOn, now),
            expiringSoon: expiresWithin(l.expiresOn, warn, now),
          }))
      : []
    const supplier = d.supplier && typeof d.supplier === 'object' ? d.supplier : null
    const scope = o.scopeField ? d[o.scopeField] : null
    const onHand = num(d.onHand) ?? 0
    return {
      id: d.id,
      name: nameOf(d),
      unit: unitOf(d),
      sku: d.sku ?? null,
      onHand,
      lowStockLevel: num(d.lowStockLevel),
      reorderQuantity: num(d.reorderQuantity),
      suggestedReorder: suggestedReorder(d),
      below: !d.retired && isBelowLevel(onHand, d.lowStockLevel),
      retired: Boolean(d.retired),
      belowLevelSince: d.belowLevelSince ?? null,
      alertStatus: d.alertStatus ?? null,
      alertAt: d.alertAt ?? null,
      alertNote: d.alertNote ?? null,
      supplier: supplier ? { id: supplier.id, name: String(supplier.name ?? ''), email: supplier.email ?? null, phone: supplier.phone ?? null, website: supplier.website ?? null } : null,
      scope: idOf(scope),
      scopeName: scope && typeof scope === 'object' ? String(scope.name ?? scope.title ?? scope.slug ?? scope.id) : null,
      lots,
      usable: round(onHand - lots.filter((l) => l.expired).reduce((t, l) => t + l.onHand, 0)),
      shrinkagePercent: o.shrinkage.enabled ? (percentOf(d.shrinkagePercent) ?? o.shrinkage.defaultPercent) : null,
    }
  })
  const expiring = rows.flatMap((r) => (r.retired ? [] : r.lots.filter((l) => l.expired || l.expiringSoon).map((l) => ({ ...l, item: r }))))
  expiring.sort(byExpiry)
  return { rows, below: rows.filter((r) => r.below), expiring }
}

export type CountLine = { item: ID; counted: number }
export type CountResult = { counted: number; changed: { item: ID; name: string; unit: string; before: number; after: number; change: number }[] }

/**
 * A stock count: for each supply, what's really there, in its own unit. Each difference becomes one
 * `adjusted` movement ("Stock count"), all in one transaction; supplies that match are left alone. With
 * lots, a shortfall comes off the first to expire (expired lots first, as they're usually what's gone),
 * and extra goes into the newest lot. Pass `req` with a user to check they may manage every supply.
 */
export async function stockCount(payload: Payload, lines: CountLine[], options: { req?: Req; user?: { id: ID } | null; reason?: string } = {}): Promise<CountResult> {
  const o = suppliesOf(payload)
  if (!lines.length) throw new KittingError('noCounts', 'Enter at least one count.')
  const seen = new Set<string>()
  for (const l of lines) {
    if (!(typeof l.counted === 'number' && Number.isFinite(l.counted) && l.counted >= 0)) throw new KittingError('quantity', 'A count is a number, 0 or more.')
    if (seen.has(String(l.item))) throw new KittingError('duplicate', 'A supply is counted twice.')
    seen.add(String(l.item))
  }
  const joined = Boolean(options.req?.transactionID)
  const result = await transaction(payload, options.req, async (req) => {
    const by = idOf(options.user ?? req.user ?? null)
    const changed: CountResult['changed'] = []
    for (const line of lines) {
      const item = await getItem(payload, o, req, line.item)
      if (!item) throw new KittingError('itemNotFound', 'A counted supply doesn’t exist.')
      if (req.user && !(await mayManage(req as PayloadRequest, o, item.id))) throw new KittingError('forbidden', `You can’t count ${nameOf(item)}.`)
      const before = num(item.onHand) ?? 0
      const counted = round(line.counted)
      const diff = round(counted - before)
      if (diff === 0) continue
      const reason = options.reason ?? 'Stock count'
      const parts: { lot: ID | null; quantity: number }[] = []
      if (item.trackLots && diff < 0) {
        // Gone first: expired lots, then first to expire; then stock from before lots were tracked.
        const lots = (await lotsOf(payload, o, req, item.id)).filter((l) => (num(l.onHand) ?? 0) > 0)
        const ordered = [...lots.filter((l) => isExpired(l.expiresOn)), ...lots.filter((l) => !isExpired(l.expiresOn))]
        let left = -diff
        for (const lot of ordered) {
          if (left <= 0) break
          const take = round(Math.min(num(lot.onHand) as number, left))
          parts.push({ lot: lot.id, quantity: -take })
          left = round(left - take)
        }
        if (left > 0) parts.push({ lot: null, quantity: -left })
      } else parts.push({ lot: null, quantity: diff })
      for (const part of parts)
        await asInternal(req, { by, negativeStock: 'warn' }, () =>
          payload.create({ collection: o.movements as CollectionSlug, data: { item: item.id, kind: 'adjusted', quantity: part.quantity, unit: unitOf(item), lot: part.lot, reason } as never, ...sys, req }),
        )
      changed.push({ item: item.id, name: nameOf(item), unit: unitOf(item), before, after: counted, change: diff })
    }
    await refreshStockStates(payload, { req })
    return { counted: lines.length, changed }
  })
  if (!joined) await sendPendingAlerts(payload).catch((error) => payload.logger.error({ err: error, msg: 'kitting: low-stock alerts not sent' }))
  return result
}

/** How far a site has got with setting up: the guided setup's checklist. */
export async function setupProgress(payload: Payload, options: { user?: Doc | null; req?: Req } = {}) {
  const o = suppliesOf(payload)
  const access = options.user !== undefined ? { overrideAccess: false, user: options.user } : { overrideAccess: true }
  const count = async (collection: string, where?: Where) => (await payload.count({ collection: collection as CollectionSlug, where, ...access, req: options.req })).totalDocs
  const supplies = await count(o.items)
  const recipes = await count(o.recipes)
  const counts = await count(o.movements, { reason: { equals: 'Stock count' } })
  return {
    supplies,
    recipes,
    counted: counts > 0,
    done: supplies > 0 && recipes > 0 && counts > 0,
  }
}
