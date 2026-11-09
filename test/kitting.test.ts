import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Access, type CollectionConfig, type Field, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { applyRecipe, assignUnits, buildUnits, recommendReadyStock, release, shipUnits, swapUnit, kittingPlugin, KittingError, voidUnit, sendPendingAlerts, stockReport, suggestShrinkagePercent, writeOffExpired } from '../src/index.js'

// Made-up data throughout: example.com addresses, invented supplies and sites.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let payload: Payload
let mongo: MongoMemoryReplSet
const mail: { to: string[]; subject: string; text: string }[] = []
const onBuilt: string[] = []
let refuseBuild = ''
let emailOn = true

const ids = (v: unknown) => ((v as unknown[]) ?? []).map((t) => (t && typeof t === 'object' ? String((t as Doc).id) : String(t)))
/** Site staff manage their own sites; viewers only read; admins everything. */
const siteAccess =
  (roles: string[]): Access =>
  ({ req }) => {
    const u = req.user as Doc | null
    if (!u) return false
    if (u.role === 'admin') return true
    if (!roles.includes(u.role)) return false
    return { tenant: { in: ids(u.tenants) } }
  }
const tenantField: Field = { name: 'tenant', type: 'relationship', relationTo: 'tenants', required: true }
const withTenant = (c: CollectionConfig): CollectionConfig => ({ ...c, fields: [tenantField, ...c.fields] })

let siteA: Doc, siteB: Doc
let staffA: Doc, viewerA: Doc, staffB: Doc
const as = (u: Doc) => ({ user: { ...u, collection: 'users' }, overrideAccess: false })

const create = (collection: string, data: Doc, extra: Doc = {}) => payload.create({ collection: collection as never, data: data as never, ...extra }) as Promise<Doc>
const get = (collection: string, id: unknown) => payload.findByID({ collection: collection as never, id: id as string, depth: 0 }) as Promise<Doc>
const movementsOf = async (item: Doc) =>
  (await payload.find({ collection: 'supply-movements' as never, where: { item: { equals: item.id } }, sort: 'createdAt', pagination: false, depth: 0 })).docs as Doc[]
const sum = (ms: Doc[]) => ms.reduce((t, m) => Math.round((t + m.change) * 1e6) / 1e6, 0)

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      serverURL: 'https://shop.example.com',
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('supplies'), ensureIndexes: true }),
      collections: [
        { slug: 'tenants', fields: [{ name: 'name', type: 'text' }] },
        { slug: 'users', auth: true, fields: [{ name: 'role', type: 'text' }, { name: 'tenants', type: 'relationship', relationTo: 'tenants', hasMany: true }] },
      ],
      admin: { user: 'users' },
      plugins: [
        kittingPlugin({
          scopeField: 'tenant',
          access: { manage: siteAccess(['staff']), read: siteAccess(['staff', 'viewer']) },
          alerts: {
            recipients: ({ item }) => [`stock-${String(item.scope)}@example.com`],
            canSend: () => emailOn,
            sendEmail: async ({ to, subject, text }) => void mail.push({ to, subject, text }),
          },
          overrides: { items: withTenant, suppliers: withTenant, movements: withTenant, recipes: withTenant, lots: withTenant, units: withTenant, requests: withTenant, boxes: withTenant, postage: withTenant },
          units: {
            onBuild: ({ unit }) => {
              if (unit.externalId === refuseBuild) throw new Error('the host said no')
              onBuilt.push(unit.externalId)
            },
          },
        }),
      ],
    }),
  })
  siteA = await create('tenants', { name: 'Site A' })
  siteB = await create('tenants', { name: 'Site B' })
  const user = (email: string, role: string, tenants: Doc[]) => create('users', { email, password: 'a-long-test-password', role, tenants: tenants.map((t) => t.id) })
  staffA = await user('staff-a@example.com', 'staff', [siteA])
  viewerA = await user('viewer-a@example.com', 'viewer', [siteA])
  staffB = await user('staff-b@example.com', 'staff', [siteB])
}, 180_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

beforeEach(() => {
  mail.length = 0
  emailOn = true
})

/** A placeholder recipe like the one a host would use: two swabs and a tube per thing made. */
async function setup(site: Doc, onHand: { swab: number; tube: number }, levels: { swab?: number; tube?: number } = {}) {
  const supplier = await create('suppliers', { tenant: site.id, name: 'Example Lab Supply', email: 'orders@example.com' })
  const swab = await create('supply-items', { tenant: site.id, name: 'Swab', unit: 'each', supplier: supplier.id, openingStock: onHand.swab, lowStockLevel: levels.swab, reorderQuantity: 100 })
  const tube = await create('supply-items', { tenant: site.id, name: 'Tube', unit: 'each', openingStock: onHand.tube, lowStockLevel: levels.tube })
  const key = `kit-${Math.random().toString(36).slice(2, 8)}`
  const recipe = await create('supply-recipes', {
    tenant: site.id,
    name: 'Placeholder kit',
    key,
    lines: [
      { item: swab.id, quantity: 1 },
      { item: tube.id, quantity: 1 },
      { item: swab.id, quantity: 1, note: 'a spare' },
    ],
  })
  return { supplier, swab, tube, recipe, key }
}

