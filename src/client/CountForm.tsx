'use client'

import React, { useId, useState } from 'react'

type Row = { id: string; name: string; unit: string; onHand: number; lots: number }

/**
 * A stock count: type what's really there. Only boxes you fill in are saved; each difference becomes
 * one adjustment. Nothing changes until you press Save, and you see the differences first.
 */
export function CountForm({ rows, apiRoute, logHref }: { rows: Row[]; apiRoute: string; logHref: string }) {
  const base = useId()
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string; lines?: string[] } | null>(null)
  const fmt = (n: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 3 }).format(n)
  const entered = rows.flatMap((r) => {
    const v = values[r.id]
    if (v === undefined || v.trim() === '') return []
    const n = Number(v.replace(',', '.'))
    return [{ row: r, counted: n, valid: Number.isFinite(n) && n >= 0 }]
  })
  const invalid = entered.filter((e) => !e.valid)
  const differences = entered.filter((e) => e.valid && e.counted !== e.row.onHand)

  const save = async () => {
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch(`${apiRoute}/kitting/count`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ counts: entered.filter((e) => e.valid).map((e) => ({ item: e.row.id, counted: e.counted })) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) setResult({ ok: false, message: data.message ?? 'Not saved. Nothing was changed.' })
      else {
        const lines = ((data.changed ?? []) as { name: string; unit: string; before: number; after: number }[]).map((c) => `${c.name}: ${fmt(c.before)} → ${fmt(c.after)} ${c.unit}`)
        setResult({ ok: true, message: lines.length ? `Saved ${lines.length} correction${lines.length === 1 ? '' : 's'}.` : 'Everything matched; nothing to correct.', lines })
        setValues({})
      }
    } catch {
      setResult({ ok: false, message: 'Couldn’t reach the server. Nothing was changed; try again.' })
    } finally {
      setBusy(false)
    }
  }

  if (!rows.length) return <p>There are no supplies to count yet. Add your supplies first.</p>
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (!busy && !invalid.length && entered.length) void save()
      }}
      style={{ display: 'grid', gap: 'var(--base)', maxWidth: 760 }}
    >
      <p style={{ margin: 0 }}>Count what’s on the shelf and type it in, in each supply’s own unit. Leave a box empty to skip that supply.</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <caption style={{ textAlign: 'left', padding: '0 0 8px' }}>{rows.length} supplies</caption>
        <thead>
          <tr>
            <th scope="col" style={{ textAlign: 'left', padding: '8px 12px' }}>Supply</th>
            <th scope="col" style={{ textAlign: 'right', padding: '8px 12px' }}>On record</th>
            <th scope="col" style={{ textAlign: 'left', padding: '8px 12px' }}>Counted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const id = `${base}-${r.id}`
            const v = values[r.id] ?? ''
            const n = Number(v.replace(',', '.'))
            const bad = v.trim() !== '' && !(Number.isFinite(n) && n >= 0)
            const diff = v.trim() !== '' && !bad ? n - r.onHand : 0
            return (
              <tr key={r.id} style={{ borderTop: '1px solid var(--theme-elevation-150)' }}>
                <th scope="row" style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 400 }}>
                  <label htmlFor={id}>{r.name}</label>
                  {r.lots > 0 ? <span style={{ display: 'block', fontSize: 13 }}>In {r.lots} lot{r.lots === 1 ? '' : 's'}: a shortfall comes off the oldest first</span> : null}
                </th>
                <td style={{ textAlign: 'right', padding: '8px 12px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {fmt(r.onHand)} {r.unit}
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <input
                    id={id}
                    inputMode="decimal"
                    autoComplete="off"
                    value={v}
                    onChange={(e) => setValues({ ...values, [r.id]: e.target.value })}
                    aria-invalid={bad || undefined}
                    aria-describedby={`${id}-note`}
                    style={{ width: 120, minHeight: 36, fontSize: 16 }}
                  />{' '}
                  <span id={`${id}-note`} style={{ fontSize: 13 }}>
                    {bad ? 'A number, 0 or more' : diff ? `${diff > 0 ? '+' : '−'}${fmt(Math.abs(diff))} ${r.unit}` : r.unit}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p role="status" aria-live="polite" style={{ margin: 0 }}>
        {entered.length === 0
          ? 'Nothing counted yet.'
          : invalid.length
            ? `${invalid.length} box${invalid.length === 1 ? ' needs' : 'es need'} a number, 0 or more.`
            : `${entered.length} counted, ${differences.length} different from the record.`}
      </p>
      <div>
        <button type="submit" className="btn btn--style-primary" style={{ margin: 0 }} disabled={busy || invalid.length > 0 || entered.length === 0}>
          {busy ? 'Saving…' : 'Save the count'}
        </button>
      </div>
      {result && (
        <div role={result.ok ? 'status' : 'alert'} style={{ padding: 12, borderRadius: 4, border: `2px solid ${result.ok ? 'var(--theme-success-500)' : 'var(--theme-error-500)'}` }}>
          <p style={{ margin: 0, fontWeight: 600 }}>{result.message}</p>
          {result.lines?.length ? (
            <ul style={{ margin: '8px 0 0' }}>
              {result.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          ) : null}
          {result.ok && (
            <p style={{ margin: '8px 0 0' }}>
              <a href={logHref}>See them in the stock log</a>
            </p>
          )}
        </div>
      )}
    </form>
  )
}
