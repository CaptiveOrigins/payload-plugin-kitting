import type { Endpoint, PayloadRequest } from 'payload'

import { buildUnits, mayManageDoc, voidUnit, type VoidReason } from './build.js'
import { KittingError, suppliesOf } from './stock.js'
import type { ID } from './types.js'

type Body = Record<string, unknown>

const json = (data: unknown, status = 200) => Response.json(data, { status })

/** Run `fn` for someone who may manage the given document, turning Kitting's errors into plain 400s. */
async function guarded(req: PayloadRequest, collection: (o: ReturnType<typeof suppliesOf>) => string, idKey: string, fn: (body: Body) => Promise<unknown>) {
  const o = suppliesOf(req.payload)
  if (!req.user || req.user.collection !== o.userSlug) return json({ message: 'Sign in first.' }, 401)
  const body: Body = typeof req.json === 'function' ? ((await req.json().catch(() => ({}))) as Body) : {}
  const id = body[idKey]
  if (typeof id !== 'string' && typeof id !== 'number') return json({ message: 'Say which one.' }, 400)
  if (!(await mayManageDoc(req, o, collection(o), id as ID))) return json({ message: 'You can’t do that here.' }, 403)
  try {
    return json(await fn(body))
  } catch (error) {
    if (error instanceof KittingError) return json({ code: error.code, message: error.message, shortages: error.shortages ?? [] }, 400)
    req.payload.logger.error({ err: error, msg: 'kitting: request failed' })
    return json({ message: 'Something went wrong; nothing was changed.' }, 500)
  }
}

/** POST /api/kitting/build { recipe, externalIds } and POST /api/kitting/void { unit, reason, returnToStock }. */
export const kittingEndpoints: Endpoint[] = [
  {
    path: '/kitting/build',
    method: 'post',
    handler: (req) =>
      guarded(req, (o) => o.recipes, 'recipe', async (body) => {
        const ids = Array.isArray(body.externalIds) ? body.externalIds : []
        const r = await buildUnits(req.payload, { id: body.recipe as ID }, ids, { req: { user: req.user, payload: req.payload } as PayloadRequest })
        return { recipe: r.recipe, units: r.units.map((u) => ({ id: u.id, externalId: u.externalId })), shortages: r.shortages }
      }),
  },
  {
    path: '/kitting/void',
    method: 'post',
    handler: (req) =>
      guarded(req, (o) => o.units, 'unit', async (body) => {
        const reason = (['dud', 'damaged', 'mistake', 'other'].includes(String(body.reason)) ? body.reason : 'other') as VoidReason
        const unit = await voidUnit(req.payload, body.unit as ID, { reason, note: typeof body.note === 'string' ? body.note : undefined, returnToStock: body.returnToStock === true, req: { user: req.user, payload: req.payload } as PayloadRequest })
        return { unit: { id: unit.id, externalId: unit.externalId, status: unit.status } }
      }),
  },
]
