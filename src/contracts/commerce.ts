import type { Payload, PayloadRequest } from 'payload'

import type { ShippingAddress } from './shipping.js'

/**
 * The commerce side of level 3 (planned), as types only, so a shop can be wired to Kitting without
 * Kitting depending on any shop. Payload's `@payloadcms/plugin-ecommerce` gets a built-in adapter;
 * any other shop can implement the same.
 *
 * - A product, or one of its variants, can be backed by a recipe.
 * - The shop asks Kitting how many are ready, to show as the product's availability.
 * - When an order is placed, the shop hands Kitting its lines: Kitting assigns ready units, oldest
 *   first, and queues a build for any it can't.
 */

type ID = string | number

export type OrderLine = { product: ID; variant?: ID | null; quantity: number }

export type PlacedOrder = {
  id: ID
  /** Shown on assigned units and queued builds, for example the order number. */
  reference: string
  lines: OrderLine[]
  /** The host's site, when Kitting runs with `scopeField`. */
  scope?: ID | null
  shipTo?: ShippingAddress
}

export type CommerceSource = {
  /** Shown in the admin, for example "Payload ecommerce". */
  name: string
  /** The recipe behind a product or variant, or null when it isn't kitted (then Kitting ignores the line). */
  recipeFor(line: OrderLine, context: { payload: Payload; req?: Partial<PayloadRequest> }): Promise<ID | null>
}

export type FulfilmentResult = {
  order: ID
  /** Per order line: the units assigned (by external ID) and how many builds were queued. */
  lines: { line: OrderLine; recipe: ID | null; assigned: string[]; queued: number }[]
}

/** What a shop shows as availability: ready units, never a promise about stock still to be built. */
export type Availability = { recipe: ID; ready: number }

/** Group an order's kitted lines by recipe, adding up quantities; lines without a recipe are left out. */
export async function linesByRecipe(order: PlacedOrder, source: CommerceSource, context: { payload: Payload; req?: Partial<PayloadRequest> }) {
  const out = new Map<string, { recipe: ID; quantity: number; lines: OrderLine[] }>()
  for (const line of order.lines) {
    if (!(Number.isInteger(line.quantity) && line.quantity > 0)) continue
    const recipe = await source.recipeFor(line, context)
    if (recipe === null) continue
    const prev = out.get(String(recipe)) ?? { recipe, quantity: 0, lines: [] }
    prev.quantity += line.quantity
    prev.lines.push(line)
    out.set(String(recipe), prev)
  }
  return [...out.values()]
}