describe('movements', () => {
  it('keeps on hand equal to the sum of an append-only log, and records who', async () => {
    const { swab } = await setup(siteA, { swab: 40, tube: 0 })
    expect((await get('supply-items', swab.id)).onHand).toBe(40)
    await create('supply-movements', { item: swab.id, kind: 'received', quantity: 25, reference: 'PO-1' }, as(staffA))
    await create('supply-movements', { item: swab.id, kind: 'used', quantity: 5 }, as(staffA))
    await create('supply-movements', { item: swab.id, kind: 'adjusted', quantity: -2.5, reason: 'recount' }, as(staffA))
    const log = await movementsOf(swab)
    expect(log.map((m) => [m.kind, m.change, m.onHandAfter])).toEqual([
      ['adjusted', 40, 40],
      ['received', 25, 65],
      ['used', -5, 60],
      ['adjusted', -2.5, 57.5],
    ])
    expect(log[1]!.by).toBe(staffA.id)
    expect(log[1]!.tenant).toBe(siteA.id)
    const item = await get('supply-items', swab.id)
    expect(item.onHand).toBe(57.5)
    expect(item.onHand).toBe(sum(log))
  })

  it('refuses to edit or delete a movement, even with access overridden', async () => {
    const { swab } = await setup(siteA, { swab: 10, tube: 0 })
    const [m] = await movementsOf(swab)
    await expect(payload.update({ collection: 'supply-movements' as never, id: m!.id, data: { quantity: 99 } as never, ...as(staffA) })).rejects.toThrow()
    await expect(payload.update({ collection: 'supply-movements' as never, id: m!.id, data: { quantity: 99 } as never })).rejects.toThrow(/can’t be changed/)
    await expect(payload.delete({ collection: 'supply-movements' as never, id: m!.id })).rejects.toThrow(/can’t be deleted/)
    await expect(payload.delete({ collection: 'supply-items' as never, id: swab.id })).rejects.toThrow(/stock history/)
    expect(await movementsOf(swab)).toHaveLength(1)
  })

  it('never lets on hand be set by hand', async () => {
    const { swab } = await setup(siteA, { swab: 10, tube: 0 })
    await payload.update({ collection: 'supply-items' as never, id: swab.id, data: { onHand: 999, name: 'Swab (sterile)' } as never })
    const item = await get('supply-items', swab.id)
    expect(item.onHand).toBe(10)
    expect(item.name).toBe('Swab (sterile)')
  })

  it('refuses a movement that would go below zero, and checks the quantity', async () => {
    const { swab } = await setup(siteA, { swab: 3, tube: 0 })
    await expect(create('supply-movements', { item: swab.id, kind: 'used', quantity: 4 }, as(staffA))).rejects.toThrow(/Not enough Swab/)
    await expect(create('supply-movements', { item: swab.id, kind: 'used', quantity: -1 }, as(staffA))).rejects.toThrow(/more than zero/)
    await expect(create('supply-movements', { item: swab.id, kind: 'adjusted', quantity: 0 }, as(staffA))).rejects.toThrow(/can’t be zero/)
    expect((await get('supply-items', swab.id)).onHand).toBe(3)
  })
})

describe('recipes', () => {
  it('uses every line × count in one go, merging repeated items', async () => {
    const { swab, tube, recipe, key } = await setup(siteA, { swab: 200, tube: 60 })
    const result = await applyRecipe(payload, { key }, 50, { scope: siteA.id, reference: 'Lot 000123', user: { id: staffA.id } })
    expect(result.recipe.id).toBe(recipe.id)
    expect(result.shortages).toEqual([])
    expect(result.movements.map((m) => [String(m.item), m.change, m.onHandAfter]).sort()).toEqual(
      [
        [String(swab.id), -100, 100],
        [String(tube.id), -50, 10],
      ].sort(),
    )
    const used = (await movementsOf(swab)).at(-1)!
    expect(used).toMatchObject({ kind: 'used', reference: 'Lot 000123', recipe: recipe.id, count: 50, by: staffA.id, tenant: siteA.id })
    expect((await get('supply-items', tube.id)).onHand).toBe(10)
  })

  it('refuses when anything would go negative, naming every shortage, and writes nothing', async () => {
    const { swab, tube, key } = await setup(siteA, { swab: 10, tube: 3 })
    const error = await applyRecipe(payload, { key }, 5, { scope: siteA.id }).catch((e) => e)
    expect(error).toBeInstanceOf(KittingError)
    expect(error.code).toBe('notEnoughStock')
    expect(error.shortages.map((s: Doc) => [s.name, s.onHand, s.needed])).toEqual([['Tube', 3, 5]])
    expect(error.message).toMatch(/Tube has 3 each, needs 5 each/)
    expect((await get('supply-items', swab.id)).onHand).toBe(10)
    expect(await movementsOf(swab)).toHaveLength(1) // just the opening stock
  })

  it('goes below zero and reports it when set to warn', async () => {
    const { tube, key } = await setup(siteA, { swab: 10, tube: 3 })
    const result = await applyRecipe(payload, { key }, 5, { scope: siteA.id, negativeStock: 'warn' })
    expect(result.shortages).toEqual([expect.objectContaining({ name: 'Tube', short: 2 })])
    expect((await get('supply-items', tube.id)).onHand).toBe(-2)
  })

  it('rolls back with the caller’s transaction', async () => {
    const { swab, key } = await setup(siteA, { swab: 10, tube: 10 })
    const transactionID = (await payload.db.beginTransaction())!
    await applyRecipe(payload, { key }, 2, { scope: siteA.id, req: { transactionID } })
    await payload.db.rollbackTransaction(transactionID)
    expect((await get('supply-items', swab.id)).onHand).toBe(10)
    expect(await movementsOf(swab)).toHaveLength(1)
  })

  it('refuses bad counts, unknown keys, switched-off recipes and a key without a site', async () => {
    const { recipe, key } = await setup(siteA, { swab: 10, tube: 10 })
    await expect(applyRecipe(payload, { key }, 0, { scope: siteA.id })).rejects.toThrow(/whole number/)
    await expect(applyRecipe(payload, { key }, 1.5, { scope: siteA.id })).rejects.toThrow(/whole number/)
    await expect(applyRecipe(payload, { key: 'no-such-thing' }, 1, { scope: siteA.id })).rejects.toThrow(/No recipe/)
    await expect(applyRecipe(payload, { key }, 1)).rejects.toThrow(/Say which tenant/)
    await payload.update({ collection: 'supply-recipes' as never, id: recipe.id, data: { active: false } as never })
    await expect(applyRecipe(payload, { id: recipe.id }, 1)).rejects.toThrow(/switched off/)
  })
})

