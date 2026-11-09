import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { ecommercePlugin } from '@payloadcms/plugin-ecommerce'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildUnits, kittingPlugin } from '../src/index.js'

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
        kittingPlugin({ ecommerce: { enabled: true, skipOrder: (order) => order.customerEmail === 'own-path@example.com' } }),
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
