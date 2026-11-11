import { DefaultTemplate } from '@payloadcms/next/templates'
import type { AdminViewServerProps, Payload, PayloadRequest } from 'payload'
import React from 'react'

import type { CollectionSlug } from 'payload'

import { mayUse } from '../access.js'
import { recommendReadyStock } from '../build.js'
import { AcceptBaseline } from '../client/AcceptBaseline.js'
import { readyStatus, STATE_TEXT, type ReadyStatus } from '../readystock.js'
import { restockArrivals } from '../restock.js'
import { sendPendingAlerts, setupProgress, stockReport, suppliesOf, writeOffExpired, type StockRow } from '../stock.js'
import type { Recommendation } from '../stocklevel.js'

const METHOD_NAMES: Record<string, string> = {
  statistical: 'Safety stock',
  multiplier: 'Days of cover',
  minmax: 'Minimum and maximum',
  trend: 'Following the trend',
  manual: 'A fixed number',
}

const fmt = new Intl.NumberFormat('en', { maximumFractionDigits: 3 })
const qty = (n: number | null, unit: string) => (n === null ? '—' : `${fmt.format(n)} ${unit}`)
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en', { dateStyle: 'medium' }) : '')

const emailText = (r: StockRow) => {
  switch (r.alertStatus) {
    case 'sent':
      return `Emailed ${day(r.alertAt)}`
    case 'not-sent':
      return `Not emailed: ${r.alertNote ?? 'email is off'}`
    case 'failed':
      return `Email failed${r.alertNote ? `: ${r.alertNote}` : ''}`
    case 'pending':
    case 'sending':
      return 'Email waiting to send'
    default:
      return ''
  }
}

async function allowed(req: PayloadRequest) {
  if (!req.user) return false
  // `true` or a query (the reads below apply it); anything else, a throw included, is no.
  return mayUse(() => suppliesOf(req.payload).read({ req } as never))
}

const cell: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid var(--theme-elevation-150)', textAlign: 'left', verticalAlign: 'top' }
const num: React.CSSProperties = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 14 }
const caption: React.CSSProperties = { captionSide: 'top', textAlign: 'left', padding: '0 0 8px', color: 'var(--theme-elevation-800)' }

