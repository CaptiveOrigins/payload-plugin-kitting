import type { CollectionAfterChangeHook, CollectionConfig, CollectionSlug, Field, Payload, PayloadRequest } from 'payload'

import type { CommerceSource, OrderLine } from './contracts/commerce.js'
import { linesByRecipe } from './contracts/commerce.js'
import { assignUnits, release } from './fulfil.js'
import { asInternal, idOf, INTERNAL, suppliesOf } from './stock.js'
import type { ID, ResolvedSupplies } from './types.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Req = Partial<PayloadRequest>

const sys = { overrideAccess: true, depth: 0 } as const

const productFields = (o: ResolvedSupplies): Field[] => [
  {
    name: 'kittingRecipe',
    type: 'relationship',
    relationTo: o.recipes as CollectionSlug,
    label: 'Built from recipe',
    admin: { position: 'sidebar', description: 'Kitting: orders for this are given ready built units, or a build is queued.' },
  },
  { name: 'kittingReady', type: 'number', label: 'Ready to send', admin: { position: 'sidebar', readOnly: true, description: 'Built and not yet given to an order.' } },
]

const CLOSED = ['cancelled', 'refunded']

/** Payload's ecommerce plugin as a commerce source: a variant's recipe, else its product's. */
export function ecommerceSource(o: ResolvedSupplies): CommerceSource {
  return {
    name: 'Payload ecommerce',
    async recipeFor(line, { payload, req }) {
      for (const [slug, id] of [
        [o.ecommerce.variants, line.variant],
        [o.ecommerce.products, line.product],
      ] as const) {
        if (idOf(id) === null) continue
        const doc = (await payload.findByID({ collection: slug as CollectionSlug, id: idOf(id)!, ...sys, joins: false, disableErrors: true, req })) as Doc | null
        if (doc && idOf(doc.kittingRecipe) !== null) return idOf(doc.kittingRecipe)
      }
      return null
    },
  }
}

/** New order: give each kitted line ready units or a queued build. Cancelled or refunded: give them back. */
const orderHook =
  (o: ResolvedSupplies): CollectionAfterChangeHook =>
  async ({ doc, previousDoc, operation, req }) => {
    if (req.context?.[INTERNAL] || o.ecommerce.skipOrder?.(doc)) return doc
    const reference = o.ecommerce.reference(doc)
    const scope = o.scopeField ? (idOf(doc[o.scopeField]) ?? undefined) : undefined
    const status = String(doc.status ?? '')
    if (CLOSED.includes(status)) {
      if (operation === 'update' && !CLOSED.includes(String(previousDoc?.status ?? ''))) await release(req.payload, { reference, scope, req })
      return doc
    }
    if (operation !== 'create' && status === String(previousDoc?.status ?? '') && JSON.stringify(doc.items) === JSON.stringify(previousDoc?.items)) return doc
    const lines: OrderLine[] = ((doc.items ?? []) as Doc[]).map((i) => ({ product: idOf(i.product)!, variant: idOf(i.variant), quantity: Number(i.quantity ?? 0) }))
    const groups = await linesByRecipe({ id: doc.id, reference, lines, scope: scope ?? null }, ecommerceSource(o), { payload: req.payload, req })
    // Assigning is idempotent per reference, so a re-saved order only adds what's missing.
    for (const g of groups) await assignUnits(req.payload, { id: g.recipe }, g.quantity, { reference, scope, req })
    return doc
  }

/** Add Kitting's fields to the shop's products and variants, and its hook to orders (when enabled). */
export function withEcommerce(o: ResolvedSupplies, collections: CollectionConfig[]): CollectionConfig[] {
  if (!o.ecommerce.enabled) return collections
  return collections.map((c) => {
    if (c.slug === o.ecommerce.products || c.slug === o.ecommerce.variants) return { ...c, fields: [...c.fields, ...productFields(o)] }
    if (c.slug === o.ecommerce.orders) return { ...c, hooks: { ...c.hooks, afterChange: [...(c.hooks?.afterChange ?? []), orderHook(o)] } }
    return c
  })
}

/**
 * Set "Ready to send" (and `inventory`, where the shop counts it) on every product and variant built
 * from a recipe, to that recipe's ready units. Runs inside the caller's transaction.
 */
export async function syncAvailability(payload: Payload, options: { req?: Req } = {}): Promise<{ updated: number }> {
  const o = suppliesOf(payload)
  if (!o.ecommerce.enabled) return { updated: 0 }
  const req = options.req ?? {}
  const ready = new Map<string, number>()
  let updated = 0
  for (const slug of [o.ecommerce.products, o.ecommerce.variants]) {
    const collection = payload.collections[slug as CollectionSlug]
    if (!collection) continue
    const hasInventory = collection.config.flattenedFields.some((f) => f.name === 'inventory')
    const docs = (await payload.find({ collection: slug as CollectionSlug, where: { kittingRecipe: { exists: true } }, ...sys, pagination: false, joins: false, req })).docs as Doc[]
    for (const d of docs) {
      const recipe = String(idOf(d.kittingRecipe))
      if (!ready.has(recipe))
        ready.set(recipe, (await payload.count({ collection: o.units as CollectionSlug, where: { and: [{ recipe: { equals: recipe } }, { status: { equals: 'ready' } }] }, overrideAccess: true, req })).totalDocs)
      const n = ready.get(recipe)!
      if (d.kittingReady === n && (!hasInventory || d.inventory === n)) continue
      await asInternal(req, {}, () => payload.update({ collection: slug as CollectionSlug, id: d.id as ID, data: { kittingReady: n, ...(hasInventory ? { inventory: n } : {}) } as never, ...sys, req }))
      updated++
    }
  }
  return { updated }
}

