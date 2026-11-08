import { APIError, type CollectionSlug, type Payload, type PayloadRequest, type Where } from 'payload'

import type { AlertItem, AlertStatus, ApplyRecipeContext, ApplyRecipeResult, ID, NegativeStock, RecipeRef, ResolvedSupplies, Shortage } from './types.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Req = Partial<PayloadRequest>

/** Request-context key for writes the plugin makes itself. Hosts never set it. */
export const INTERNAL = 'suppliesInternal'
/**
 * Request-context key that lets a trusted script delete movements (for example when a whole site
 * or a sandbox is removed). Nothing else can delete or edit a movement.
 */
export const ALLOW_DELETE = 'suppliesAllowDelete'

export type Internal = { by?: ID | null; negativeStock?: NegativeStock; opening?: boolean; recipe?: ID; count?: number }

export const suppliesOf = (payload: Payload): ResolvedSupplies => {
  const o = payload.config.custom?.supplies as ResolvedSupplies | undefined
  if (!o) throw new Error('payload-plugin-supplies is not installed in this Payload config.')
  return o
}

export const idOf = (v: unknown): ID | null => (v && typeof v === 'object' ? ((v as { id: ID }).id ?? null) : v === undefined || v === null || v === '' ? null : (v as ID))
export const sameID = (a: unknown, b: unknown) => String(idOf(a) ?? '') === String(idOf(b) ?? '')
/** Quantities may be fractional (ml, metres); keep sums free of floating-point dust. */
export const round = (n: number) => Math.round(n * 1e6) / 1e6
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

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

