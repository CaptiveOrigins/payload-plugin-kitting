import type { Payload } from 'payload'
import { describe, expect, it } from 'vitest'

import { cheapestPerBox, kittingPlugin, linesByRecipe, ratesFromShipping, type CommerceSource, type PackedBox, type ShippingLabelAddress, type ShippingProvider, type ShippingQuoteFn } from '../src/index.js'

// Test doubles: a made-up carrier and a made-up shop, to show the contracts work without either plugin.
const payload = {} as Payload

const boxes: PackedBox[] = [
  { id: 'b1', boxType: 'Small mailer', dimensions: { length: 25, width: 18, height: 5, unit: 'cm' }, weight: { value: 420, unit: 'g' }, contents: [{ recipe: 'sample-kit', units: 4 }] },
  { id: 'b2', boxType: 'Small mailer', dimensions: { length: 25, width: 18, height: 5, unit: 'cm' }, weight: { value: 110, unit: 'g' }, contents: [{ recipe: 'sample-kit', units: 1 }] },
]

const fakeCarrier: ShippingProvider = {
  name: 'Example Post',
  async quoteRates(request) {
    return {
      quotedAt: '2026-11-08T12:00:00.000Z',
      rates: request.boxes.flatMap((b) => [
        { boxId: b.id, carrier: 'Example Post', service: 'Ground', amount: b.weight.value > 250 ? 9.1 : 5.2, currency: 'USD', days: 4 },
        { boxId: b.id, carrier: 'Example Post', service: 'Express', amount: b.weight.value > 250 ? 21 : 14, currency: 'USD', days: 1 },
      ]),
    }
  },
}

const fakeShop: CommerceSource = {
  name: 'Example shop',
  async recipeFor(line) {
    return line.product === 'kit-product' ? 'sample-kit' : line.product === 'kit-bundle' ? 'sample-kit' : null
  },
}

describe('shipping contract', () => {
  it('a provider quotes per box, and the cheapest per box is picked', async () => {
    const result = await fakeCarrier.quoteRates({ boxes, to: { country: 'US', postalCode: '72201' } }, { payload })
    const best = cheapestPerBox(result, [...boxes, { ...boxes[0]!, id: 'unrated' }])
    expect([...best.entries()].map(([id, r]) => [id, r.service, r.amount])).toEqual([
      ['b1', 'Ground', 9.1],
      ['b2', 'Ground', 5.2],
    ])
  })
})

describe('Shipping adapter (made-up quote with Shipping’s shape)', () => {
  const warehouse: ShippingLabelAddress = { name: 'Example Warehouse', company: null, street1: '1 Example Way', street2: null, city: 'Springfield', state: 'IL', zip: '62701', country: 'US', phone: null }
  const calls: Parameters<ShippingQuoteFn>[1][] = []
  // Like Shipping's `quote(payload, input, req)`: one parcel, one rate, in cents.
  const quote: ShippingQuoteFn = async (_payload, input) => {
    calls.push(input)
    if (input.parcel.weightOz > 100) throw Object.assign(new Error('made-up: too heavy'), { name: 'CarrierError' })
    const cents = input.parcel.weightOz > 8 ? 910 : 520
    return { shipmentId: `shp_${calls.length}`, rate: { id: `rate_${calls.length}`, carrier: 'USPS', service: 'GroundAdvantage', rate: (cents / 100).toFixed(2), fake: true }, rateCents: cents, mode: 'test', fake: true }
  }
  const to = { country: 'US', postalCode: '72201', city: 'Little Rock', region: 'AR' }

  it('quotes each distinct parcel once, in inches and ounces, and gives Kitting rates per box', async () => {
    calls.length = 0
    const provider = ratesFromShipping({ quote, from: warehouse })
    const result = await provider.quoteRates({ boxes: [...boxes, { ...boxes[0]!, id: 'b3' }], to, reference: 'Order 1' }, { payload })
    expect(calls).toHaveLength(2) // b1 and b3 are the same parcel
    expect(calls[0]).toMatchObject({ from: warehouse, to: { zip: '72201', city: 'Little Rock', state: 'AR', country: 'US' }, reference: 'Order 1', parcel: { weightOz: 14.9, lengthIn: 9.9, widthIn: 7.1, heightIn: 2 } })
    expect(result.rates.map((r) => [r.boxId, r.carrier, r.service, r.amount, r.currency])).toEqual([
      ['b1', 'USPS', 'GroundAdvantage', 9.1, 'USD'],
      ['b3', 'USPS', 'GroundAdvantage', 9.1, 'USD'],
      ['b2', 'USPS', 'GroundAdvantage', 5.2, 'USD'],
    ])
    expect(result.notes).toEqual(['these are made-up test rates.'])
  })

  it('leaves a box it couldn’t quote unrated, says why, and passes the error on when nothing could be quoted', async () => {
    const heavy: PackedBox = { ...boxes[0]!, id: 'h', weight: { value: 5, unit: 'kg' } }
    const provider = ratesFromShipping({ quote, from: warehouse })
    const some = await provider.quoteRates({ boxes: [boxes[0]!, heavy], to }, { payload })
    expect(some.rates.map((r) => r.boxId)).toEqual(['b1'])
    expect(some.notes).toContain('1 of 2 box sizes couldn’t be quoted (CarrierError).')
    await expect(provider.quoteRates({ boxes: [heavy], to }, { payload })).rejects.toThrow('made-up: too heavy')
  })

  it('gives no rates, with the reason, for no destination, outside the US, or nowhere to ship from', async () => {
    calls.length = 0
    const noFrom = ratesFromShipping({ quote })
    expect((await noFrom.quoteRates({ boxes, to }, { payload })).notes).toEqual(['no US address to ship from. Pass `from` to ratesFromShipping.'])
    const provider = ratesFromShipping({ quote, from: warehouse })
    expect((await provider.quoteRates({ boxes }, { payload })).notes).toEqual(['no destination, so nothing to quote.'])
    expect((await provider.quoteRates({ boxes, to: { country: 'CA', postalCode: 'K1A 0B1' } }, { payload })).notes).toEqual(['it quotes US addresses only, and this one is in CA.'])
    expect(calls).toHaveLength(0)
  })
})

