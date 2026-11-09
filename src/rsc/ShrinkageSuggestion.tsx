import type { Payload } from 'payload'
import React from 'react'

import { AcceptShrinkage } from '../client/AcceptShrinkage.js'
import { idOf, num, siteShrinkage, suggestShrinkagePercent, suppliesOf } from '../stock.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * On a supply's page: the shrinkage allowance learned from what really happened, with the reasoning,
 * and a button to use it. Shown read-only to people who can't change the supply.
 */
export async function ShrinkageSuggestion(props: { id?: string | number; payload: Payload; user?: unknown; data?: Doc }) {
  const { id, payload } = props
  if (id === undefined || id === null) return null
  const o = suppliesOf(payload)
  const item = (await payload.findByID({ collection: o.items as never, id, depth: 0, overrideAccess: true, disableErrors: true })) as Doc | null
  if (!item) return null
  const site = await siteShrinkage(payload, o, {}, o.scopeField ? idOf(item[o.scopeField]) : null)
  const box: React.CSSProperties = { padding: 12, borderRadius: 4, border: '1px solid var(--theme-elevation-150)', marginBottom: 'var(--base)' }
  if (!site.shrinkage.enabled) return <p style={box}>Shrinkage allowances are off for this site (Kitting settings).</p>
  const s = await suggestShrinkagePercent(payload, id)
  const current = num(item.shrinkagePercent) ?? site.shrinkage.defaultPercent
  const canChange = props.user ? Boolean(await o.manage({ req: { user: props.user, payload } } as never)) : false
  return (
    <div style={box} aria-labelledby={`shrinkage-${String(id)}`}>
      <p id={`shrinkage-${String(id)}`} style={{ margin: 0, fontWeight: 600 }}>
        Learned shrinkage: {s.percent === null ? 'not yet' : `about ${s.percent}%`}
        <span style={{ fontWeight: 400 }}> (now {current}%{num(item.shrinkagePercent) === null ? ', the site default' : ''})</span>
      </p>
      <p style={{ margin: '4px 0 0', fontSize: 14 }}>{s.explanation}</p>
      {canChange && s.percent !== null && s.percent !== current ? (
        <AcceptShrinkage url={`${payload.config.routes.api}/${o.items}/${String(id)}`} percent={s.percent} name={String(item.name)} />
      ) : null}
    </div>
  )
}