describe('low-stock email', () => {
  it('fires once when stock crosses below the level, not again until it recovers', async () => {
    const { swab, key } = await setup(siteA, { swab: 12, tube: 100 }, { swab: 10 })
    expect(mail).toHaveLength(0)
    await applyRecipe(payload, { key }, 1, { scope: siteA.id }) // 12 → 10: at the level, not below
    expect(mail).toHaveLength(0)
    await applyRecipe(payload, { key }, 1, { scope: siteA.id }) // 10 → 8: below
    expect(mail).toHaveLength(1)
    expect(mail[0]!.to).toEqual([`stock-${siteA.id}@example.com`])
    expect(mail[0]!.subject).toBe('Low stock: Swab')
    expect(mail[0]!.text).toMatch(/On hand: 8 each\. Level: 10 each\./)
    expect(mail[0]!.text).toMatch(/Suggested reorder: 100 each from Example Lab Supply/)
    expect(mail[0]!.text).toContain(`https://shop.example.com/admin/collections/supply-items/${swab.id}`)
    await applyRecipe(payload, { key }, 1, { scope: siteA.id }) // 8 → 6: still below, no repeat
    await create('supply-movements', { item: swab.id, kind: 'used', quantity: 1 }, as(staffA))
    expect(mail).toHaveLength(1)
    let item = await get('supply-items', swab.id)
    expect(item).toMatchObject({ alertStatus: 'sent' })
    expect(item.belowLevelSince).toBeTruthy()
    await create('supply-movements', { item: swab.id, kind: 'received', quantity: 50 }, as(staffA)) // back above
    item = await get('supply-items', swab.id)
    expect(item).toMatchObject({ alertStatus: null, belowLevelSince: null })
    await create('supply-movements', { item: swab.id, kind: 'used', quantity: 50 }, as(staffA)) // below again: a new alert
    expect(mail).toHaveLength(2)
  })

  it('sends a pending alert exactly once when two senders race', async () => {
    const { swab, key } = await setup(siteA, { swab: 11, tube: 100 }, { swab: 10 })
    const transactionID = (await payload.db.beginTransaction())!
    await applyRecipe(payload, { key }, 1, { scope: siteA.id, req: { transactionID } }) // joined: left pending
    await payload.db.commitTransaction(transactionID)
    expect(mail).toHaveLength(0)
    expect((await get('supply-items', swab.id)).alertStatus).toBe('pending')
    const reports = await Promise.all([sendPendingAlerts(payload), sendPendingAlerts(payload), sendPendingAlerts(payload)])
    expect(mail).toHaveLength(1)
    expect(reports.reduce((t, r) => t + r.sent, 0)).toBe(1)
    expect((await get('supply-items', swab.id)).alertStatus).toBe('sent')
  })

  it('records the alert without sending when the host has email off', async () => {
    const { swab, key } = await setup(siteA, { swab: 10, tube: 100 }, { swab: 10 })
    emailOn = false
    await applyRecipe(payload, { key }, 1, { scope: siteA.id })
    expect(mail).toHaveLength(0)
    expect(await get('supply-items', swab.id)).toMatchObject({ alertStatus: 'not-sent', alertNote: 'Email is off here.' })
    emailOn = true
    await applyRecipe(payload, { key }, 1, { scope: siteA.id }) // still below: no catch-up email
    expect(mail).toHaveLength(0)
  })

  it('alerts when the level is raised above what is on hand', async () => {
    const { tube } = await setup(siteA, { swab: 10, tube: 5 })
    await payload.update({ collection: 'supply-items' as never, id: tube.id, data: { lowStockLevel: 6 } as never, ...as(staffA) })
    expect(mail.map((m) => m.subject)).toEqual(['Low stock: Tube'])
  })

  it('lists what is below level with a suggested reorder', async () => {
    const { tube } = await setup(siteB, { swab: 10, tube: 2 }, { tube: 5 })
    const { below } = await stockReport(payload, { user: { ...staffB, collection: 'users' } })
    // Tube has no reorder quantity: suggest enough to get back to the level.
    expect(below.map((r) => [r.name, r.onHand, r.suggestedReorder])).toEqual([['Tube', 2, 3]])
    expect(below[0]!.id).toBe(tube.id)
  })
})

describe('sites and access', () => {
  it('keeps each site’s stock to itself', async () => {
    const a = await setup(siteA, { swab: 10, tube: 10 })
    const b = await setup(siteB, { swab: 10, tube: 10 })
    const seen = await payload.find({ collection: 'supply-items' as never, ...as(staffA), pagination: false })
    expect((seen.docs as Doc[]).every((d) => String(d.tenant?.id ?? d.tenant) === String(siteA.id))).toBe(true)
    await expect(payload.findByID({ collection: 'supply-items' as never, id: b.swab.id, ...as(staffA) })).rejects.toThrow()
    // Staff of A can't record stock against B's supply.
    await expect(create('supply-movements', { item: b.swab.id, kind: 'used', quantity: 1, tenant: siteA.id }, as(staffA))).rejects.toThrow(/can’t record stock/)
    // A recipe or item can't link to another site's records.
    await expect(create('supply-recipes', { tenant: siteA.id, name: 'Mixed', key: 'mixed', lines: [{ item: b.swab.id, quantity: 1 }] })).rejects.toThrow(/another tenant/)
    await expect(create('supply-items', { tenant: siteA.id, name: 'Cap', unit: 'each', supplier: b.supplier.id })).rejects.toThrow(/another tenant/)
    // The same key on two sites finds each site's own recipe.
    await create('supply-recipes', { tenant: siteA.id, name: 'Shared key A', key: 'shared', lines: [{ item: a.tube.id, quantity: 1 }] })
    await create('supply-recipes', { tenant: siteB.id, name: 'Shared key B', key: 'shared', lines: [{ item: b.tube.id, quantity: 1 }] })
    await expect(create('supply-recipes', { tenant: siteA.id, name: 'Again', key: 'shared', lines: [{ item: a.tube.id, quantity: 1 }] })).rejects.toThrow(/already uses/)
    await applyRecipe(payload, { key: 'shared' }, 3, { scope: siteB.id })
    expect((await get('supply-items', a.tube.id)).onHand).toBe(10)
    expect((await get('supply-items', b.tube.id)).onHand).toBe(7)
    await expect(applyRecipe(payload, { id: b.recipe.id }, 1, { scope: siteA.id })).rejects.toThrow(/somewhere else/)
  })

  it('lets staff write, viewers read, and nobody else in', async () => {
    const { swab } = await setup(siteA, { swab: 10, tube: 10 })
    await expect(payload.find({ collection: 'supply-items' as never, overrideAccess: false })).rejects.toThrow()
    await expect(payload.find({ collection: 'supply-movements' as never, overrideAccess: false })).rejects.toThrow()
    const read = await payload.findByID({ collection: 'supply-items' as never, id: swab.id, ...as(viewerA) })
    expect((read as Doc).name).toBe('Swab')
    await expect(create('supply-movements', { item: swab.id, kind: 'used', quantity: 1 }, as(viewerA))).rejects.toThrow()
    await expect(payload.update({ collection: 'supply-items' as never, id: swab.id, data: { name: 'x' } as never, ...as(viewerA) })).rejects.toThrow()
    await create('supply-movements', { item: swab.id, kind: 'used', quantity: 1 }, as(staffA))
    expect((await get('supply-items', swab.id)).onHand).toBe(9)
  })
})

