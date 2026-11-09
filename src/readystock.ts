import type { CollectionSlug, Payload, PayloadRequest, Where } from 'payload'

import { asInternal, idOf, isBelowLevel, lotsOf, num, planRecipe, round, suppliesOf, transaction, usable } from './stock.js'
import type { AlertStatus, ID, ResolvedSupplies } from './types.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Req = Partial<PayloadRequest>

const sys = { overrideAccess: true, depth: 0 } as const
const list = { ...sys, pagination: false, joins: false } as const

/**
 * Where a recipe's ready stock stands, by the owner's rules:
 * - ok: enough ready, supplies fine (or no number to keep set).
 * - info: enough ready, but supplies are low. Low concern.
 * - build-more: fewer ready than the number to keep, and supplies to build them.
 * - urgent: fewer ready than the number to keep, and supplies are low.
 */
export type StockState = 'ok' | 'info' | 'build-more' | 'urgent'

export const stateFor = (ready: number, baseline: number | null, low: boolean): StockState | null => {
  if (baseline === null) return null
  if (ready >= baseline) return low ? 'info' : 'ok'
  return low ? 'urgent' : 'build-more'
}

export const STATE_TEXT: Record<StockState, string> = {
  ok: 'OK',
  info: 'Enough ready, but supplies are low',
  'build-more': 'Build more',
  urgent: 'Urgent: few ready and supplies low',
}

export type ReadyStatus = {
  recipe: { id: ID; name: string }
  ready: number
  baseline: number | null
  toBuild: number
  /** How many could be built from usable stock right now. */
  canBuild: number
  low: boolean
  /** Why supplies count as low, in words. */
  reasons: string[]
  state: StockState | null
}

/** Work out a recipe's ready stock, supplies and state. */
export async function readyStatus(payload: Payload, recipe: Doc, req: Req = {}): Promise<ReadyStatus> {
  const o = suppliesOf(payload)
  const baseline = num(recipe.readyStock?.baseline)
  const rule = recipe.readyStock?.suppliesLowWhen ?? 'either'
  const ready = (await payload.count({ collection: o.units as CollectionSlug, where: { and: [{ recipe: { equals: recipe.id } }, { status: { equals: 'ready' } }] }, overrideAccess: true, req }))
    .totalDocs
  const toBuild = baseline === null ? 0 : Math.max(baseline - ready, 0)
  const needs = await planRecipe(payload, o, req, recipe, 1)
  const reasons: string[] = []
  let canBuild = Infinity
  for (const need of needs.values()) {
    const item = need.item
    const per = round(need.base + need.allowance)
    const have = item.trackLots ? usable(item, await lotsOf(payload, o, req, item.id)).total : (num(item.onHand) ?? 0)
    if (per > 0) canBuild = Math.min(canBuild, Math.floor(have / per + 1e-9))
    if ((rule === 'either' || rule === 'below-level') && !item.retired && isBelowLevel(num(item.onHand) ?? 0, item.lowStockLevel)) reasons.push(`${item.name} is below its level`)
  }
  if (!Number.isFinite(canBuild)) canBuild = 0
  if ((rule === 'either' || rule === 'cannot-reach') && toBuild > canBuild) reasons.push(`there's enough to build ${canBuild}, not the ${toBuild} needed`)
  const low = reasons.length > 0
  return { recipe: { id: recipe.id, name: String(recipe.name) }, ready, baseline, toBuild, canBuild, low, reasons, state: stateFor(ready, baseline, low) }
}

/**
 * Bring every recipe's ready-stock state up to date (recipes with a number to keep, in one scope
 * when given). A change into info, build-more or urgent marks one email as pending; back to ok clears
 * it. Runs inside the caller's transaction when given one; send with `sendPendingAlerts` after it.
 */
export async function refreshStockStates(payload: Payload, options: { req?: Req; scope?: ID | null } = {}): Promise<{ changed: { recipe: ID; from: StockState | null; to: StockState | null }[] }> {
  const o = suppliesOf(payload)
  return transaction(payload, options.req, async (req) => {
    const where: Where = {
      and: [{ 'readyStock.baseline': { exists: true } }, { active: { not_equals: false } }, ...(o.scopeField && options.scope != null ? [{ [o.scopeField]: { equals: options.scope } }] : [])],
    }
    const recipes = (await payload.find({ collection: o.recipes as CollectionSlug, where, ...list, req })).docs as Doc[]
    const changed: { recipe: ID; from: StockState | null; to: StockState | null }[] = []
    for (const r of recipes) {
      const status = await readyStatus(payload, r, req)
      const from = (r.stockState ?? null) as StockState | null
      if (status.state === from) continue
      changed.push({ recipe: r.id, from, to: status.state })
      const alert = status.state && status.state !== 'ok' ? 'pending' : null
      await asInternal(req, {}, () =>
        payload.update({
          collection: o.recipes as CollectionSlug,
          id: r.id,
          data: { stockState: status.state, stockStateSince: new Date().toISOString(), stockAlertStatus: alert, stockAlertNote: null } as never,
          ...sys,
          req,
        }),
      )
    }
    return { changed }
  })
}