export class SuppliesError extends APIError<{ code: string; shortages?: Shortage[] }> {
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

async function findRecipe(payload: Payload, o: ResolvedSupplies, req: Req, ref: RecipeRef | Doc, scope?: ID): Promise<Doc> {
  if ('key' in ref && typeof ref.key === 'string' && !('id' in ref)) {
    if (o.scopeField && (scope === undefined || scope === null)) throw new SuppliesError('scope', `Say which ${o.scopeField} the recipe "${ref.key}" belongs to.`)
    const where: Where = o.scopeField ? { and: [{ key: { equals: ref.key } }, { [o.scopeField]: { equals: scope } }] } : { key: { equals: ref.key } }
    const found = (await payload.find({ collection: o.recipes as CollectionSlug, where, limit: 1, ...list, req })).docs[0] as Doc | undefined
    if (!found) throw new SuppliesError('recipeNotFound', `No recipe with the key "${ref.key}".`)
    return found
  }
  const id = idOf(ref)
  const found = id === null ? null : ((await payload.findByID({ collection: o.recipes as CollectionSlug, id, ...sys, joins: false, disableErrors: true, req })) as Doc | null)
  if (!found) throw new SuppliesError('recipeNotFound', 'That recipe doesn’t exist.')
  if (o.scopeField && scope !== undefined && scope !== null && !sameID(found[o.scopeField], scope)) throw new SuppliesError('scope', 'That recipe belongs somewhere else.')
  return found
}

/**
 * Use a recipe's supplies to make `count` of something, in one transaction: one `used` movement per
 * item, or nothing at all. Refuses when any item would go below zero (unless `negativeStock` is
 * `warn`), naming every item that's short.
 */
export async function applyRecipe(payload: Payload, recipe: RecipeRef, count: number, context: ApplyRecipeContext = {}): Promise<ApplyRecipeResult> {
  const o = suppliesOf(payload)
  if (!Number.isInteger(count) || count < 1) throw new SuppliesError('count', 'The count is a whole number, 1 or more.')
  const policy = context.negativeStock ?? o.negativeStock
  const joined = Boolean(context.req?.transactionID)
  const result = await transaction(payload, context.req, async (req) => {
    const r = await findRecipe(payload, o, req, recipe, context.scope)
    if (r.active === false) throw new SuppliesError('recipeInactive', `The recipe "${r.name}" is switched off.`)
    const totals = new Map<string, { id: ID; quantity: number }>()
    for (const line of (r.lines ?? []) as Doc[]) {
      const id = idOf(line.item)
      const quantity = num(line.quantity)
      if (id === null || quantity === null || quantity <= 0) continue
      const prev = totals.get(String(id))
      totals.set(String(id), { id, quantity: round((prev?.quantity ?? 0) + quantity * count) })
    }
    if (!totals.size) throw new SuppliesError('recipeEmpty', `The recipe "${r.name}" has no supplies in it.`)

    const items: Doc[] = []
    for (const { id } of totals.values()) {
      const item = (await payload.findByID({ collection: o.items as CollectionSlug, id, ...sys, joins: false, disableErrors: true, req })) as Doc | null
      if (!item) throw new SuppliesError('itemNotFound', `A supply in "${r.name}" no longer exists. Edit the recipe.`)
      if (o.scopeField && !sameID(item[o.scopeField], r[o.scopeField])) throw new SuppliesError('scope', `"${nameOf(item)}" belongs somewhere else than the recipe "${r.name}".`)
      items.push(item)
    }
    const shortages: Shortage[] = items.flatMap((item) => {
      const needed = totals.get(String(item.id))!.quantity
      const onHand = num(item.onHand) ?? 0
      return onHand - needed < 0 ? [{ item: item.id as ID, name: nameOf(item), unit: unitOf(item), onHand, needed, short: round(needed - onHand) }] : []
    })
    if (shortages.length && policy === 'refuse')
      throw new SuppliesError(
        'notEnoughStock',
        `Not enough to make ${count} with "${r.name}": ` + shortages.map((s) => `${s.name} has ${plural(s.onHand, s.unit)}, needs ${plural(s.needed, s.unit)}`).join('; ') + '.',
        shortages,
      )

    const by = idOf(context.user ?? req.user ?? null)
    const movements: ApplyRecipeResult['movements'] = []
    for (const item of items) {
      const quantity = totals.get(String(item.id))!.quantity
      const doc = (await asInternal(req, { by, negativeStock: policy, recipe: r.id, count }, () =>
        payload.create({
          collection: o.movements as CollectionSlug,
          data: { item: item.id, kind: 'used', quantity, reference: context.reference ?? null, reason: context.reason ?? `Used by recipe "${r.name}" × ${count}` } as never,
          ...sys,
          req,
        }),
      )) as Doc
      movements.push({ id: doc.id, item: item.id, change: doc.change, onHandAfter: doc.onHandAfter })
    }
    return { recipe: { id: r.id as ID, name: String(r.name) }, count, movements, shortages }
  })
  // Our own transaction is committed: send the alert now. A caller's transaction isn't, so the
  // alert stays pending until they call sendPendingAlerts, or the next save sends it.
  if (!joined) await sendPendingAlerts(payload).catch((error) => payload.logger.error({ err: error, msg: 'supplies: low-stock alerts not sent' }))
  return result
}

/** Does `manage` let this person change the item? A query result must match the item. */
export async function mayManage(req: PayloadRequest, o: ResolvedSupplies, itemID: ID): Promise<boolean> {
  const access = await o.manage({ req } as never)
  if (access === true) return true
  if (!access) return false
  const found = await req.payload.count({ collection: o.items as CollectionSlug, where: { and: [{ id: { equals: itemID } }, access as Where] }, overrideAccess: true, req })
  return found.totalDocs > 0
}

/** The movement hook: works out the change, refuses going below zero, records who. */
export async function prepareMovement(req: PayloadRequest, data: Doc): Promise<Doc> {
  const payload = req.payload
  const o = suppliesOf(payload)
  const internal = req.context?.[INTERNAL] as Internal | undefined
  const item = (await payload.findByID({ collection: o.items as CollectionSlug, id: idOf(data.item)!, ...sys, joins: false, disableErrors: true, req })) as Doc | null
  if (!item) throw new SuppliesError('itemNotFound', 'Choose a supply.')
  // A movement takes its owner from the item, so the person must be able to manage that item.
  if (!internal && req.user && !(await mayManage(req, o, item.id))) throw new SuppliesError('forbidden', 'You can’t record stock for that supply.')
  const onHand = num(item.onHand) ?? 0
  const quantity = num(data.quantity)
  let change: number
  if (internal?.opening) {
    change = onHand
  } else if (data.kind === 'received' || data.kind === 'used') {
    if (quantity === null || quantity <= 0) throw new SuppliesError('quantity', 'The quantity is more than zero.')
    change = data.kind === 'received' ? quantity : -quantity
  } else if (data.kind === 'adjusted') {
    if (quantity === null || quantity === 0) throw new SuppliesError('quantity', 'An adjustment adds (+) or takes away (−) something: it can’t be zero.')
    change = quantity
  } else throw new SuppliesError('kind', 'Choose received, used or adjusted.')
  change = round(change)
  const after = internal?.opening ? onHand : round(onHand + change)
  const policy = internal?.negativeStock ?? o.negativeStock
  if (after < 0 && policy === 'refuse')
    throw new SuppliesError('notEnoughStock', `Not enough ${nameOf(item)}: ${plural(onHand, unitOf(item))} on hand, this would leave ${plural(after, unitOf(item))}.`, [
      { item: item.id, name: nameOf(item), unit: unitOf(item), onHand, needed: -change, short: round(-after) },
    ])
  const out: Doc = { ...data, change, onHandAfter: after, by: internal ? (internal.by ?? null) : req.user && req.user.collection === o.userSlug ? req.user.id : null }
  // Only the plugin links a movement to a recipe.
  out.recipe = internal?.recipe ?? null
  out.count = internal?.count ?? null
  if (internal?.opening) out.kind = 'adjusted'
  if (o.scopeField) out[o.scopeField] = idOf(item[o.scopeField])
  return out
}

/** After a movement is saved: bring the item's on hand and alert state in line, in the same transaction. */
export async function applyMovementToItem(req: PayloadRequest, doc: Doc) {
  const payload = req.payload
  const o = suppliesOf(payload)
  const internal = req.context?.[INTERNAL] as Internal | undefined
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
    payload.logger.error({ err: error, msg: `supplies: low-stock email for ${item.id} failed` })
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
}

/**
 * Every item someone can see, with what's below level and how much to reorder. Pass the signed-in
 * user to apply their access (the admin overview does); without one it reads everything.
 */
export async function stockReport(payload: Payload, options: { user?: Doc | null; req?: Req } = {}): Promise<{ rows: StockRow[]; below: StockRow[] }> {
  const o = suppliesOf(payload)
  const access = options.user !== undefined ? { overrideAccess: false, user: options.user } : { overrideAccess: true }
  const docs = (await payload.find({ collection: o.items as CollectionSlug, ...access, depth: 1, pagination: false, sort: 'name', req: options.req })).docs as Doc[]
  const rows = docs.map((d): StockRow => {
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
    }
  })
  return { rows, below: rows.filter((r) => r.below) }
}