describe('units and the shrinkage allowance', () => {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10) + 'T00:00:00.000Z'

  it('takes stock in packs and other units of the same kind, and refuses the wrong kind', async () => {
    const beans = await create('supply-items', { tenant: siteA.id, name: 'Beans', unit: 'grams', packs: [{ name: '1 kg bag', size: 1000 }], openingStock: 500 })
    expect(beans.unit).toBe('g')
    await create('supply-movements', { item: beans.id, kind: 'received', quantity: 2, unit: '1 kg bag' }, as(staffA))
    const m = await create('supply-movements', { item: beans.id, kind: 'received', quantity: 0.5, unit: 'kg' }, as(staffA))
    expect(m).toMatchObject({ change: 500, unit: 'kg', quantity: 0.5 })
    expect((await get('supply-items', beans.id)).onHand).toBe(3000)
    await expect(create('supply-movements', { item: beans.id, kind: 'used', quantity: 1, unit: 'ml' }, as(staffA))).rejects.toThrow(/counted in g/)
  })

  it('adds the allowance to what a recipe uses, most specific first, and records it', async () => {
    const beans = await create('supply-items', { tenant: siteA.id, name: 'Beans', unit: 'g', openingStock: 5000, shrinkagePercent: 5 })
    const milk = await create('supply-items', { tenant: siteA.id, name: 'Milk', unit: 'ml', openingStock: 10000 })
    const latte = await create('supply-recipes', {
      tenant: siteA.id,
      name: 'Latte',
      key: `latte-${Math.random().toString(36).slice(2, 8)}`,
      lines: [
        { item: beans.id, quantity: 0.018, unit: 'kg' },
        { item: milk.id, quantity: 0.2, unit: 'l', shrinkagePercent: 10 },
      ],
    })
    const result = await applyRecipe(payload, { id: latte.id }, 10, { scope: siteA.id })
    expect(result.movements.map((m) => [m.change, m.shrinkageAllowance])).toEqual([
      [-189, 9],
      [-2200, 200],
    ])
    expect((await get('supply-items', beans.id)).onHand).toBe(4811)
    await payload.update({ collection: 'supply-recipes' as never, id: latte.id, data: { shrinkagePercent: 0 } as never })
    const none = await applyRecipe(payload, { id: latte.id }, 1, { scope: siteA.id })
    expect(none.movements.map((m) => m.change)).toEqual([-18, -220]) // the line's own 10% still wins
  })

  it('suggests an allowance from what really happened, once there is enough history', async () => {
    const swab = await create('supply-items', { tenant: siteA.id, name: 'Swab', unit: 'each', openingStock: 1000, shrinkagePercent: 5 })
    const kit = await create('supply-recipes', { tenant: siteA.id, name: 'Kit', key: `kit-${Math.random().toString(36).slice(2, 8)}`, lines: [{ item: swab.id, quantity: 10 }] })
    for (let i = 0; i < 9; i++) await applyRecipe(payload, { id: kit.id }, 1, { scope: siteA.id })
    expect((await suggestShrinkagePercent(payload, swab.id)).percent).toBeNull()
    await applyRecipe(payload, { id: kit.id }, 1, { scope: siteA.id })
    await create('supply-movements', { item: swab.id, kind: 'written-off', writeOffReason: 'defective', quantity: 2 }, as(staffA))
    await create('supply-movements', { item: swab.id, kind: 'adjusted', quantity: 3, reason: 'count' }, as(staffA))
    // used 100, allowance 5, written off 2, a count found 3 more: (5 + 2 − 3) / 100 = 4%.
    const s = await suggestShrinkagePercent(payload, swab.id)
    expect(s.percent).toBe(4)
    expect(s.basis).toEqual({ used: 100, shrinkageAllowance: 5, writtenOff: 2, corrections: 3, uses: 10 })
    expect(s.explanation).toMatch(/about 4% lost/)
  })

  it('lots: first to expire first, expired stock unusable and written off, every use on a lot', async () => {
    const swab = await create('supply-items', {
      tenant: siteA.id,
      name: 'Lot swab',
      unit: 'each',
      trackLots: true,
      openingStock: 10,
      openingLotNumber: 'A1',
      openingExpiresOn: day(30),
    })
    await create('supply-movements', { item: swab.id, kind: 'received', quantity: 20, lotNumber: 'B2', expiresOn: day(90) }, as(staffA))
    await create('supply-movements', { item: swab.id, kind: 'received', quantity: 5, lotNumber: 'OLD', expiresOn: day(-3) }, as(staffA))
    const lots = async (): Promise<Doc> =>
      Object.fromEntries(
        ((await payload.find({ collection: 'supply-lots' as never, where: { item: { equals: swab.id } }, pagination: false, depth: 0 })).docs as Doc[]).map((l) => [l.lotNumber, l]),
      )
    expect(Object.values(await lots()).map((l) => [l.lotNumber, l.onHand, String(l.tenant)])).toEqual(
      expect.arrayContaining([
        ['A1', 10, String(siteA.id)],
        ['B2', 20, String(siteA.id)],
        ['OLD', 5, String(siteA.id)],
      ]),
    )
    const kit = await create('supply-recipes', { tenant: siteA.id, name: 'Lot kit', key: `lk-${Math.random().toString(36).slice(2, 8)}`, lines: [{ item: swab.id, quantity: 3 }] })
    const r = await applyRecipe(payload, { id: kit.id }, 5, { scope: siteA.id })
    let l = await lots()
    expect(r.movements.map((m) => [String(m.lot), -m.change])).toEqual([
      [String(l.A1.id), 10],
      [String(l.B2.id), 5],
    ])
    expect([l.A1.onHand, l.B2.onHand, l.OLD.onHand]).toEqual([0, 15, 5])
    // 20 on hand, but 5 of it is expired: only 15 usable.
    const short = await applyRecipe(payload, { id: kit.id }, 6, { scope: siteA.id }).catch((e) => e)
    expect(short).toBeInstanceOf(KittingError)
    expect(short.shortages).toEqual([expect.objectContaining({ onHand: 15, needed: 18, short: 3 })])
    // By hand: the first-to-expire lot that covers it; the same lot number adds to that lot.
    const used = await create('supply-movements', { item: swab.id, kind: 'used', quantity: 2 }, as(staffA))
    expect(ids([used.lot])[0]).toBe(String(l.B2.id))
    await create('supply-movements', { item: swab.id, kind: 'received', quantity: 4, lotNumber: 'B2' }, as(staffA))
    expect((await lots()).B2.onHand).toBe(17)
    // Lots can't be set by hand or duplicated.
    await payload.update({ collection: 'supply-lots' as never, id: l.B2.id, data: { onHand: 999 } as never, ...as(staffA) })
    expect((await lots()).B2.onHand).toBe(17)
    await expect(create('supply-lots', { tenant: siteA.id, item: swab.id, lotNumber: 'B2' }, as(staffA))).rejects.toThrow(/already has a lot B2/)
    // The overview lists the expired lot and counts it out of what's usable.
    const report = await stockReport(payload, { user: { ...staffA, collection: 'users' } })
    const row = report.rows.find((r) => String(r.id) === String(swab.id))!
    expect([row.onHand, row.usable]).toEqual([22, 17])
    expect(report.expiring.filter((e) => String(e.item.id) === String(swab.id)).map((e) => [e.lotNumber, e.expired])).toEqual([['OLD', true]])
    // Expired stock is written off as shrinkage.
    expect((await writeOffExpired(payload)).lots).toBeGreaterThanOrEqual(1)
    l = await lots()
    expect(l.OLD.onHand).toBe(0)
    const writtenOff = (await movementsOf(swab)).filter((m) => m.kind === 'written-off')
    expect(writtenOff).toEqual([expect.objectContaining({ writeOffReason: 'expired', change: -5 })])
    expect((await get('supply-items', swab.id)).onHand).toBe(17)
    expect(sum(await movementsOf(swab))).toBe(17)
  })
})

