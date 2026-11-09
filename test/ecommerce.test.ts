import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { ecommercePlugin } from '@payloadcms/plugin-ecommerce'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildUnits, kittingPlugin, recommendBoxes } from '../src/index.js'

// Kitting with Payload's real ecommerce plugin (no payments), on its own database. Made-up products.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let payload: Payload
let mongo: MongoMemoryReplSet
const yes = () => true

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('kitting-shop'), ensureIndexes: true }),
      collections: [{ slug: 'users', auth: true, fields: [] }],
      admin: { user: 'users' },
      plugins: [
        ecommercePlugin({
          access: { adminOnlyFieldAccess: yes, adminOrPublishedStatus: yes, isAdmin: yes, isDocumentOwner: yes, isAuthenticated: yes, isCustomer: yes, publicAccess: yes },
          customers: { slug: 'users' },
          currencies: { defaultCurrency: 'USD', supportedCurrencies: [{ code: 'USD', decimals: 2, label: 'US Dollar', symbol: '$' }] },
          payments: { paymentMethods: [] },
          products: true,
          orders: true,
          inventory: true,
        }),
        kittingPlugin({
          ecommerce: { enabled: true, skipOrder: (order) => order.customerEmail === 'own-path@example.com' },
          // The host's own box list (as the platform's Kits area keeps one), in ounces and inches.
          boxes: {
            source: async ({ recipe }) =>
              recipe.key === 'shop-kit'
                ? [
                    { id: 'host-big', name: 'Host box', capacity: 10, emptyWeight: 100, maxWeight: 800, dimensions: { length: 12, width: 9, height: 4, unit: 'in' } },
                    { id: 'host-env', name: 'Host envelope', capacity: 1, emptyWeight: 5 },
                  ]
                : [],
          },
        }),
      ],
    }),
  })
}, 180_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

const create = (collection: string, data: Doc) => payload.create({ collection: collection as never, data: data as never, depth: 0 }) as Promise<Doc>
const get = (collection: string, id: unknown) => payload.findByID({ collection: collection as never, id: id as string, depth: 0 }) as Promise<Doc>

describe('with Payload’s ecommerce plugin', () => {
  it('shows ready units as availability, fills new orders, and gives units back when an order is cancelled', async () => {
    const swab = await create('supply-items', { name: 'Shop swab', unit: 'each', openingStock: 50 })
    const recipe = await create('supply-recipes', { name: 'Shop kit', key: 'shop-kit', lines: [{ item: swab.id, quantity: 1 }] })
    const product = await create('products', { title: 'Sample kit', kittingRecipe: recipe.id, inventory: 0, priceInUSD: 1900, _status: 'published' })
    const shirt = await create('products', { title: 'T-shirt', inventory: 9, priceInUSD: 2500, _status: 'published' })
    expect(product.kittingReady ?? null).toBeNull()

    await buildUnits(payload, { id: recipe.id }, ['SHOP-1', 'SHOP-2', 'SHOP-3'])
    expect(await get('products', product.id)).toMatchObject({ kittingReady: 3, inventory: 3 })
    expect((await get('products', shirt.id)).inventory).toBe(9) // not kitted: left alone

    const order = await create('orders', { customerEmail: 'buyer@example.com', status: 'processing', currency: 'USD', amount: 3800, items: [{ product: product.id, quantity: 2 }, { product: shirt.id, quantity: 1 }] })
    const units = async () => ((await payload.find({ collection: 'assembled-units' as never, where: { assignedTo: { equals: `Order ${order.id}` } }, depth: 0 })).docs as Doc[]).map((u) => u.externalId).sort()
    expect(await units()).toEqual(['SHOP-1', 'SHOP-2'])
    expect(await get('products', product.id)).toMatchObject({ kittingReady: 1, inventory: 1 })

    // Saving it again doesn't take more.
    await payload.update({ collection: 'orders' as never, id: order.id, data: { customerNotes: 'leave at the door' } as never })
    expect(await units()).toHaveLength(2)

    // An order for more than is ready queues a build.
    const big = await create('orders', { customerEmail: 'big@example.com', status: 'processing', currency: 'USD', amount: 5700, items: [{ product: product.id, quantity: 3 }] })
    const request = ((await payload.find({ collection: 'build-requests' as never, where: { reference: { equals: `Order ${big.id}` } }, depth: 0 })).docs as Doc[])[0]
    expect(request).toMatchObject({ count: 2, status: 'open' })

    await payload.update({ collection: 'orders' as never, id: order.id, data: { status: 'cancelled' } as never })
    expect(await units()).toEqual([])
    expect((await get('products', product.id)).kittingReady).toBe(2)

    // A host that assigns in its own order path skips those orders.
    const own = await create('orders', { customerEmail: 'own-path@example.com', status: 'processing', currency: 'USD', amount: 1900, items: [{ product: product.id, quantity: 1 }] })
    expect((await payload.count({ collection: 'assembled-units' as never, where: { assignedTo: { equals: `Order ${own.id}` } } })).totalDocs).toBe(0)
  })
})

describe('boxes from the host’s own list', () => {
  it('suggests packings from the source and adds no box collection of its own', async () => {
    expect(payload.collections['box-types' as never]).toBeUndefined()
    const recipe = (await payload.find({ collection: 'supply-recipes' as never, where: { key: { equals: 'shop-kit' } }, depth: 0 })).docs[0] as Doc
    await payload.update({ collection: 'supply-recipes' as never, id: recipe.id, data: { unitWeight: 100 } as never })
    for (const [upToGrams, cost] of [[150, 4], [1000, 11]]) await create('postage-rates', { name: `Up to ${upToGrams} g`, upToGrams, cost })
    const { packings } = await recommendBoxes(payload, { recipe: { key: 'shop-kit' }, count: 5, provider: null })
    // Host box: 10 fit, but 800 g with 100 g empty leaves 7. Five in it weigh 600 g: postage 11.
    expect(packings[0]!.summary).toBe('1 × Host box (5 each): boxes $0.00 + postage $11.00 = $11.00')
    expect((await recommendBoxes(payload, { recipe: { key: 'other' }, count: 1, provider: null }).catch((e) => e)).message).toMatch(/No recipe/)
  })
})
