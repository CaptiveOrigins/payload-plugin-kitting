import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import { getTenantAccess } from '@payloadcms/plugin-multi-tenant/utilities'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Access, type Payload, type Plugin } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { applyRecipe, assignUnits, buildUnits, kittingPlugin, restockArrivals, swapUnit } from '../src/index.js'

// Kitting's scope field with Payload's real multi-tenant plugin adding `tenant`, not a field added by
// hand with `overrides`. Made-up sites, supplies and example.com users; each config has its own database.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const KITTING = ['supply-items', 'suppliers', 'supply-movements', 'supply-recipes', 'supply-lots', 'assembled-units', 'build-requests', 'box-types', 'postage-rates', 'kitting-settings']

let mongo: MongoMemoryReplSet
const started: Payload[] = []
const run = () => Math.random().toString(36).slice(2, 8).toUpperCase()

/** A host with Kitting and the tenant plugin. The tenant plugin goes last, as its docs ask, unless `tenantFirst`. */
async function start(key: string, tenantCollections: string[], tenantFirst = false, manage?: Access) {
  const kitting = kittingPlugin({ scopeField: 'tenant', ...(manage ? { access: { manage } } : {}) })
  const tenants = multiTenantPlugin({
    collections: Object.fromEntries(tenantCollections.map((slug) => [slug, {}])),
    userHasAccessToAllTenants: (user) => (user as Doc).role === 'admin',
  }) as Plugin
  const payload = await getPayload({
    key,
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri(`multi-tenant-${key}`), ensureIndexes: true }),
      collections: [
        { slug: 'tenants', fields: [{ name: 'name', type: 'text' }] },
        { slug: 'users', auth: true, fields: [{ name: 'role', type: 'text' }] },
      ],
      admin: { user: 'users' },
      plugins: tenantFirst ? [tenants, kitting] : [kitting, tenants],
    }),
  })
  started.push(payload)
  return payload
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
}, 180_000)

afterAll(async () => {
  for (const p of started) await p.destroy()
  await mongo?.stop()
})

describe('startup with the multi-tenant plugin', () => {
  it('refuses when one Kitting collection is left out of the tenant plugin’s list, naming it', async () => {
    await expect(start('left-out', KITTING.filter((s) => s !== 'kitting-settings'))).rejects.toThrow(
      'Kitting: scopeField is "tenant", but kitting-settings has no "tenant" field.',
    )
  })

  it('refuses when the tenant plugin runs before Kitting, so none of Kitting’s collections get the field', async () => {
    // Payload's own config check stops this first, before Kitting's onInit: the units' unique
    // (externalId, tenant) index names a field that isn't there. The tenant plugin logs a warning
    // naming every Kitting collection it couldn't find. Either way, startup fails closed.
    await expect(start('tenant-first', KITTING, true)).rejects.toThrow('Field tenant was not found')
  })
})

