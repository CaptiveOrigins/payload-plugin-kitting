import type { Payload, PayloadRequest } from 'payload'

/**
 * Crossing `kitting-shipping` (2026-11-08): the contract between Kitting's box
 * recommendations and a shipping plugin (such as `@extantape/payload-plugin-shipping`).
 * Types only. Each plugin works without the other:
 * - With no provider, Kitting ranks packings by its own cost rules (box cost, postage bands).
 * - A provider never needs Kitting: packed boxes are plain data.
 *
 * Discovery: a shipping plugin registers its provider at `config.custom.shipping.provider`.
 * A host can also pass one to Kitting directly (`shipping: { provider }`), which wins.
 * Kitting asks for rates only; labels, tracking and returns stay with the shipping plugin.
 */

export type LengthUnit = 'cm' | 'in'
export type WeightUnit = 'g' | 'kg' | 'oz' | 'lb'

/** Where a parcel goes or comes from. Postal code and country are enough for most rates. */
export type ShippingAddress = {
  country: string // ISO 3166-1 alpha-2
  postalCode: string
  region?: string
  city?: string
  residential?: boolean
}

/** One box as Kitting would pack it: outside size, packed weight and what's inside. */
export type PackedBox = {
  /** Kitting's id for this box within one request, echoed back on rates. */
  id: string
  /** The box type's name, for people reading a rate. */
  boxType: string
  dimensions: { length: number; width: number; height: number; unit: LengthUnit }
  /** Packed weight: box plus contents. */
  weight: { value: number; unit: WeightUnit }
  contents: { recipe: string; units: number }[]
}

export type RateRequest = {
  boxes: PackedBox[]
  from?: ShippingAddress
  to?: ShippingAddress
  /** The order or batch this is for, for the provider's logs. */
  reference?: string
  /** The host's site, when Kitting runs with `scopeField`. */
  scope?: string | number
}

export type ShippingRate = {
  /** The PackedBox this rate is for; absent for a rate covering every box in the request. */
  boxId?: string
  carrier: string
  service: string
  /** In the currency's major unit, for example 12.4 for $12.40. */
  amount: number
  currency: string
  /** Estimated days in transit, when the carrier gives one. */
  days?: number
  /** The provider's id, so a later label can be bought for this rate. Kitting only passes it on. */
  rateId?: string
}

export type RateResult = {
  rates: ShippingRate[]
  /** ISO time the rates were quoted. */
  quotedAt: string
  /** Why some or all boxes got no rate, in plain words. */
  notes?: string[]
}

export type ShippingProvider = {
  /** Shown next to recommendations, for example "EasyPost". */
  name: string
  quoteRates(request: RateRequest, context: { payload: Payload; req?: Partial<PayloadRequest> }): Promise<RateResult>
}

/**
 * How Kitting uses it: for each candidate packing it asks for rates, picks the cheapest rate per box,
 * and ranks packings by box cost plus postage. If the provider throws, times out or returns no rate for
 * a box, Kitting falls back to its own cost rules for that recommendation and says so ("rates
 * unavailable from EasyPost; ranked by box cost and postage bands").
 */

/** The cheapest rate for each box, by box id. A box with no rate is left out (fall back for it). */
export function cheapestPerBox(result: RateResult, boxes: PackedBox[]): Map<string, ShippingRate> {
  const out = new Map<string, ShippingRate>()
  for (const box of boxes) {
    const options = result.rates.filter((r) => r.boxId === box.id)
    const best = options.sort((a, b) => a.amount - b.amount)[0]
    if (best) out.set(box.id, best)
  }
  return out
}
