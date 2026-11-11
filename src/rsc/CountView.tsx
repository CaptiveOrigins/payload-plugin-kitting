import { DefaultTemplate } from '@payloadcms/next/templates'
import type { AdminViewServerProps, CollectionSlug } from 'payload'
import React from 'react'

import { mayUse } from '../access.js'
import { CountForm } from '../client/CountForm.js'
import { num, suppliesOf } from '../stock.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** /admin/supplies/count: a stock count of every supply the person can manage. */
export async function CountView({ initPageResult, params, searchParams }: AdminViewServerProps) {
  const { req, permissions, visibleEntities, locale } = initPageResult
  const o = suppliesOf(req.payload)
  const admin = req.payload.config.routes.admin
  // `true` or a query (applied by the reads below, which don't override access); anything else, a throw included, is no.
  const canManage = req.user ? await mayUse(() => o.manage({ req } as never)) : false
  const items = canManage
    ? ((await req.payload.find({ collection: o.items as CollectionSlug, where: { retired: { not_equals: true } }, overrideAccess: false, user: req.user, depth: 0, pagination: false, sort: 'name' })).docs as Doc[])
    : []
  const lots = items.some((i) => i.trackLots)
    ? ((await req.payload.find({ collection: o.lots as CollectionSlug, where: { onHand: { greater_than: 0 } }, overrideAccess: false, user: req.user, depth: 0, pagination: false })).docs as Doc[])
    : []
  const rows = items.map((i) => ({
    id: String(i.id),
    name: String(i.name),
    unit: String(i.unit || 'each'),
    onHand: num(i.onHand) ?? 0,
    lots: i.trackLots ? lots.filter((l) => String(l.item) === String(i.id)).length : 0,
  }))
  return (
    <DefaultTemplate i18n={req.i18n} locale={locale} params={params} payload={req.payload} permissions={permissions} req={req} searchParams={searchParams} user={req.user ?? undefined} visibleEntities={visibleEntities}>
      <div className="gutter--left gutter--right" style={{ paddingBlock: 'calc(var(--base) * 2)', display: 'grid', gap: 'calc(var(--base) * 1.5)' }}>
        <div>
          <p style={{ margin: '0 0 4px' }}>
            <a href={`${admin}/supplies`}>Supplies</a>
          </p>
          <h1 style={{ margin: 0 }}>Count stock</h1>
        </div>
        {!canManage ? <p>You don’t have access to count stock here.</p> : <CountForm rows={rows} apiRoute={req.payload.config.routes.api} logHref={`${admin}/collections/${o.movements}`} />}
      </div>
    </DefaultTemplate>
  )
}