describe('Kitting under the multi-tenant plugin', () => {
  let payload: Payload
  let siteA: Doc, siteB: Doc, staffA: Doc, staffB: Doc
  const create = (collection: string, data: Doc, extra: Doc = {}) => payload.create({ collection: collection as never, data: data as never, depth: 0, ...extra }) as Promise<Doc>
  const get = (collection: string, id: unknown) => payload.findByID({ collection: collection as never, id: id as string, depth: 0 }) as Promise<Doc>
  const as = (u: Doc) => ({ user: { ...u, collection: 'users' }, overrideAccess: false })
  const tenantOf = (d: Doc) => String(d.tenant?.id ?? d.tenant)
  const count = async (collection: string, where: Doc) => (await payload.count({ collection: collection as never, where: where as never })).totalDocs

  /** One site's stock: a supplier, a swab and a tube, and a kit using one of each. */
  async function setup(site: Doc) {
    const supplier = await create('suppliers', { tenant: site.id, name: 'Example Lab Supply', email: 'orders@example.com' })
    const swab = await create('supply-items', { tenant: site.id, name: 'Swab', unit: 'each', supplier: supplier.id, openingStock: 20 })
    const tube = await create('supply-items', { tenant: site.id, name: 'Tube', unit: 'each', openingStock: 20 })
    const key = `kit-${run().toLowerCase()}`
    const recipe = await create('supply-recipes', { tenant: site.id, name: 'Placeholder kit', key, lines: [{ item: swab.id, quantity: 1 }, { item: tube.id, quantity: 1 }] })
    return { supplier, swab, tube, recipe, key }
  }

  beforeAll(async () => {
    payload = await start('scoped', KITTING)
    siteA = await create('tenants', { name: 'Site A' })
    siteB = await create('tenants', { name: 'Site B' })
    const user = (email: string, site: Doc) => create('users', { email, password: 'a-long-test-password', role: 'staff', tenants: [{ tenant: site.id }] })
    staffA = await user('staff-a@example.com', siteA)
    staffB = await user('staff-b@example.com', siteB)
  }, 180_000)

  it('starts, with the tenant plugin’s own `tenant` field on every Kitting collection', () => {
    for (const slug of KITTING) {
      const field = (payload.collections[slug as never]!.config.flattenedFields as Doc[]).find((f) => f.name === 'tenant')
      expect(field, slug).toMatchObject({ type: 'relationship', relationTo: 'tenants', hasMany: false, index: true })
    }
  })

  it('keeps recipes to their own site’s supplies, and recipe keys unique per site', async () => {
    const a = await setup(siteA)
    const b = await setup(siteB)
    await expect(create('supply-recipes', { tenant: siteA.id, name: 'Mixed', key: `mixed-${run().toLowerCase()}`, lines: [{ item: b.swab.id, quantity: 1 }] })).rejects.toThrow(/another tenant/)
    await expect(create('supply-items', { tenant: siteA.id, name: 'Cap', unit: 'each', supplier: b.supplier.id })).rejects.toThrow(/another tenant/)
    const key = `shared-${run().toLowerCase()}`
    await create('supply-recipes', { tenant: siteA.id, name: 'Shared key A', key, lines: [{ item: a.tube.id, quantity: 1 }] })
    await create('supply-recipes', { tenant: siteB.id, name: 'Shared key B', key, lines: [{ item: b.tube.id, quantity: 1 }] })
    await expect(create('supply-recipes', { tenant: siteA.id, name: 'Again', key, lines: [{ item: a.tube.id, quantity: 1 }] })).rejects.toThrow(/already uses/)
    await applyRecipe(payload, { key }, 3, { scope: siteB.id })
    expect([(await get('supply-items', a.tube.id)).onHand, (await get('supply-items', b.tube.id)).onHand]).toEqual([20, 17])
    await expect(applyRecipe(payload, { id: b.recipe.id }, 1, { scope: siteA.id })).rejects.toThrow(/somewhere else/)
  })

  it('gives a movement its supply’s site, whatever site it was given', async () => {
    const a = await setup(siteA)
    const plain = await create('supply-movements', { item: a.swab.id, kind: 'used', quantity: 1 })
    const wrong = await create('supply-movements', { item: a.swab.id, kind: 'used', quantity: 1, tenant: siteB.id })
    const byStaff = await create('supply-movements', { item: a.swab.id, kind: 'used', quantity: 1 }, as(staffA))
    expect([plain, wrong, byStaff].map(tenantOf)).toEqual([siteA.id, siteA.id, siteA.id].map(String))
    expect((await get('supply-items', a.swab.id)).onHand).toBe(17)
  })

  it('keeps assignUnits and buildUnits with assignTo inside one site', async () => {
    const a = await setup(siteA)
    const b = await setup(siteB)
    const order = `Order ${run()}`
    // Site B keeps a unit for the order; site A has an order of the same name holding nothing.
    const bId = `B-${run()}`
    await buildUnits(payload, { id: b.recipe.id }, [bId], { scope: siteB.id })
    expect((await assignUnits(payload, { id: b.recipe.id }, 1, { reference: order, scope: siteB.id })).assigned.map((u) => u.externalId)).toEqual([bId])
    await expect(assignUnits(payload, { id: b.recipe.id }, 1, { reference: order, scope: siteA.id })).rejects.toThrow(/somewhere else/)
    const units = () => count('assembled-units', { recipe: { equals: a.recipe.id } })
    const movements = () => count('supply-movements', { item: { equals: a.swab.id } })
    const [u0, m0] = [await units(), await movements()]
    await expect(buildUnits(payload, { id: a.recipe.id }, [`A-${run()}`], { scope: siteA.id, assignTo: order })).rejects.toMatchObject({ code: 'nothingReserved' })
    expect([await units(), await movements()]).toEqual([u0, m0])
    const kept = ((await payload.find({ collection: 'assembled-units' as never, where: { externalId: { equals: bId } }, depth: 0 })).docs as Doc[])[0]!
    expect([kept.status, kept.assignedTo, tenantOf(kept)]).toEqual(['assigned', order, String(siteB.id)])
    // Site A's own order of that name: queued, then built straight into it, on site A.
    await assignUnits(payload, { id: a.recipe.id }, 1, { reference: order, scope: siteA.id })
    const aId = `A-${run()}`
    const built = await buildUnits(payload, { id: a.recipe.id }, [aId], { scope: siteA.id, assignTo: order })
    expect(built.assigned.map((g) => [g.externalId, g.reference])).toEqual([[aId, order]])
    expect(built.units.map((u) => String(u.scope))).toEqual([String(siteA.id)])
    // The same external ID can be used on each site, and each site finds only its own.
    await buildUnits(payload, { id: b.recipe.id }, [aId], { scope: siteB.id })
    expect(await count('assembled-units', { externalId: { equals: aId } })).toBe(2)
  })

  it('with the tenant plugin’s access: site A’s staff can’t read or write site B’s Kitting rows', async () => {
    const a = await setup(siteA)
    const b = await setup(siteB)
    await buildUnits(payload, { id: a.recipe.id }, [`RA-${run()}`], { scope: siteA.id })
    await buildUnits(payload, { id: b.recipe.id }, [`RB-${run()}`], { scope: siteB.id })
    await assignUnits(payload, { id: a.recipe.id }, 5, { reference: `Order ${run()}`, scope: siteA.id })
    await assignUnits(payload, { id: b.recipe.id }, 5, { reference: `Order ${run()}`, scope: siteB.id })
    for (const slug of ['supply-items', 'suppliers', 'supply-movements', 'supply-recipes', 'assembled-units', 'build-requests']) {
      const seen = (await payload.find({ collection: slug as never, ...as(staffA), pagination: false, depth: 0 })).docs as Doc[]
      expect(seen.length, slug).toBeGreaterThan(0)
      expect(seen.every((d) => tenantOf(d) === String(siteA.id)), slug).toBe(true)
      const theirs = (await payload.find({ collection: slug as never, ...as(staffB), pagination: false, depth: 0 })).docs as Doc[]
      expect(theirs.every((d) => tenantOf(d) === String(siteB.id)), slug).toBe(true)
    }
    await expect(payload.findByID({ collection: 'supply-items' as never, id: b.swab.id, ...as(staffA) })).rejects.toThrow()
    await expect(payload.findByID({ collection: 'supply-recipes' as never, id: b.recipe.id, ...as(staffA) })).rejects.toThrow()
    // Writes. With Kitting's default access (any signed-in user), Kitting's own "can manage this supply" check
    // passes, so it's the tenant plugin that refuses: its tenant field rejects a site the user isn't in, after
    // Kitting gives the movement its supply's site, and its access hides other sites' rows from updates.
    await expect(create('supply-recipes', { tenant: siteB.id, name: 'Sneak', key: `sneak-${run().toLowerCase()}`, lines: [{ item: b.tube.id, quantity: 1 }] }, as(staffA))).rejects.toThrow(/invalid: tenant/)
    await expect(create('supply-movements', { item: b.swab.id, kind: 'used', quantity: 1, tenant: siteA.id }, as(staffA))).rejects.toThrow(/Assigned Tenant/)
    await expect(create('supply-movements', { item: b.swab.id, kind: 'used', quantity: 1 }, as(staffA))).rejects.toThrow(/Assigned Tenant/)
    await expect(payload.update({ collection: 'supply-items' as never, id: b.swab.id, data: { name: 'Renamed' } as never, ...as(staffA) })).rejects.toThrow(/not allowed/)
    // A site A recipe naming site B's supply: Kitting's own check.
    await expect(create('supply-recipes', { tenant: siteA.id, name: 'Mixed', key: `mixed-${run().toLowerCase()}`, lines: [{ item: b.swab.id, quantity: 1 }] }, as(staffA))).rejects.toThrow(/belongs to another tenant/)
    const swabB = await get('supply-items', b.swab.id)
    expect([swabB.name, swabB.onHand]).toEqual(['Swab', 19])
    // Kitting's functions refuse references across sites.
    await expect(applyRecipe(payload, { id: b.recipe.id }, 1, { scope: siteA.id, user: { id: staffA.id } })).rejects.toThrow(/somewhere else/)
    await expect(buildUnits(payload, { id: b.recipe.id }, [`X-${run()}`], { scope: siteA.id })).rejects.toThrow(/somewhere else/)
    await expect(applyRecipe(payload, { key: b.key }, 1, { scope: siteA.id })).rejects.toThrow(/No recipe/)
    const [bUnit] = (await payload.find({ collection: 'assembled-units' as never, where: { recipe: { equals: b.recipe.id } }, depth: 0 })).docs as Doc[]
    await expect(swapUnit(payload, { reference: 'A order', take: { externalId: bUnit!.externalId }, scope: siteA.id })).rejects.toThrow(/hasn’t been built/)
    expect((await get('supply-items', b.swab.id)).onHand).toBe(19)
  })
})