describe('nested recipes', () => {
  it('draws down a recipe used inside another, scaled by what it makes', async () => {
    const sugar = await create('supply-items', { tenant: siteA.id, name: 'Sugar', unit: 'g', openingStock: 5000 })
    const water = await create('supply-items', { tenant: siteA.id, name: 'Water', unit: 'ml', openingStock: 5000 })
    const beans = await create('supply-items', { tenant: siteA.id, name: 'Beans', unit: 'g', openingStock: 5000 })
    const syrup = await create('supply-recipes', {
      tenant: siteA.id,
      name: 'House syrup',
      key: `syrup-${Math.random().toString(36).slice(2, 8)}`,
      makes: 1,
      makesUnit: 'litre',
      lines: [
        { item: sugar.id, quantity: 500 },
        { item: water.id, quantity: 500 },
      ],
    })
    expect(syrup.makesUnit).toBe('l')
    const latte = await create('supply-recipes', {
      tenant: siteA.id,
      name: 'Syrup latte',
      key: `sl-${Math.random().toString(36).slice(2, 8)}`,
      lines: [
        { item: beans.id, quantity: 18 },
        { type: 'recipe', recipe: syrup.id, quantity: 20, unit: 'ml' },
      ],
    })
    await applyRecipe(payload, { id: latte.id }, 10, { scope: siteA.id })
    // 10 lattes × 20 ml = 200 ml of a 1 l batch: a fifth of 500 g sugar and 500 ml water.
    expect([(await get('supply-items', sugar.id)).onHand, (await get('supply-items', water.id)).onHand, (await get('supply-items', beans.id)).onHand]).toEqual([4900, 4900, 4820])
    await expect(payload.update({ collection: 'supply-recipes' as never, id: syrup.id, data: { lines: [...syrup.lines, { type: 'recipe', recipe: latte.id, quantity: 1 }] } as never })).rejects.toThrow(/would use itself/)
    await expect(payload.update({ collection: 'supply-recipes' as never, id: syrup.id, data: { lines: [{ type: 'recipe', recipe: syrup.id, quantity: 1 }] } as never })).rejects.toThrow(/would use itself/)
    const otherSite = await create('supply-recipes', { tenant: siteB.id, name: 'B syrup', key: 'b-syrup', lines: [{ item: (await create('supply-items', { tenant: siteB.id, name: 'B sugar', unit: 'g' })).id, quantity: 1 }] })
    await expect(create('supply-recipes', { tenant: siteA.id, name: 'Mixed', key: 'mixed', lines: [{ type: 'recipe', recipe: otherSite.id, quantity: 1 }] })).rejects.toThrow(/belongs to another tenant/)
  })
})

