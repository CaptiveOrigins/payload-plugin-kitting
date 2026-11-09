import { describe, expect, it } from 'vitest'

import { compareMethods, dailyDemand, fromFirstSale, holt, recommend, weightedStats, zFor } from '../src/stocklevel.js'

const repeat = (pattern: number[], times: number) => Array.from({ length: times }, () => pattern).flat()

describe('the maths, with known values', () => {
  it('z for a service level', () => {
    expect(zFor(0.5)).toBeCloseTo(0, 9)
    expect(zFor(0.95)).toBeCloseTo(1.644854, 5)
    expect(zFor(0.99)).toBeCloseTo(2.326348, 5)
    expect(zFor(0.01)).toBeCloseTo(-2.326348, 5)
    expect(() => zFor(1)).toThrow(RangeError)
  })

  it('weighted mean and deviation', () => {
    expect(weightedStats([4, 0], 0)).toEqual({ mean: 2, sd: 2 })
    // A half-life of one day: yesterday counts half. (4 × 0.5 + 0 × 1) / 1.5.
    expect(weightedStats([4, 0], 1).mean).toBeCloseTo(4 / 3, 9)
    expect(fromFirstSale([0, 0, 3, 0, 1])).toEqual([3, 0, 1])
  })

  it('Holt follows a straight line exactly', () => {
    const line = Array.from({ length: 30 }, (_, i) => i + 1)
    const h = holt(line, 0.3, 0.1)
    expect(h.level).toBeCloseTo(30, 9)
    expect(h.trend).toBeCloseTo(1, 9)
    expect(h.sd).toBeCloseTo(0, 9)
  })

  it('daily demand from dated sales', () => {
    const now = new Date('2026-11-08T15:00:00Z')
    expect(dailyDemand([{ at: '2026-11-08T01:00:00Z' }, { at: '2026-11-06T23:00:00Z', quantity: 3 }, { at: '2026-01-01T00:00:00Z' }], 4, now)).toEqual([0, 3, 0, 1])
  })
})

describe('the five methods', () => {
  const steady = repeat([2], 90)
  const noisy = repeat([4, 0], 45)

  it('statistical: demand over lead time + review, plus z·σ·√(LT+R)', () => {
    // σ = 0: 2 a day × (5 + 2) = 14.
    expect(recommend(steady, { leadTimeDays: 5, reviewDays: 2 }).target).toBe(14)
    // μ 2, σ 2, LT+R 9: 18 + 1.6449 × 2 × 3 = 27.87 → 28.
    const r = recommend(noisy, { leadTimeDays: 5, reviewDays: 4, halfLifeDays: 0 }, 10)
    expect(r).toMatchObject({ method: 'statistical', target: 28, buildNow: 18, fallback: false })
    expect(r.explanation).toBe('About 2 a day over the last 90 days, a 5-day build and a check every 4 days, 95% service → keep 28 ready (18 expected, plus 9.9 safety stock).')
    // 99% service needs more: 18 + 2.3263 × 6 = 31.96 → 32.
    expect(recommend(noisy, { leadTimeDays: 5, reviewDays: 4, halfLifeDays: 0, serviceLevel: 0.99 }).target).toBe(32)
  })

  it('multiplier: average a day × days of cover, capped at the batch size', () => {
    expect(recommend(repeat([3], 60), { method: 'multiplier', coverDays: 10 }).target).toBe(30)
    const capped = recommend(repeat([3], 60), { method: 'multiplier', coverDays: 10, maxBatch: 20 })
    expect([capped.target, capped.figures.capped]).toEqual([20, true])
    expect(capped.explanation).toMatch(/Capped at 20, the most you build at once\.$/)
  })

  it('minmax: build only at the minimum, up to the maximum', () => {
    expect(recommend([], { method: 'minmax', min: 5, max: 20 }, 4)).toMatchObject({ target: 20, buildNow: 16 })
    expect(recommend([], { method: 'minmax', min: 5, max: 20 }, 6)).toMatchObject({ target: 20, buildNow: 0 })
    expect(recommend([], { method: 'minmax', min: 5, manual: 8 })).toMatchObject({ target: 8, fallback: true })
  })

  it('trend: the expected demand follows the trend', () => {
    const line = Array.from({ length: 30 }, (_, i) => i + 1)
    // Level 30, rising 1 a day, LT+R 3: 31 + 32 + 33 = 96, no error, so no safety stock.
    const r = recommend(line, { method: 'trend', leadTimeDays: 2, reviewDays: 1 })
    expect(r.target).toBe(96)
    expect(r.explanation).toMatch(/^About 30 a day now and rising by about 1 a day/)
  })

  it('manual, and the fallback when there is too little history', () => {
    expect(recommend(steady, { method: 'manual', manual: 12 })).toMatchObject({ target: 12, fallback: false, explanation: 'A fixed number you set: keep 12 ready.' })
    const young = [...repeat([0], 80), ...repeat([2], 10)]
    const r = recommend(young, { manual: 12 })
    expect(r).toMatchObject({ target: 12, fallback: true })
    expect(r.explanation).toBe('Not enough history yet: 10 days since the first sale (needs 28). Using the fixed number: keep 12 ready.')
    expect(recommend(repeat([0], 90), {})).toMatchObject({ target: null, explanation: 'No sales in the history yet. Set a fixed number to keep ready until there is.' })
  })

  it('compares every method, the chosen one first', () => {
    const all = compareMethods(noisy, { method: 'multiplier', coverDays: 7, min: 5, max: 30, manual: 10, halfLifeDays: 0 }, 6)
    expect(all.map((r) => [r.method, r.target])).toEqual([
      ['multiplier', 14],
      ['statistical', 21], // 2 × 6 + 1.6449 × 2 × √6 = 20.06 → 21
      ['minmax', 30],
      ['trend', expect.any(Number)],
      ['manual', 10],
    ])
  })
})
