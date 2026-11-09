import type { Payload } from 'payload'
import { describe, expect, it } from 'vitest'

import { cheapestPerBox, linesByRecipe, type CommerceSource, type PackedBox, type ShippingProvider } from '../src/index.js'

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