/** /admin/supplies: what's below level grouped by supplier (the reorder list), then all stock. */
export async function SuppliesView({ initPageResult, params, searchParams }: AdminViewServerProps) {
  const { req, permissions, visibleEntities, locale } = initPageResult
  const o = suppliesOf(req.payload)
  const admin = req.payload.config.routes.admin
  const ok = await allowed(req)
  // A safety net: alerts left pending (for example by a caller's transaction) go out now.
  if (ok && o.autoWriteOff) await writeOffExpired(req.payload).catch((error) => req.payload.logger.error({ err: error, msg: 'kitting: expired lots not written off' }))
  if (ok) await sendPendingAlerts(req.payload).catch((error) => req.payload.logger.error({ err: error, msg: 'kitting: pending alerts not sent' }))
  const { rows, below, expiring } = ok ? await stockReport(req.payload, { user: req.user }) : { rows: [], below: [], expiring: [] }
  // Ready stock: recipes with a number to keep, or with built units.
  const canManage = ok && (await mayUse(() => o.manage({ req } as never)))
  const recipes = ok
    ? ((await req.payload.find({ collection: o.recipes as CollectionSlug, where: { active: { not_equals: false } }, overrideAccess: false, user: req.user, depth: 0, pagination: false, sort: 'name' })).docs as Record<string, any>[]) // eslint-disable-line @typescript-eslint/no-explicit-any
    : []
  const ready: { status: ReadyStatus; recs: Recommendation[]; waiting: number }[] = []
  for (const r of recipes) {
    const built = await req.payload.count({ collection: o.units as CollectionSlug, where: { recipe: { equals: r.id } }, overrideAccess: true })
    if (!built.totalDocs && typeof r.readyStock?.baseline !== 'number') continue
    const waiting = (await req.payload.find({ collection: o.requests as CollectionSlug, where: { and: [{ recipe: { equals: r.id } }, { status: { equals: 'open' } }] }, overrideAccess: true, depth: 0, pagination: false })).docs.reduce(
      (t, q) => t + (Number((q as { count?: number }).count ?? 0) - Number((q as { filled?: number }).filled ?? 0)),
      0,
    )
    ready.push({ status: await readyStatus(req.payload, r), recs: (await recommendReadyStock(req.payload, r.id)).recommendations, waiting })
  }
  const setup = canManage ? await setupProgress(req.payload, { user: req.user }) : null
  // With Restock installed: deliveries waiting for someone to confirm (crossing kitting-restock). Never adds stock.
  const restock = req.payload.config.custom?.restock as { orders?: string } | undefined
  const arrivals = canManage ? await restockArrivals(req.payload, { req }) : []
  const toBuild = ready.filter((x) => x.status.state === 'build-more' || x.status.state === 'urgent')
  const waitingTotal = ready.reduce((t, x) => t + x.waiting, 0)
  const current = rows.filter((r) => !r.retired)
  const retired = rows.filter((r) => r.retired)
  const showScope = Boolean(o.scopeField) && new Set(rows.map((r) => String(r.scope))).size > 1
  const scopeLabel = o.scopeField ? o.scopeField.charAt(0).toUpperCase() + o.scopeField.slice(1) : ''
  const link = (r: StockRow) => <a href={`${admin}/collections/${o.items}/${r.id}`}>{r.name}</a>

  const bySupplier = new Map<string, { name: string; supplier: StockRow['supplier']; rows: StockRow[] }>()
  for (const r of below) {
    const key = `${r.scope ?? ''}|${r.supplier?.id ?? ''}`
    const group = bySupplier.get(key) ?? { name: r.supplier?.name || 'No supplier set', supplier: r.supplier, rows: [] }
    group.rows.push(r)
    bySupplier.set(key, group)
  }
  const groups = [...bySupplier.values()].sort((a, b) => (a.supplier ? 0 : 1) - (b.supplier ? 0 : 1) || a.name.localeCompare(b.name))

  const allTable = (list: StockRow[], title: string) => (
    <table style={table}>
      <caption style={caption}>{title}</caption>
      <thead>
        <tr>
          <th scope="col" style={cell}>Supply</th>
          {showScope && <th scope="col" style={cell}>{scopeLabel}</th>}
          <th scope="col" style={cell}>SKU</th>
          <th scope="col" style={num}>On hand</th>
          <th scope="col" style={num}>Low-stock level</th>
          <th scope="col" style={cell}>Status</th>
        </tr>
      </thead>
      <tbody>
        {list.map((r) => (
          <tr key={String(r.id)}>
            <th scope="row" style={{ ...cell, fontWeight: 400 }}>{link(r)}</th>
            {showScope && <td style={cell}>{r.scopeName ?? String(r.scope ?? '')}</td>}
            <td style={cell}>{r.sku ?? ''}</td>
            <td style={num}>{qty(r.onHand, r.unit)}</td>
            <td style={num}>{r.retired ? '—' : qty(r.lowStockLevel, r.unit)}</td>
            <td style={cell}>{r.retired ? 'No longer used' : r.below ? <strong>Below level</strong> : r.lowStockLevel === null ? 'No alerts set' : 'OK'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )

  return (
    <DefaultTemplate i18n={req.i18n} locale={locale} params={params} payload={req.payload} permissions={permissions} req={req} searchParams={searchParams} user={req.user ?? undefined} visibleEntities={visibleEntities}>
      <div className="gutter--left gutter--right" style={{ paddingBlock: 'calc(var(--base) * 2)', display: 'grid', gap: 'calc(var(--base) * 1.5)', maxWidth: 1100 }}>
        <h1 style={{ margin: 0 }}>Supplies</h1>
        {!ok ? (
          <p>You don’t have access to supplies.</p>
        ) : (
          <>
            <nav aria-label="Supplies actions">
              <ul style={{ display: 'flex', gap: 8, flexWrap: 'wrap', listStyle: 'none', padding: 0, margin: 0 }}>
                <li><a className="btn btn--style-primary btn--size-small" style={{ margin: 0 }} href={`${admin}/supplies/build`}>Build</a></li>
                <li><a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/supplies/count`}>Count stock</a></li>
                <li><a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.movements}/create`}>Record a movement</a></li>
                <li><a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.items}/create`}>Add a supply</a></li>
                <li><a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.recipes}`}>Recipes</a></li>
                <li><a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.suppliers}`}>Suppliers</a></li>
                <li><a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.units}`}>Built units</a></li>
                <li><a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.requests}`}>Build requests</a></li>
                {!o.boxSource && <li><a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.boxes}`}>Boxes</a></li>}
                <li><a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.lots}`}>Lots</a></li>
                <li><a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.movements}`}>Stock log</a></li>
                <li><a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.settings}`}>Settings</a></li>
              </ul>
            </nav>

            {setup && !setup.done && (
              <p style={{ margin: 0, padding: 12, borderRadius: 4, border: '1px solid var(--theme-elevation-300)' }}>
                {[setup.supplies > 0, setup.recipes > 0, setup.counted].filter(Boolean).length} of 3 setup steps done. <a href={`${admin}/supplies/setup`}>Finish getting started</a>
              </p>
            )}

            <section aria-labelledby="supplies-today">
              <h2 id="supplies-today" style={{ marginTop: 0 }}>Today</h2>
              <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                {arrivals.length > 0 && (
                  <li>
                    <strong>Arrived, please confirm:</strong>{' '}
                    {arrivals.map((a, i) => (
                      <React.Fragment key={String(a.id)}>
                        {i ? ', ' : ''}
                        <a href={`${admin}/collections/${restock?.orders ?? 'purchase-orders'}/${String(a.id)}`}>
                          {a.number}
                          {a.supplier ? ` from ${a.supplier}` : ''}
                        </a>
                      </React.Fragment>
                    ))}
                    . Nothing is added to stock until someone checks the boxes.
                  </li>
                )}
                <li>
                  {below.length ? (
                    <a href="#supplies-reorder">
                      Buy: {below.length} suppl{below.length === 1 ? 'y' : 'ies'} below level, from {groups.length} supplier{groups.length === 1 ? '' : 's'}
                    </a>
                  ) : (
                    'Buy: nothing is below its level'
                  )}
                </li>
                {ready.length > 0 && (
                  <li>
                    {toBuild.length || waitingTotal ? (
                      <a href="#supplies-ready">
                        Build: {[...toBuild.map((x) => `${x.status.toBuild} × ${x.status.recipe.name}${x.status.state === 'urgent' ? ' (urgent: supplies low)' : ''}`), ...(waitingTotal ? [`${waitingTotal} waiting for orders`] : [])].join('; ')}
                      </a>
                    ) : (
                      'Build: enough ready'
                    )}
                  </li>
                )}
                <li>{expiring.length ? <a href="#supplies-expiring">Use soon: {expiring.length} lot{expiring.length === 1 ? '' : 's'} near or past use-by</a> : 'Use soon: nothing near its use-by date'}</li>
              </ul>
            </section>

            <section aria-labelledby="supplies-reorder">
              <h2 id="supplies-reorder" style={{ marginTop: 0 }}>Below level{below.length ? ` (${below.length})` : ''}</h2>
              {below.length === 0 ? (
                <p>Nothing is below its level.</p>
              ) : (
                <>
                  <p style={{ marginTop: 0 }}>Your reorder list, by supplier. The suggestion is the item’s reorder quantity, or enough to get back to its level if that’s more.</p>
                  {groups.map((g) => (
                    <section key={`${g.name}-${String(g.rows[0]?.scope ?? '')}`} aria-label={`Reorder from ${g.name}`} style={{ marginBottom: 'var(--base)' }}>
                      <h3 style={{ margin: '0 0 4px' }}>{g.name}</h3>
                      {g.supplier && (g.supplier.email || g.supplier.phone || g.supplier.website) && (
                        <p style={{ margin: '0 0 8px' }}>
                          {[
                            g.supplier.email && <a key="e" href={`mailto:${g.supplier.email}`}>{g.supplier.email}</a>,
                            g.supplier.phone && <a key="p" href={`tel:${g.supplier.phone.replace(/[^+\d]/g, '')}`}>{g.supplier.phone}</a>,
                            g.supplier.website && <a key="w" href={/^https?:\/\//.test(g.supplier.website) ? g.supplier.website : `https://${g.supplier.website}`} rel="noreferrer noopener" target="_blank">{g.supplier.website}</a>,
                          ]
                            .filter(Boolean)
                            .flatMap((el, i) => (i ? [' · ', el] : [el]))}
                        </p>
                      )}
                      <table style={table}>
                        <caption style={{ ...caption, position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Below level at {g.name}</caption>
                        <thead>
                          <tr>
                            <th scope="col" style={cell}>Supply</th>
                            {showScope && <th scope="col" style={cell}>{scopeLabel}</th>}
                            <th scope="col" style={num}>On hand</th>
                            <th scope="col" style={num}>Level</th>
                            <th scope="col" style={num}>Suggested reorder</th>
                            <th scope="col" style={cell}>Since</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.rows.map((r) => (
                            <tr key={String(r.id)}>
                              <th scope="row" style={{ ...cell, fontWeight: 400 }}>
                                {link(r)}
                                {r.sku ? <span style={{ display: 'block', fontSize: 13 }}>SKU {r.sku}</span> : null}
                              </th>
                              {showScope && <td style={cell}>{r.scopeName ?? String(r.scope ?? '')}</td>}
                              <td style={num}>{qty(r.onHand, r.unit)}</td>
                              <td style={num}>{qty(r.lowStockLevel, r.unit)}</td>
                              <td style={{ ...num, fontWeight: 600 }}>{qty(r.suggestedReorder, r.unit)}</td>
                              <td style={cell}>
                                {day(r.belowLevelSince)}
                                {emailText(r) ? <span style={{ display: 'block', fontSize: 13 }}>{emailText(r)}</span> : null}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </section>
                  ))}
                </>
              )}
            </section>

            {ready.length > 0 && (
              <section aria-labelledby="supplies-ready">
                <h2 id="supplies-ready" style={{ marginTop: 0 }}>Ready stock</h2>
                {ready.map(({ status, recs, waiting }) => (
                  <section key={String(status.recipe.id)} aria-label={`Ready stock: ${status.recipe.name}`} style={{ marginBottom: 'var(--base)' }}>
                    <h3 style={{ margin: '0 0 4px' }}>
                      <a href={`${admin}/collections/${o.recipes}/${status.recipe.id}`}>{status.recipe.name}</a>
                      {status.state ? <span style={{ fontWeight: 400 }}>: {status.state === 'urgent' ? <strong>{STATE_TEXT[status.state]}</strong> : STATE_TEXT[status.state]}</span> : null}
                    </h3>
                    <p style={{ margin: '0 0 8px' }}>
                      {status.ready} ready{status.baseline !== null ? `, keeping ${status.baseline}` : ', no number to keep set yet'}
                      {status.toBuild ? `. Build ${status.toBuild}` : ''}
                      {`. Supplies for ${status.canBuild} more`}
                      {waiting ? `. ${waiting} waiting for orders` : ''}.
                      {status.reasons.length ? ` Low: ${status.reasons.join('; ')}.` : ''}
                    </p>
                    <table style={table}>
                      <caption style={caption}>How many to keep ready, by each method. Nothing changes until you choose one.</caption>
                      <thead>
                        <tr>
                          <th scope="col" style={cell}>Method</th>
                          <th scope="col" style={num}>Keep</th>
                          <th scope="col" style={cell}>Why</th>
                          {canManage && <th scope="col" style={cell}><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Action</span></th>}
                        </tr>
                      </thead>
                      <tbody>
                        {recs.filter((rec, i) => i === 0 || !rec.fallback).map((rec, i) => (
                          <tr key={rec.method}>
                            <th scope="row" style={{ ...cell, fontWeight: i === 0 ? 600 : 400 }}>
                              {METHOD_NAMES[rec.method]}
                              {i === 0 ? <span style={{ display: 'block', fontSize: 13, fontWeight: 400 }}>Chosen for this recipe</span> : null}
                            </th>
                            <td style={num}>{rec.target ?? '—'}</td>
                            <td style={cell}>{rec.explanation}</td>
                            {canManage && (
                              <td style={cell}>
                                {rec.target !== null ? <AcceptBaseline recipe={String(status.recipe.id)} recipeName={status.recipe.name} value={rec.target} current={status.baseline} apiRoute={req.payload.config.routes.api} /> : null}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {recs.some((rec, i) => i > 0 && rec.fallback) ? (
                      <p style={{ margin: '8px 0 0', fontSize: 13 }}>Not shown until they have what they need (more sales history, or a minimum and maximum): {recs.filter((rec, i) => i > 0 && rec.fallback).map((rec) => METHOD_NAMES[rec.method]).join(', ')}.</p>
                    ) : null}
                  </section>
                ))}
              </section>
            )}

            {expiring.length > 0 && (
              <section aria-labelledby="supplies-expiring">
                <h2 id="supplies-expiring" style={{ marginTop: 0 }}>Use soon ({expiring.length})</h2>
                <table style={table}>
                  <caption style={caption}>Lots past or near their use-by date, first to expire first. They’re used first; expired ones are written off as shrinkage.</caption>
                  <thead>
                    <tr>
                      <th scope="col" style={cell}>Supply</th>
                      <th scope="col" style={cell}>Lot</th>
                      <th scope="col" style={num}>On hand</th>
                      <th scope="col" style={cell}>Use by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expiring.map((l) => (
                      <tr key={String(l.id)}>
                        <th scope="row" style={{ ...cell, fontWeight: 400 }}>{link(l.item)}</th>
                        <td style={cell}><a href={`${admin}/collections/${o.lots}/${l.id}`}>{l.lotNumber ?? 'No number'}</a></td>
                        <td style={num}>{qty(l.onHand, l.item.unit)}</td>
                        <td style={cell}>{l.expired ? <strong>Expired {day(l.expiresOn)}</strong> : day(l.expiresOn)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            <section aria-labelledby="supplies-all">
              <h2 id="supplies-all" style={{ marginTop: 0 }}>All supplies</h2>
              {current.length === 0 ? <p>No supplies yet. Add the first one, with what you have now as its opening stock.</p> : allTable(current, `${current.length} in use`)}
              {retired.length > 0 && (
                <details style={{ marginTop: 'var(--base)' }}>
                  <summary>No longer used ({retired.length})</summary>
                  {allTable(retired, 'Kept for their history')}
                </details>
              )}
            </section>
          </>
        )}
      </div>
    </DefaultTemplate>
  )
}

/** Nav link to the overview, for people who can see supplies. */
export async function SuppliesNavLink({ payload, user }: { payload: Payload; user?: unknown }) {
  if (!user) return null
  const access = await suppliesOf(payload).read({ req: { user, payload } } as never)
  if (!access) return null
  return (
    <a className="nav__link" href={`${payload.config.routes.admin}/supplies`} style={{ display: 'block', marginTop: 'calc(var(--base) / 2)' }}>
      <span className="nav__link-label">Supplies overview</span>
    </a>
  )
}