describe('the builder', () => {
  async function kit() {
    const swab = await create('supply-items', { tenant: siteA.id, name: 'Build swab', unit: 'each', trackLots: true, openingStock: 3, openingLotNumber: 'S-A', openingExpiresOn: '2099-01-01T00:00:00.000Z' })
    await create('supply-movements', { item: swab.id, kind: 'received', quantity: 10, lotNumber: 'S-B', expiresOn: '2099-06-01T00:00:00.000Z' }, as(staffA))
    const tube = await create('supply-items', { tenant: siteA.id, name: 'Build tube', unit: 'each', openingStock: 10 })
    const recipe = await create('supply-recipes', {
      tenant: siteA.id,
      name: 'Sample kit',
      key: `sk-${Math.random().toString(36).slice(2, 8)}`,
      maxPerBatch: 3,
      lines: [
        { item: swab.id, quantity: 2 },
        { item: tube.id, quantity: 1 },
      ],
    })
    const lots = Object.fromEntries(((await payload.find({ collection: 'supply-lots' as never, where: { item: { equals: swab.id } }, depth: 0 })).docs as Doc[]).map((l) => [l.lotNumber, String(l.id)]))
    return { swab, tube, recipe, lots }
  }
  const run = () => Math.random().toString(36).slice(2, 7).toUpperCase()

  it('builds one unit per ID, recording the lots that went into each', async () => {
    const { swab, tube, recipe, lots } = await kit()
    const [k1, k2] = [`K1-${run()}`, `K2-${run()}`]
    const r = await buildUnits(payload, { id: recipe.id }, [k1, ` ${k2} `], { scope: siteA.id, user: { id: staffA.id } })
    expect(r.units.map((u) => [u.externalId, u.status, String(u.scope)])).toEqual([
      [k1, 'ready', String(siteA.id)],
      [k2, 'ready', String(siteA.id)],
    ])
    const uses = (u: (typeof r.units)[number]) => u.lotsUsed.map((l) => [String(l.item) === String(swab.id) ? 'swab' : 'tube', l.lot === null ? null : String(l.lot), l.quantity])
    expect(uses(r.units[0]!)).toEqual([
      ['swab', lots['S-A'], 2],
      ['tube', null, 1],
    ])
    expect(uses(r.units[1]!)).toEqual([
      ['swab', lots['S-A'], 1],
      ['swab', lots['S-B'], 1],
      ['tube', null, 1],
    ])
    expect((await get('supply-items', swab.id)).onHand).toBe(9)
    expect((await get('supply-items', tube.id)).onHand).toBe(8)
    expect(onBuilt).toEqual(expect.arrayContaining([k1, k2]))
    const unit = (await payload.find({ collection: 'assembled-units' as never, where: { externalId: { equals: k1 } }, depth: 0 })).docs[0] as Doc
    expect(String(unit.builtBy)).toBe(String(staffA.id))
  })

  it('refuses repeats, IDs already built, oversize batches, and anything the host refuses, changing nothing', async () => {
    const { swab, recipe } = await kit()
    const k = `R-${run()}`
    await buildUnits(payload, { id: recipe.id }, [k], { scope: siteA.id })
    const code = (p: Promise<unknown>) => p.then(() => 'built', (e) => (e as KittingError).code ?? String(e))
    expect(await code(buildUnits(payload, { id: recipe.id }, ['X', 'X'], { scope: siteA.id }))).toBe('duplicateId')
    expect(await code(buildUnits(payload, { id: recipe.id }, [k], { scope: siteA.id }))).toBe('idTaken')
    expect(await code(buildUnits(payload, { id: recipe.id }, ['a', 'b', 'c', 'd'], { scope: siteA.id }))).toBe('batchLimit')
    expect(await code(buildUnits(payload, { id: recipe.id }, ['', 'b'], { scope: siteA.id }))).toBe('externalId')
    refuseBuild = `NO-${run()}`
    expect(await code(buildUnits(payload, { id: recipe.id }, [refuseBuild], { scope: siteA.id }))).not.toBe('built')
    refuseBuild = ''
    expect((await get('supply-items', swab.id)).onHand).toBe(11)
    // The same ID on another site is fine: IDs are unique per site.
    const b = await create('supply-recipes', { tenant: siteB.id, name: 'B kit', key: `bk-${run().toLowerCase()}`, lines: [{ item: (await create('supply-items', { tenant: siteB.id, name: 'B swab', unit: 'each', openingStock: 5 })).id, quantity: 1 }] })
    expect((await buildUnits(payload, { id: b.id }, [k], { scope: siteB.id })).units).toHaveLength(1)
  })

  it('keeps units out of reach by hand, and voids them with or without returning their supplies', async () => {
    const { swab, recipe, lots } = await kit()
    const [a, b] = [`V1-${run()}`, `V2-${run()}`]
    const { units } = await buildUnits(payload, { id: recipe.id }, [a, b], { scope: siteA.id })
    await expect(create('assembled-units', { tenant: siteA.id, externalId: 'HAND', recipe: recipe.id }, as(staffA))).rejects.toThrow(/made with the builder/)
    await payload.update({ collection: 'assembled-units' as never, id: units[0]!.id, data: { status: 'shipped', notes: 'checked' } as never, ...as(staffA) })
    expect(await get('assembled-units', units[0]!.id)).toMatchObject({ status: 'ready', notes: 'checked' })
    await expect(payload.delete({ collection: 'assembled-units' as never, id: units[0]!.id, ...as(staffA) })).rejects.toThrow()
    // A dud: its supplies are gone, stock stays.
    await voidUnit(payload, units[0]!.id, { reason: 'dud' })
    expect((await get('supply-items', swab.id)).onHand).toBe(9)
    // Built by mistake: its swabs go back to the lots they came from.
    await voidUnit(payload, units[1]!.id, { reason: 'mistake', returnToStock: true })
    expect((await get('supply-items', swab.id)).onHand).toBe(11)
    const lot = async (n: string) => (await get('supply-lots', lots[n])).onHand
    expect([await lot('S-A'), await lot('S-B')]).toEqual([1, 10])
    expect(await get('assembled-units', units[1]!.id)).toMatchObject({ status: 'void', voidReason: 'mistake', returnedToStock: true })
    await expect(voidUnit(payload, units[1]!.id, { reason: 'other' })).rejects.toThrow(/already void/)
  })

  it('builds over HTTP only for people who manage that site', async () => {
    const { recipe } = await kit()
    const endpoint = payload.config.endpoints.find((e) => e.path === '/kitting/build')!
    const call = (user: Doc | null, body: Doc) => endpoint.handler({ payload, user: user && { ...user, collection: 'users' }, json: async () => body } as never) as Promise<Response>
    const k = `H-${run()}`
    expect((await call(null, { recipe: recipe.id, externalIds: [k] })).status).toBe(401)
    expect((await call(staffB, { recipe: recipe.id, externalIds: [k] })).status).toBe(403)
    expect((await call(viewerA, { recipe: recipe.id, externalIds: [k] })).status).toBe(403)
    const bad = await call(staffA, { recipe: recipe.id, externalIds: ['a', 'b', 'c', 'd'] })
    expect([bad.status, (await bad.json()).code]).toEqual([400, 'batchLimit'])
    const ok = await call(staffA, { recipe: recipe.id, externalIds: [k] })
    expect(ok.status).toBe(200)
    expect((await ok.json()).units.map((u: Doc) => u.externalId)).toEqual([k])
  })

  it('recommends ready stock from the recipe’s settings and what is ready', async () => {
    const { recipe } = await kit()
    await payload.update({ collection: 'supply-recipes' as never, id: recipe.id, data: { maxPerBatch: 50, readyStock: { method: 'statistical', manual: 5, leadTimeDays: 5, reviewDays: 2, serviceLevel: 95 } } as never })
    await buildUnits(payload, { id: recipe.id }, [`RS-${run()}`, `RS-${run()}`, `RS-${run()}`], { scope: siteA.id })
    const now = new Date('2026-11-08T12:00:00Z')
    const sales = Array.from({ length: 60 }, (_, i) => [{ at: new Date(now.getTime() - i * 86_400_000) }, { at: new Date(now.getTime() - i * 86_400_000) }]).flat()
    const { ready, recommendations } = await recommendReadyStock(payload, recipe.id, { sales, now })
    expect(ready).toBe(3)
    expect(recommendations[0]).toMatchObject({ method: 'statistical', target: 14, buildNow: 11, fallback: false })
    // No sales yet: the fixed number.
    const empty = await recommendReadyStock(payload, recipe.id, { sales: [], now })
    expect(empty.recommendations[0]).toMatchObject({ target: 5, fallback: true, buildNow: 2 })
  })
})