describe('rate provider at startup', () => {
  it('refuses a provider without quoteRates, pointing to the adapter, and takes the adapter', () => {
    const carrierProvider = { name: 'EasyPost', mode: 'test', quote: async () => ({}) } // Shipping's carrier provider shape
    expect(() => kittingPlugin({ shipping: { provider: carrierProvider as never } })({} as never)).toThrow(
      /`shipping.provider` has no `quoteRates` function \(it has `quote`, like the Shipping plugin’s carrier provider\)\. To use the Shipping plugin’s rates, pass `shipping: \{ provider: ratesFromShipping\(\{ quote \}\) \}`/,
    )
    expect(() => kittingPlugin({ shipping: { provider: { name: 'Nothing' } as never } })({} as never)).toThrow(/has no `quoteRates` function\. To use/)
    expect(() => kittingPlugin({ shipping: { provider: ratesFromShipping({ quote: async () => Promise.reject(new Error('unused')) }) } })({} as never)).not.toThrow()
    expect(() => ratesFromShipping({} as never)).toThrow(/needs Shipping’s `quote` function/)
  })
})

describe('commerce contract', () => {
  it('groups an order’s kitted lines by recipe and leaves the rest out', async () => {
    const grouped = await linesByRecipe(
      {
        id: 'o1',
        reference: 'Order 1001',
        lines: [
          { product: 'kit-product', quantity: 2 },
          { product: 't-shirt', quantity: 1 },
          { product: 'kit-bundle', quantity: 5 },
          { product: 'kit-product', quantity: 0 },
        ],
      },
      fakeShop,
      { payload },
    )
    expect(grouped.map((g) => [g.recipe, g.quantity, g.lines.length])).toEqual([['sample-kit', 7, 2]])
  })
})

describe('packing (pure)', () => {
  const box = (id: string, capacity: number, cost = 1) => ({ id, name: id, capacity, cost, emptyWeight: 0, dimensions: null })
  it('packs into one box type, or one type plus one box for the rest', async () => {
    const { packings, postageFor } = await import('../src/boxes.js')
    const shapes = packings(9, [box('A', 4), box('B', 1)]).map((p) => p.map((x) => `${String(x.box.id)}${x.units}`).join(' '))
    expect(shapes.sort()).toEqual(['A4 A4 A1', 'A4 A4 B1', 'B1 B1 B1 B1 B1 B1 B1 B1 B1'].sort())
    expect(postageFor(120, [{ upToGrams: 150, cost: 4 }, { upToGrams: 500, cost: 7 }])).toBe(4)
    expect(postageFor(600, [{ upToGrams: 150, cost: 4 }, { upToGrams: 500, cost: 7 }])).toBeNull()
    expect(postageFor(null, [{ upToGrams: 150, cost: 4 }])).toBeNull()
  })
})
