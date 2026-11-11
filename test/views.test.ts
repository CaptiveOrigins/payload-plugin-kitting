import { describe, expect, it, vi } from 'vitest'

// Payload's admin shell and UI kit are stubbed, and the stock report is empty: this checks each view's access
// decision (and that the reads behind it run only when it says yes), not its rendering in a real admin.
vi.mock('@payloadcms/next/templates', () => ({ DefaultTemplate: ({ children }: { children: unknown }) => children }))
vi.mock('@payloadcms/ui', () => ({ Button: () => null, toast: {}, useConfig: () => ({ config: { routes: { api: '/api' } } }) }))
vi.mock('../src/stock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/stock.js')>()),
  stockReport: async () => ({ rows: [], below: [], expiring: [] }),
  sendPendingAlerts: async () => undefined,
}))

const { BuildView, CountView, SetupView, SuppliesView } = await import('../src/rsc/index.js')

/** All the text in a React element tree. */
const text = (node: unknown): string => {
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  return text((node as { props?: { children?: unknown } }).props?.children)
}

/** A made-up Payload that answers every read with nothing, and remembers which collections were read. */
const fakePayload = (manage: unknown, read: unknown = () => true) => {
  const reads: string[] = []
  const payload = {
    config: {
      routes: { admin: '/admin', api: '/api' },
      custom: { kitting: { manage, read, items: 'supply-items', recipes: 'supply-recipes', lots: 'supply-lots', movements: 'supply-movements', units: 'supply-units', requests: 'supply-requests', suppliers: 'supply-suppliers', autoWriteOff: false } },
    },
    find: async ({ collection }: { collection: string }) => (reads.push(collection), { docs: [], totalDocs: 0 }),
    count: async ({ collection }: { collection: string }) => (reads.push(collection), { totalDocs: 0 }),
    logger: { error: () => undefined },
  }
  return { payload, reads }
}
const show = (View: (p: never) => Promise<unknown>, payload: unknown, user: unknown = { id: 'u', collection: 'users' }) =>
  View({ initPageResult: { req: { user, payload, i18n: {} }, permissions: {}, visibleEntities: {}, locale: undefined }, params: {}, searchParams: {} } as never)

const NOT_TRUE: [string, () => unknown][] = [
  ['1', () => 1],
  ["'yes'", () => 'yes'],
  ['an empty object', () => ({})],
  ['a malformed query', () => ({ tenant: false })],
  ['a thrown error', () => {
    throw new Error('roles store down')
  }],
  ['a rejected promise', async () => {
    throw new Error('roles store down')
  }],
]
const SITE_QUERY = () => ({ tenant: { in: ['site-a'] } })

describe('the admin views (test audit 2026-11-11)', () => {
  const views: [string, (p: never) => Promise<unknown>, RegExp][] = [
    ['count', CountView as never, /don’t have access to count/],
    ['build', BuildView as never, /don’t have access to build/],
    ['setup', SetupView as never, /don’t have access to set up/],
  ]

  it('refuses count, build and setup unless manage answers true or a well-formed query, and reads nothing first', async () => {
    for (const [name, View, refusal] of views) {
      for (const [what, answer] of NOT_TRUE) {
        const { payload, reads } = fakePayload(answer)
        expect(text(await show(View, payload)), `${name}: ${what}`).toMatch(refusal)
        expect(reads, `${name}: ${what}`).toEqual([])
      }
      for (const answer of [() => true, SITE_QUERY]) {
        const { payload, reads } = fakePayload(answer)
        expect(text(await show(View, payload)), name).not.toMatch(refusal)
        expect(reads.length, name).toBeGreaterThan(0)
      }
    }
  })

  it('refuses the supplies overview unless read answers true or a query, and keeps the manager-only parts behind manage', async () => {
    for (const [what, answer] of NOT_TRUE) {
      const { payload, reads } = fakePayload(() => true, answer)
      expect(text(await show(SuppliesView as never, payload)), what).toMatch(/don’t have access to supplies/)
      expect(reads, what).toEqual([])
    }
    // Readers in: the manager-only setup counts run only when manage says true or a query.
    for (const [what, answer] of NOT_TRUE) {
      const { payload, reads } = fakePayload(answer, SITE_QUERY)
      expect(text(await show(SuppliesView as never, payload)), what).not.toMatch(/don’t have access/)
      expect(reads, what).not.toContain('supply-items')
    }
    for (const answer of [() => true, SITE_QUERY]) {
      const { payload, reads } = fakePayload(answer, SITE_QUERY)
      await show(SuppliesView as never, payload)
      expect(reads).toContain('supply-items')
    }
  })
})