export function defaultStockEmail({ status, adminURL }: { status: ReadyStatus; adminURL: string | null }) {
  const s = status.state!
  const lines = [
    `${status.recipe.name}: ${STATE_TEXT[s]}.`,
    `Ready: ${status.ready}. Keep ready: ${status.baseline ?? '—'}.${status.toBuild ? ` Build ${status.toBuild}.` : ''}`,
    ...(status.reasons.length ? [`Supplies: ${status.reasons.join('; ')}.`] : []),
    'You won’t get another email about it until this changes.',
  ]
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  return {
    subject: `${s === 'urgent' ? 'Urgent: ' : ''}${status.recipe.name}: ${STATE_TEXT[s].toLowerCase()}`,
    text: [...lines, ...(adminURL ? ['', adminURL] : [])].join('\n'),
    html: lines.map((l) => `<p>${esc(l)}</p>`).join('') + (adminURL ? `<p><a href="${esc(adminURL)}">Open it in the admin</a></p>` : ''),
  }
}

/** Send each pending ready-stock email once, claiming each recipe in its own short transaction. */
export async function sendStockAlerts(payload: Payload): Promise<{ sent: number; notSent: number; failed: number }> {
  const o = suppliesOf(payload)
  const report = { sent: 0, notSent: 0, failed: 0 }
  const pending = (await payload.find({ collection: o.recipes as CollectionSlug, where: { stockAlertStatus: { equals: 'pending' } }, ...list })).docs as Doc[]
  const mark = (id: ID, data: Doc, req: Req = {}) => asInternal(req, {}, () => payload.update({ collection: o.recipes as CollectionSlug, id, data: data as never, ...sys, req }))
  for (const r of pending) {
    let claimed: Doc | null = null
    try {
      claimed = await transaction(payload, undefined, async (req) => {
        const fresh = (await payload.findByID({ collection: o.recipes as CollectionSlug, id: r.id, ...sys, joins: false, disableErrors: true, req })) as Doc | null
        if (fresh?.stockAlertStatus !== 'pending') return null
        await mark(r.id, { stockAlertStatus: 'sending' }, req)
        return fresh
      })
    } catch {
      claimed = null
    }
    if (!claimed) continue
    const { status, note } = await deliverStock(payload, o, claimed)
    await mark(r.id, { stockAlertStatus: status, stockAlertNote: note })
    if (status === 'sent') report.sent++
    else if (status === 'failed') report.failed++
    else report.notSent++
  }
  return report
}

async function deliverStock(payload: Payload, o: ResolvedSupplies, recipe: Doc): Promise<{ status: AlertStatus; note: string | null }> {
  if (!(await o.canSend({ payload }))) return { status: 'not-sent', note: 'Email is off here.' }
  const status = await readyStatus(payload, recipe)
  if (!status.state || status.state === 'ok') return { status: 'not-sent', note: 'Back to OK before it was sent.' }
  const scope = o.scopeField ? idOf(recipe[o.scopeField]) : null
  const alertItem = { id: recipe.id, name: String(recipe.name), unit: 'ready', onHand: status.ready, lowStockLevel: status.baseline ?? 0, suggestedReorder: status.toBuild, supplier: null, scope, kind: 'ready-stock' as const }
  const to = [...new Set((Array.isArray(o.recipients) ? o.recipients : await o.recipients({ payload, item: alertItem })).map((a) => a.trim()).filter(Boolean))]
  if (!to.length) return { status: 'not-sent', note: 'No alert addresses are set.' }
  const base = payload.config.serverURL
  const adminURL = base ? `${base}${payload.config.routes.admin}/collections/${o.recipes}/${recipe.id}` : null
  const email = defaultStockEmail({ status, adminURL })
  try {
    if (o.sendEmail) await o.sendEmail({ payload, to, ...email })
    else await payload.sendEmail({ to, subject: email.subject, html: email.html, text: email.text })
    return { status: 'sent', note: null }
  } catch (error) {
    payload.logger.error({ err: error, msg: `kitting: ready-stock email for ${recipe.id} failed` })
    return { status: 'failed', note: String((error as Error)?.message ?? error).slice(0, 200) }
  }
}