describe('test audit 2026-11-08: gaps closed', () => {
  const run = () => Math.random().toString(36).slice(2, 7).toUpperCase()
  async function lotKit(site: Doc) {
    const swab = await create('supply-items', { tenant: site.id, name: 'Audit swab', unit: 'each', trackLots: true, openingStock: 4, openingLotNumber: `L-${run()}`, openingExpiresOn: '2099-01-01T00:00:00.000Z' })
    const recipe = await create('supply-recipes', { tenant: site.id, name: 'Audit kit', key: `ak-${run().toLowerCase()}`, lines: [{ item: swab.id, quantity: 2 }] })
    return { swab, recipe }
  }

  it('keeps lots and built units to their own site, readable by viewers, writable by nobody else', async () => {
    const a = await lotKit(siteA)
    const b = await lotKit(siteB)
    await buildUnits(payload, { id: a.recipe.id }, [`IA-${run()}`], { scope: siteA.id })
    await buildUnits(payload, { id: b.recipe.id }, [`IB-${run()}`], { scope: siteB.id })
    for (const collection of ['supply-lots', 'assembled-units']) {
      const mine = (await payload.find({ collection: collection as never, ...as(staffA), pagination: false, depth: 0 })).docs as Doc[]
      expect(mine.length).toBeGreaterThan(0)
      expect(mine.every((d) => String(d.tenant) === String(siteA.id))).toBe(true)
      expect(((await payload.find({ collection: collection as never, ...as(viewerA), pagination: false, depth: 0 })).docs as Doc[]).length).toBe(mine.length)
      await expect(payload.find({ collection: collection as never, overrideAccess: false })).rejects.toThrow()
    }
    // Staff of B can't add a lot to A's supply (a lot takes its site from the supply), nor can a viewer.
    await expect(create('supply-lots', { tenant: siteB.id, item: a.swab.id, lotNumber: 'SNEAK' }, as(staffB))).rejects.toThrow(/can’t add or change lots/)
    await expect(create('supply-lots', { tenant: siteA.id, item: a.swab.id, lotNumber: 'VIEW' }, as(viewerA))).rejects.toThrow()
    const lotA = ((await payload.find({ collection: 'supply-lots' as never, where: { item: { equals: a.swab.id } }, depth: 0 })).docs as Doc[])[0]!
    await expect(payload.update({ collection: 'supply-lots' as never, id: lotA.id, data: { lotNumber: 'X' } as never, ...as(staffB) })).rejects.toThrow()
    await expect(payload.update({ collection: 'supply-lots' as never, id: lotA.id, data: { lotNumber: 'X' } as never, ...as(viewerA) })).rejects.toThrow()
  })

  it('voids over HTTP only for people who manage that site', async () => {
    const a = await lotKit(siteA)
    const { units } = await buildUnits(payload, { id: a.recipe.id }, [`VH-${run()}`], { scope: siteA.id })
    const endpoint = payload.config.endpoints.find((e) => e.path === '/kitting/void')!
    const call = (user: Doc | null) => endpoint.handler({ payload, user: user && { ...user, collection: 'users' }, json: async () => ({ unit: units[0]!.id, reason: 'dud' }) } as never) as Promise<Response>
    expect((await call(null)).status).toBe(401)
    expect((await call(staffB)).status).toBe(403)
    expect((await call(viewerA)).status).toBe(403)
    expect((await get('assembled-units', units[0]!.id)).status).toBe('ready')
    expect((await call(staffA)).status).toBe(200)
    expect((await get('assembled-units', units[0]!.id)).status).toBe('void')
  })

  it('refuses a build without enough stock and writes nothing', async () => {
    const a = await lotKit(siteA) // 4 swabs, 2 per kit
    const before = (await movementsOf(a.swab)).length
    const e = await buildUnits(payload, { id: a.recipe.id }, [`S1-${run()}`, `S2-${run()}`, `S3-${run()}`], { scope: siteA.id }).catch((x) => x)
    expect(e).toMatchObject({ code: 'notEnoughStock', shortages: [expect.objectContaining({ onHand: 4, needed: 6, short: 2 })] })
    expect((await get('supply-items', a.swab.id)).onHand).toBe(4)
    expect((await movementsOf(a.swab)).length).toBe(before)
    expect((await payload.count({ collection: 'assembled-units' as never, where: { recipe: { equals: a.recipe.id } } })).totalDocs).toBe(0)
  })

  it('lets only one of two builds at once use the same ID', async () => {
    const swab = await create('supply-items', { tenant: siteA.id, name: 'Race swab', unit: 'each', openingStock: 100 })
    const r1 = await create('supply-recipes', { tenant: siteA.id, name: 'Race 1', key: `r1-${run().toLowerCase()}`, lines: [{ item: swab.id, quantity: 1 }] })
    const other = await create('supply-items', { tenant: siteA.id, name: 'Race tube', unit: 'each', openingStock: 100 })
    const r2 = await create('supply-recipes', { tenant: siteA.id, name: 'Race 2', key: `r2-${run().toLowerCase()}`, lines: [{ item: other.id, quantity: 1 }] })
    const id = `RACE-${run()}`
    const results = await Promise.allSettled([buildUnits(payload, { id: r1.id }, [id], { scope: siteA.id }), buildUnits(payload, { id: r2.id }, [id], { scope: siteA.id })])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await payload.count({ collection: 'assembled-units' as never, where: { externalId: { equals: id } } })).totalDocs).toBe(1)
    // The loser took nothing off stock.
    expect((await get('supply-items', swab.id)).onHand + (await get('supply-items', other.id)).onHand).toBe(199)
  })

  it('writes an expired lot off once, and refuses a recipe unit that can’t convert', async () => {
    const milk = await create('supply-items', { tenant: siteA.id, name: 'Audit milk', unit: 'ml', trackLots: true, openingStock: 500, openingLotNumber: `M-${run()}`, openingExpiresOn: '2020-01-01T00:00:00.000Z' })
    await writeOffExpired(payload)
    const once = (await movementsOf(milk)).filter((m) => m.kind === 'written-off').length
    await writeOffExpired(payload)
    expect([once, (await movementsOf(milk)).filter((m) => m.kind === 'written-off').length]).toEqual([1, 1])
    expect((await get('supply-items', milk.id)).onHand).toBe(0)
    const bad = await create('supply-recipes', { tenant: siteA.id, name: 'Bad unit', key: `bu-${run().toLowerCase()}`, lines: [{ item: milk.id, quantity: 1, unit: 'kg' }] })
    await expect(applyRecipe(payload, { id: bad.id }, 1, { scope: siteA.id })).rejects.toThrow(/can’t be converted/)
  })
})

