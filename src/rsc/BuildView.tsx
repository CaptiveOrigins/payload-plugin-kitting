import { DefaultTemplate } from '@payloadcms/next/templates'
import type { AdminViewServerProps, CollectionSlug } from 'payload'
import React from 'react'

import { BuildForm } from '../client/BuildForm.js'
import { describeUse, getItem, num, suppliesOf, shrinkagePercent } from '../stock.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** /admin/supplies/build: scan or type IDs to build units from a recipe. */
export async function BuildView({ initPageResult, params, searchParams }: AdminViewServerProps) {
  const { req, permissions, visibleEntities, locale } = initPageResult
  const o = suppliesOf(req.payload)
  const admin = req.payload.config.routes.admin
  const canManage = req.user ? Boolean(await o.manage({ req } as never)) : false
  const recipes = canManage
    ? ((await req.payload.find({ collection: o.recipes as CollectionSlug, where: { active: { not_equals: false } }, overrideAccess: false, user: req.user, depth: 0, pagination: false, sort: 'name' })).docs as Doc[])
    : []
  const options = []
  for (const r of recipes) {
    const uses: string[] = []
    for (const line of (r.lines ?? []) as Doc[]) {
      if (line.type === 'recipe') {
        const sub = (await req.payload.findByID({ collection: o.recipes as CollectionSlug, id: line.recipe, depth: 0, overrideAccess: true, disableErrors: true })) as Doc | null
        if (sub) uses.push(`${num(line.quantity)} ${line.unit || sub.makesUnit || 'each'} of ${sub.name}`)
        continue
      }
      const item = await getItem(req.payload, o, {}, line.item)
      if (item) uses.push(describeUse({ quantity: num(line.quantity) ?? 0, unit: String(line.unit || item.unit), name: String(item.name), percent: shrinkagePercent(o, item, r, line) }))
    }
    options.push({ id: String(r.id), name: String(r.name), maxPerBatch: num(r.maxPerBatch), uses })
  }
  return (
    <DefaultTemplate i18n={req.i18n} locale={locale} params={params} payload={req.payload} permissions={permissions} req={req} searchParams={searchParams} user={req.user ?? undefined} visibleEntities={visibleEntities}>
      <div className="gutter--left gutter--right" style={{ paddingBlock: 'calc(var(--base) * 2)', display: 'grid', gap: 'calc(var(--base) * 1.5)' }}>
        <div>
          <p style={{ margin: '0 0 4px' }}>
            <a href={`${admin}/supplies`}>Supplies</a>
          </p>
          <h1 style={{ margin: 0 }}>Build</h1>
        </div>
        {!canManage ? (
          <p>You don’t have access to build here.</p>
        ) : (
          <BuildForm recipes={options} apiRoute={req.payload.config.routes.api} unitsHref={`${admin}/collections/${o.units}`} />
        )}
      </div>
    </DefaultTemplate>
  )
}
