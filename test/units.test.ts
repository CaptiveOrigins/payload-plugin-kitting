import { describe, expect, it } from 'vitest'

import { sitesAllowed } from '../src/access.js'
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

describe('plugin set-up', () => {
  it('refuses to replace a host collection with the same slug', async () => {
    const { kittingPlugin } = await import('../src/index.js')
    const config = { collections: [{ slug: 'box-types', fields: [] }] } as never
    expect(() => kittingPlugin()(config)).toThrow(/box-types already exists in this config\. Give Kitting other slugs/)
    expect(() => kittingPlugin({ slugs: { boxes: 'kitting-boxes' } })(config)).not.toThrow()
  })
})

describe('reading an access query as a list of sites (for Restock’s arrivals)', () => {
  const sites = (w: unknown) => {
    const out = sitesAllowed(w, 'tenant')
    return out === null ? null : [...out].sort()
  }
  it('reads the scope field with equals or in, and and/or of those', () => {
    expect(sites({ tenant: { equals: 'site-a' } })).toEqual(['site-a'])
    expect(sites({ tenant: { equals: 7 } })).toEqual(['7'])
    expect(sites({ tenant: { in: ['site-a', 'site-b'] } })).toEqual(['site-a', 'site-b'])
    expect(sites({ tenant: { in: [] } })).toEqual([])
    expect(sites({ and: [{ tenant: { in: ['site-a', 'site-b'] } }, { tenant: { equals: 'site-b' } }] })).toEqual(['site-b'])
    expect(sites({ or: [{ tenant: { equals: 'site-a' } }, { tenant: { in: ['site-c'] } }] })).toEqual(['site-a', 'site-c'])
    // Several keys in one object must all hold.
    expect(sites({ tenant: { in: ['site-a', 'site-b'] }, and: [{ tenant: { equals: 'site-b' } }] })).toEqual(['site-b'])
  })
  it('is null (show nothing) for anything else', () => {
    for (const w of [
      null, undefined, true, 1, 'site-a', {}, { tenant: false }, { tenant: {} }, { and: [] }, { and: [{}] },
      { tenant: { equals: null } }, { tenant: { equals: '' } }, { tenant: { equals: { id: 'site-a' } } }, { tenant: { equals: Number.NaN } },
      { tenant: { in: 'site-a' } }, { tenant: { in: ['site-a', null] } }, { tenant: { in: [{ id: 'site-a' }] } },
      { tenant: { not_equals: 'site-b' } }, { tenant: { not_in: ['site-b'] } }, { tenant: { exists: true } }, { tenant: { like: 'site' } },
      { tenant: { equals: 'site-a', not_equals: 'site-b' } }, { site: { equals: 'site-a' } }, { 'tenant.id': { equals: 'site-a' } },
      { and: [{ tenant: { equals: 'site-a' } }, { active: { equals: true } }] }, { or: [{ tenant: { equals: 'site-a' } }, { owner: { equals: 'u1' } }] },
    ])
      expect(sites(w), JSON.stringify(w)).toBeNull()
    // Without a scope field, no query can be about sites.
    expect(sitesAllowed({ tenant: { equals: 'site-a' } }, undefined)).toBeNull()
  })
})

describe('sitesAllowed edge cases', () => {
  it('shows nothing for an empty list, an empty query or a malformed list, instead of throwing', () => {
    for (const w of [{}, { and: [] }, { or: [] }, { and: 'x' }, { or: [{}] }]) expect(sitesAllowed(w, 'tenant'), JSON.stringify(w)).toBeNull()
    expect([...sitesAllowed({ or: [{ tenant: { equals: 'a' } }, { tenant: { in: ['b'] } }] }, 'tenant')!].sort()).toEqual(['a', 'b'])
  })
})
