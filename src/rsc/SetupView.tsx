import { DefaultTemplate } from '@payloadcms/next/templates'
import type { AdminViewServerProps } from 'payload'
import React from 'react'

import { mayUse } from '../access.js'
import { setupProgress, suppliesOf } from '../stock.js'

/** /admin/supplies/setup: getting started, one step at a time, in plain words. */
export async function SetupView({ initPageResult, params, searchParams }: AdminViewServerProps) {
  const { req, permissions, visibleEntities, locale } = initPageResult
  const o = suppliesOf(req.payload)
  const admin = req.payload.config.routes.admin
  // `true` or a query (setupProgress reads as this person); anything else, a throw included, is no.
  const canManage = req.user ? await mayUse(() => o.manage({ req } as never)) : false
  const p = canManage ? await setupProgress(req.payload, { user: req.user }) : null
  const link = (href: string, text: string) => (
    <a className="btn btn--style-secondary btn--size-small" style={{ margin: '8px 8px 0 0' }} href={href}>
      {text}
    </a>
  )
  const step = (n: number, done: boolean, title: string, body: React.ReactNode) => (
    <li style={{ marginBottom: 'calc(var(--base) * 1.25)' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>
        {n}. {title} <span style={{ fontWeight: 400, fontSize: 15 }}>{done ? '(done)' : '(to do)'}</span>
      </h2>
      {body}
    </li>
  )
  return (
    <DefaultTemplate i18n={req.i18n} locale={locale} params={params} payload={req.payload} permissions={permissions} req={req} searchParams={searchParams} user={req.user ?? undefined} visibleEntities={visibleEntities}>
      <div className="gutter--left gutter--right" style={{ paddingBlock: 'calc(var(--base) * 2)', display: 'grid', gap: 'var(--base)', maxWidth: 760 }}>
        <div>
          <p style={{ margin: '0 0 4px' }}>
            <a href={`${admin}/supplies`}>Supplies</a>
          </p>
          <h1 style={{ margin: 0 }}>Getting started</h1>
        </div>
        {!p ? (
          <p>You don’t have access to set up supplies here.</p>
        ) : (
          <>
            <p style={{ margin: 0 }}>
              Set it up once and carefully, and from then on it keeps track for you. {p.done ? 'You’ve done all three steps.' : `${[p.supplies > 0, p.recipes > 0, p.counted].filter(Boolean).length} of 3 steps done.`}
            </p>
            <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {step(
                1,
                p.supplies > 0,
                'Your supplies',
                <>
                  <p style={{ margin: 0 }}>
                    Everything you buy and use up: beans and cups, or swabs and tubes. Give each the unit you use it in (g, ml, each), the packs you buy it in, and the level where you want a reminder to reorder.
                    {p.supplies > 0 ? ` You have ${p.supplies}.` : ''}
                  </p>
                  {link(`${admin}/collections/${o.items}/create`, 'Add a supply')}
                  {link(`${admin}/collections/${o.suppliers}/create`, 'Add a supplier')}
                </>,
              )}
              {step(
                2,
                p.recipes > 0,
                'What you make',
                <>
                  <p style={{ margin: 0 }}>
                    A recipe says what goes into one of something: a latte, a sample kit. Then making or selling one takes its supplies off stock by itself. Skip this if you only want to track supplies.
                    {p.recipes > 0 ? ` You have ${p.recipes}.` : ''}
                  </p>
                  {link(`${admin}/collections/${o.recipes}/create`, 'Add a recipe')}
                </>,
              )}
              {step(
                3,
                p.counted,
                'A first stock count',
                <>
                  <p style={{ margin: 0 }}>Count what’s really on the shelf, so everything starts from the truth. Do it again whenever you like; each difference is recorded.</p>
                  {link(`${admin}/supplies/count`, 'Count stock')}
                </>,
              )}
            </ol>
            <p style={{ margin: 0 }}>
              Every day after that, the <a href={`${admin}/supplies`}>Supplies overview</a> shows what to buy, what to build and what to use soon.
            </p>
          </>
        )}
      </div>
    </DefaultTemplate>
  )
}
