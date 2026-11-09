import { DefaultTemplate } from '@payloadcms/next/templates'
import type { AdminViewServerProps, Payload, PayloadRequest } from 'payload'
import React from 'react'

import { sendPendingAlerts, stockReport, suppliesOf, writeOffExpired, type StockRow } from '../stock.js'

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
  const access = await suppliesOf(req.payload).read({ req } as never)
  return Boolean(access)
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
                <li><a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.movements}/create`}>Record a movement</a></li>
                <li><a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.items}/create`}>Add a supply</a></li>
                <li><a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.recipes}`}>Recipes</a></li>
                <li><a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.suppliers}`}>Suppliers</a></li>
                <li><a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.units}`}>Built units</a></li>
                <li><a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.lots}`}>Lots</a></li>
                <li><a className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} href={`${admin}/collections/${o.movements}`}>Stock log</a></li>
              </ul>
            </nav>

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

            {expiring.length > 0 && (
              <section aria-labelledby="supplies-expiring">
                <h2 id="supplies-expiring" style={{ marginTop: 0 }}>Use soon ({expiring.length})</h2>
                <table style={table}>
                  <caption style={caption}>Lots past or near their use-by date, first to expire first. They’re used first; expired ones are written off as waste.</caption>
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