describe('fulfilment: assign, queue, swap, release', () => {
  const run = () => Math.random().toString(36).slice(2, 7).toUpperCase()
  async function stocked(ready: number) {
    const swab = await create('supply-items', { tenant: siteA.id, name: 'Order swab', unit: 'each', openingStock: 100 })
    const recipe = await create('supply-recipes', { tenant: siteA.id, name: 'Order kit', key: `ok-${run().toLowerCase()}`, lines: [{ item: swab.id, quantity: 1 }] })
    const ids = Array.from({ length: ready }, (_, i) => `O${i}-${run()}`)
    if (ready) await buildUnits(payload, { id: recipe.id }, ids, { scope: siteA.id })
    return { recipe, ids }
  }
  const unitsOf = async (recipe: Doc): Promise<Record<string, Doc>> =>
    Object.fromEntries(((await payload.find({ collection: 'assembled-units' as never, where: { recipe: { equals: recipe.id } }, pagination: false, depth: 0 })).docs as Doc[]).map((u) => [u.externalId, u]))
  const requestOf = async (reference: string) => ((await payload.find({ collection: 'build-requests' as never, where: { reference: { equals: reference } }, depth: 0 })).docs as Doc[])[0]

  it('assigns ready units oldest first and queues the rest; running it again adds only the difference', async () => {
    const { recipe, ids } = await stocked(2)
    const order = `Order ${run()}`
    const a = await assignUnits(payload, { id: recipe.id }, 3, { reference: order, scope: siteA.id })
    expect(a.assigned.map((u) => u.externalId)).toEqual(ids)
    expect([a.short, a.request?.count]).toEqual([1, 1])
    const again = await assignUnits(payload, { id: recipe.id }, 3, { reference: order, scope: siteA.id })
    expect([again.assigned.length, again.short, again.request?.count]).toEqual([2, 0, 1])
    const more = await assignUnits(payload, { id: recipe.id }, 4, { reference: order, scope: siteA.id })
    expect([more.short, more.request?.count]).toEqual([1, 2])
    expect((await payload.count({ collection: 'build-requests' as never, where: { reference: { equals: order } } })).totalDocs).toBe(1)
    // Building fills the waiting request first.
    const built = await buildUnits(payload, { id: recipe.id }, [`N1-${run()}`, `N2-${run()}`, `N3-${run()}`], { scope: siteA.id })
    expect(built.filled.map((f) => f.reference)).toEqual([order, order])
    expect(await requestOf(order)).toMatchObject({ status: 'filled', filled: 2 })
    const units = await unitsOf(recipe)
    expect(Object.values(units).filter((u) => u.assignedTo === order)).toHaveLength(4)
    expect(Object.values(units).filter((u) => u.status === 'ready')).toHaveLength(1)
    await expect(assignUnits(payload, { id: recipe.id }, 1, { reference: ' ', scope: siteA.id })).rejects.toThrow(/which order/)
  })

  it('lets the scan at packing decide, swapping for a reserved unit or filling a queued one', async () => {
    const { recipe, ids } = await stocked(3)
    const order = `Order ${run()}`
    await assignUnits(payload, { id: recipe.id }, 1, { reference: order, scope: siteA.id }) // takes ids[0]
    // Scanning the reserved unit changes nothing.
    expect((await swapUnit(payload, { reference: order, take: { externalId: ids[0]! }, scope: siteA.id })).released).toBeNull()
    // Scanning another ready unit: it takes the reserved one's place, which is ready again.
    const s = await swapUnit(payload, { reference: order, take: { externalId: ids[2]! }, scope: siteA.id })
    expect([s.taken.externalId, s.released?.externalId]).toEqual([ids[2], ids[0]])
    let units = await unitsOf(recipe)
    expect([units[ids[0]!]!.status, units[ids[2]!]!.assignedTo]).toEqual(['ready', order])
    // A unit kept for another order can't be taken.
    const other = `Order ${run()}`
    await assignUnits(payload, { id: recipe.id }, 1, { reference: other, scope: siteA.id })
    const otherUnit = Object.values(await unitsOf(recipe)).find((u) => u.assignedTo === other)!
    await expect(swapUnit(payload, { reference: order, take: { id: otherUnit.id } })).rejects.toThrow(/kept for/)
    // An order with only a queued request: the scan fills it.
    const queued = `Order ${run()}`
    await assignUnits(payload, { id: recipe.id }, 2, { reference: queued, scope: siteA.id, req: undefined }) // 1 ready left, 1 queued
    await buildUnits(payload, { id: recipe.id }, [`Q-${run()}`], { scope: siteA.id, fillRequests: false })
    const loose = Object.values(await unitsOf(recipe)).find((u) => u.status === 'ready')!
    const f = await swapUnit(payload, { reference: queued, take: { id: loose.id } })
    expect(f.fromRequest).not.toBeNull()
    expect(await requestOf(queued)).toMatchObject({ status: 'filled', filled: 1 })
    // An order holding nothing of it is refused.
    await expect(swapUnit(payload, { reference: `Nobody ${run()}`, take: { externalId: ids[1]! }, scope: siteA.id })).rejects.toThrow()
    units = await unitsOf(recipe)
    expect(Object.values(units).filter((u) => u.assignedTo === order)).toHaveLength(1)
  })

  it('releases one unit or everything an order holds, never shipped ones, and cancels its queue', async () => {
    const { recipe, ids } = await stocked(3)
    const order = `Order ${run()}`
    await assignUnits(payload, { id: recipe.id }, 5, { reference: order, scope: siteA.id }) // 3 assigned, 2 queued
    await shipUnits(payload, [(await unitsOf(recipe))[ids[0]!]!.id])
    const one = await release(payload, { reference: order, unit: { externalId: ids[1]! }, scope: siteA.id })
    expect(one.released.map((u) => [u.externalId, u.status])).toEqual([[ids[1], 'ready']])
    await expect(release(payload, { reference: order, unit: { externalId: ids[0]! }, scope: siteA.id })).rejects.toThrow(/isn’t kept/)
    const all = await release(payload, { reference: order, scope: siteA.id })
    expect(all.released.map((u) => u.externalId)).toEqual([ids[2]])
    expect(all.cancelledRequests).toHaveLength(1)
    const units = await unitsOf(recipe)
    expect([units[ids[0]!]!.status, units[ids[1]!]!.status, units[ids[2]!]!.status]).toEqual(['shipped', 'ready', 'ready'])
    expect((await requestOf(order))!.status).toBe('cancelled')
    await expect(shipUnits(payload, [units[ids[1]!]!.id])).rejects.toThrow(/can’t be shipped/)
    // Build requests can't be made by hand, and only cancelled.
    await expect(create('build-requests', { tenant: siteA.id, reference: 'x', recipe: recipe.id, count: 1 }, as(staffA))).rejects.toThrow(/can’t be filled from ready stock/)
  })

  it('keeps one site’s orders away from another’s units', async () => {
    const { recipe, ids } = await stocked(1)
    await expect(swapUnit(payload, { reference: 'B order', take: { externalId: ids[0]! }, scope: siteB.id })).rejects.toThrow(/hasn’t been built/)
    await expect(assignUnits(payload, { id: recipe.id }, 1, { reference: 'B order', scope: siteB.id })).rejects.toThrow(/somewhere else/)
    await expect(release(payload, { reference: 'B order' })).rejects.toThrow(/Say which tenant/)
  })
})