describe('Restock’s arrivals on Today, with the tenant plugin’s own access', () => {
  it('shows site A’s staff site A’s deliveries and not site B’s, using the query the tenant plugin builds', async () => {
    // Kitting's manage is the tenant plugin's own helper: admins every site, staff `{ tenant: { in: [their sites] } }`.
    const manage: Access = ({ req }) => (req.user ? ((req.user as Doc).role === 'admin' ? true : getTenantAccess({ fieldName: 'tenant', user: req.user as never })) : false)
    const payload = await start('arrivals', KITTING, false, manage)
    const create = (collection: string, data: Doc) => payload.create({ collection: collection as never, data: data as never, depth: 0 }) as Promise<Doc>
    const siteA = await create('tenants', { name: 'Site A' })
    const siteB = await create('tenants', { name: 'Site B' })
    const user = (email: string, role: string, sites: Doc[]) => create('users', { email, password: 'a-long-test-password', role, tenants: sites.map((s) => ({ tenant: s.id })) })
    const staffA = await user('arrivals-a@example.com', 'staff', [siteA])
    const both = await user('arrivals-ab@example.com', 'staff', [siteA, siteB])
    const nobody = await user('arrivals-none@example.com', 'staff', [])
    const admin = await user('arrivals-admin@example.com', 'admin', [])
    // A made-up Restock, shaped like its `arrived`: each order with its site's ID.
    const list = [
      { id: 'po-a', number: 'PO-A', supplier: 'Example Supply (made up)', deliveredAt: '2026-11-10T09:00:00.000Z', scope: siteA.id },
      { id: 'po-b', number: 'PO-B', supplier: 'Example Supply (made up)', deliveredAt: '2026-11-10T10:00:00.000Z', scope: siteB.id },
    ]
    ;(payload.config.custom as Doc).restock = { arrived: async () => list }
    const shown = async (u: Doc) => (await restockArrivals(payload, { req: { user: { ...u, collection: 'users' } as never } })).map((a) => a.number)
    expect(await shown(staffA)).toEqual(['PO-A'])
    expect(await shown(both)).toEqual(['PO-A', 'PO-B'])
    expect(await shown(nobody)).toEqual([])
    expect(await shown(admin)).toEqual(['PO-A', 'PO-B'])
  }, 180_000)
})
