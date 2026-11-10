import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type CollectionConfig, type Field, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { kittingPlugin } from '../src/index.js'

// With a scope field, a Kitting collection that lacks it would fail every scoped query or mix
// sites' records, so startup stops. Made-up config, its own databases.
let mongo: MongoMemoryReplSet
const started: Payload[] = []
const tenantField: Field = { name: 'tenant', type: 'relationship', relationTo: 'tenants', required: true }
const withTenant = (c: CollectionConfig): CollectionConfig => ({ ...c, fields: [tenantField, ...c.fields] })
const all = { items: withTenant, suppliers: withTenant, movements: withTenant, recipes: withTenant, lots: withTenant, units: withTenant, requests: withTenant, boxes: withTenant, postage: withTenant, settings: withTenant }

async function start(key: string, plugin: ReturnType<typeof kittingPlugin>, onInit: () => void) {
  const payload = await getPayload({
    key,
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri(`scope-${key}`) }),
      collections: [{ slug: 'tenants', fields: [{ name: 'name', type: 'text' }] }, { slug: 'users', auth: true, fields: [] }],
      admin: { user: 'users' },
      onInit,
      plugins: [plugin],
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

describe('scope field check at startup', () => {
  it('stops startup, naming each Kitting collection without the scope field, before the host’s own onInit', async () => {
    let hostInit = 0
    const { settings: _s, postage: _p, ...most } = all
    await expect(start('missing', kittingPlugin({ scopeField: 'tenant', overrides: most }), () => void hostInit++)).rejects.toThrow(
      'Kitting: scopeField is "tenant", but postage-rates, kitting-settings have no "tenant" field.',
    )
    expect(hostInit).toBe(0)
  })

  it('starts when every Kitting collection has it, and when there is no scope field, and runs the host’s onInit', async () => {
    let hostInit = 0
    await start('scoped', kittingPlugin({ scopeField: 'tenant', overrides: all }), () => void hostInit++)
    await start('unscoped', kittingPlugin({}), () => void hostInit++)
    expect(hostInit).toBe(2)
  })
})
