import { describe, expect, it } from 'vitest'

import { allocate, describeUse, isExpired, shrinkagePercent } from '../src/stock.js'
import { conversionFactor, normalizeUnit, unitsFor } from '../src/units.js'

describe('units', () => {
  it('converts within a kind and refuses across kinds', () => {
    expect(conversionFactor('kg', 'g')).toBe(1000)
    expect(conversionFactor('ml', 'µl')).toBe(1000)
    expect(conversionFactor('litres', 'ml')).toBe(1000)
    expect(conversionFactor('uL', 'µl')).toBe(1)
    expect(conversionFactor('g', 'kg')).toBe(0.001)
    expect(conversionFactor('kg', 'ml')).toBeNull()
    expect(conversionFactor('roll', 'each')).toBeNull()
    expect(conversionFactor('', 'g')).toBe(1)
  })

  it('uses an item’s own packs', () => {
    const packs = [{ name: '1 kg bag', size: 1000 }, { name: 'Box of 100', size: 100 }]
    expect(conversionFactor('1 kg bag', 'g', packs)).toBe(1000)
    expect(conversionFactor('box of 100', 'each', packs)).toBe(100)
    expect(unitsFor('g', packs)).toEqual(['g', 'mg', 'kg', 'oz', 'lb', '1 kg bag', 'Box of 100'])
    expect(normalizeUnit(' Grams ')).toBe('g')
  })
})

describe('shrinkage allowance', () => {
  const o = { shrinkage: { enabled: true, defaultPercent: 2 } }
  it('takes the most specific: line, recipe, item, then the default', () => {
    expect(shrinkagePercent(o, {})).toBe(2)
    expect(shrinkagePercent(o, { shrinkagePercent: 5 })).toBe(5)
    expect(shrinkagePercent(o, { shrinkagePercent: 5 }, { shrinkagePercent: 8 })).toBe(8)
    expect(shrinkagePercent(o, { shrinkagePercent: 5 }, { shrinkagePercent: 8 }, { shrinkagePercent: 0 })).toBe(0)
    expect(shrinkagePercent({ shrinkage: { enabled: false, defaultPercent: 2 } }, { shrinkagePercent: 5 })).toBe(0)
  })
  it('reads plainly', () => {
    expect(describeUse({ quantity: 18, unit: 'g', name: 'beans', percent: 5, per: 'drink' })).toBe('18 g of beans per drink + 5% shrinkage allowance')
    expect(describeUse({ quantity: 2, unit: 'each', name: 'swabs', percent: 0 })).toBe('2 × swabs')
  })
})

describe('lots', () => {
  const now = new Date('2026-11-08T12:00:00Z')
  it('treats the whole use-by day as usable', () => {
    expect(isExpired('2026-11-08T00:00:00.000Z', now)).toBe(false)
    expect(isExpired('2026-11-07T00:00:00.000Z', now)).toBe(true)
    expect(isExpired(null, now)).toBe(false)
  })
  it('takes the first to expire first, skips expired lots, and leaves a shortage without a lot', () => {
    const item = { trackLots: true, onHand: 30 }
    const lots = [
      { id: 'late', onHand: 10, expiresOn: '2027-01-01T00:00:00.000Z' },
      { id: 'gone', onHand: 5, expiresOn: '2026-11-01T00:00:00.000Z' },
      { id: 'soon', onHand: 4, expiresOn: '2026-11-20T00:00:00.000Z' },
      { id: 'undated', onHand: 6 },
    ].sort((a, b) => (a.expiresOn ? Date.parse(a.expiresOn) : Infinity) - (b.expiresOn ? Date.parse(b.expiresOn) : Infinity))
    expect(allocate(item, lots, 12, now)).toEqual([
      { lot: 'soon', quantity: 4 },
      { lot: 'late', quantity: 8 },
    ])
    // 4 + 10 + 6 usable in lots, then 5 unlotted (30 − 25 in lots), then short.
    expect(allocate(item, lots, 27, now)).toEqual([
      { lot: 'soon', quantity: 4 },
      { lot: 'late', quantity: 10 },
      { lot: 'undated', quantity: 6 },
      { lot: null, quantity: 7 },
    ])
    expect(allocate({ onHand: 3 }, [], 5, now)).toEqual([{ lot: null, quantity: 5 }])
  })
})
