import type { Payload, PayloadRequest } from 'payload'

import type { PackedBox, ShippingAddress, ShippingProvider, ShippingRate } from './contracts/shipping.js'

/**
 * An optional adapter for the Shipping plugin (`@extantape/payload-plugin-shipping`), without importing it.
 * The types below copy the shape of Shipping's `quote(payload, input, req)`, so its function can be passed as it is:
 *
 *   import { quote } from '@extantape/payload-plugin-shipping'
 *   kittingPlugin({ shipping: { provider: ratesFromShipping({ quote, from: warehouse }) } })
 *
 * Going through `quote` keeps Shipping's own checks (its go-ahead hook, test or production mode) in front of
 * every call. Kitting never calls the carrier provider directly.
 */

/** A US mailing address as Shipping takes it (EasyPost's shape). */
export type ShippingLabelAddress = { name: string; company: string | null; street1: string; street2: string | null; city: string; state: string; zip: string; country: 'US'; phone: string | null }

/** Shipping's `quote` function: one parcel, one rate (Ground Advantage first, else the cheapest it allows). */
export type ShippingQuoteFn = (
  payload: Payload,
  input: { from: ShippingLabelAddress; to: ShippingLabelAddress; parcel: { weightOz: number; lengthIn?: number | null; widthIn?: number | null; heightIn?: number | null }; reference: string },
  req?: Partial<PayloadRequest>,
) => Promise<{ shipmentId: string; rate: { id: string; carrier: string; service: string; rate: string; fake?: boolean }; rateCents: number; mode: 'test' | 'production'; fake?: boolean }>

export type RatesFromShippingOptions = {
  /** Shipping's `quote`, as it is. */
  quote: ShippingQuoteFn
  /** Where parcels ship from. Without it, the request's `from` is used, and without that there are no rates. */
  from?: ShippingLabelAddress
  /** Shown next to suggestions. Default "Shipping". */
  name?: string
}

const OZ_PER: Record<PackedBox['weight']['unit'], number> = { g: 1 / 28.349523125, kg: 1000 / 28.349523125, oz: 1, lb: 16 }
const IN_PER: Record<PackedBox['dimensions']['unit'], number> = { cm: 1 / 2.54, in: 1 }
/** Rounded up to a tenth, so a parcel is never quoted lighter or smaller than it is. */
const up = (n: number) => Math.ceil(Math.round(n * 1e6) / 1e5) / 10

/** Kitting knows a destination by postal code (and city and region when given): Shipping rates by those. */
const asLabelAddress = (a: ShippingAddress): ShippingLabelAddress => ({
  name: '',
  company: null,
  street1: '',
  street2: null,
  city: a.city ?? '',
  state: a.region ?? '',
  zip: a.postalCode,
  country: 'US',
  phone: null,
})

/**
 * Wraps Shipping's `quote` as a Kitting rate provider (`quoteRates`). It asks for one quote per distinct parcel,
 * in inches and ounces. A quote that fails leaves that box unrated, with a note; if every quote fails, the error
 * is passed on, so Kitting falls back to your postage rates and marks the suggestion. Shipping takes US
 * addresses only: any other destination gets no rates, and says why.
 */
export function ratesFromShipping(options: RatesFromShippingOptions): ShippingProvider {
  if (typeof options?.quote !== 'function') throw new Error('Kitting: ratesFromShipping needs Shipping’s `quote` function, for example `ratesFromShipping({ quote })`.')
  const name = options.name ?? 'Shipping'
  return {
    name,
    async quoteRates(request, { payload, req }) {
      const quotedAt = new Date().toISOString()
      if (!request.to) return { rates: [], quotedAt, notes: ['no destination, so nothing to quote.'] }
      if (request.to.country.toUpperCase() !== 'US') return { rates: [], quotedAt, notes: [`it quotes US addresses only, and this one is in ${request.to.country}.`] }
      const from = options.from ?? (request.from?.country.toUpperCase() === 'US' ? asLabelAddress(request.from) : undefined)
      if (!from) return { rates: [], quotedAt, notes: ['no US address to ship from. Pass `from` to ratesFromShipping.'] }
      const to = asLabelAddress(request.to)
      const reference = request.reference ?? 'Kitting box suggestion'

      // Boxes of the same size and weight cost the same: one quote each.
      const parcelOf = (b: PackedBox) => ({
        weightOz: up(b.weight.value * OZ_PER[b.weight.unit]),
        lengthIn: up(b.dimensions.length * IN_PER[b.dimensions.unit]),
        widthIn: up(b.dimensions.width * IN_PER[b.dimensions.unit]),
        heightIn: up(b.dimensions.height * IN_PER[b.dimensions.unit]),
      })
      const byParcel = new Map<string, { parcel: ReturnType<typeof parcelOf>; boxes: PackedBox[] }>()
      for (const b of request.boxes) {
        const parcel = parcelOf(b)
        const key = JSON.stringify(parcel)
        const group = byParcel.get(key) ?? { parcel, boxes: [] }
        group.boxes.push(b)
        byParcel.set(key, group)
      }
      const groups = [...byParcel.values()]
      const settled = await Promise.allSettled(groups.map((g) => options.quote(payload, { from, to, parcel: g.parcel, reference }, req)))
      const failed = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected')
      if (groups.length && failed.length === groups.length) throw failed[0]!.reason

      const rates: ShippingRate[] = []
      const notes: string[] = []
      let fake = false
      settled.forEach((s, i) => {
        if (s.status !== 'fulfilled') return
        const q = s.value
        fake ||= Boolean(q.fake || q.rate.fake)
        for (const b of groups[i]!.boxes) rates.push({ boxId: b.id, carrier: q.rate.carrier, service: q.rate.service, amount: q.rateCents / 100, currency: 'USD', rateId: q.rate.id })
      })
      if (failed.length) {
        const names = [...new Set(failed.map((f) => (f.reason instanceof Error ? f.reason.name : 'Error')))]
        notes.push(`${failed.length} of ${groups.length} box sizes couldn’t be quoted (${names.join(', ')}).`)
      }
      if (fake) notes.push('these are made-up test rates.')
      return { rates, quotedAt, notes }
    },
  }
}
