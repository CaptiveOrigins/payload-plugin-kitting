'use client'

import React, { useId, useRef, useState } from 'react'

type Recipe = { id: string; name: string; maxPerBatch: number | null; uses: string[] }
type Result = { ok: true; message: string; built: string[]; warnings: string[] } | { ok: false; message: string }

/**
 * The builder: choose what you're building, then scan or type each unit's ID. A barcode scanner
 * that types and presses Enter works as is. Building takes the supplies off stock in one go.
 */
export function BuildForm({ recipes, apiRoute, unitsHref }: { recipes: Recipe[]; apiRoute: string; unitsHref: string }) {
  const [recipeID, setRecipeID] = useState(recipes[0]?.id ?? '')
  const [ids, setIds] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const base = useId()
  const recipe = recipes.find((r) => r.id === recipeID)
  const max = recipe?.maxPerBatch ?? null

  const add = () => {
    const id = draft.trim()
    if (!id) return
    if (ids.includes(id)) setStatus(`${id} is already in this batch.`)
    else if (max !== null && ids.length >= max) setStatus(`This recipe is built at most ${max} at a time. Build these first.`)
    else {
      setIds([...ids, id])
      setStatus(`Added ${id}. ${ids.length + 1} in this batch.`)
    }
    setDraft('')
    input.current?.focus()
  }

  const remove = (id: string) => {
    setIds(ids.filter((x) => x !== id))
    setStatus(`Removed ${id}. ${ids.length - 1} in this batch.`)
    input.current?.focus()
  }

  const build = async () => {
    if (!ids.length || !recipeID) return
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch(`${apiRoute}/kitting/build`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipe: recipeID, externalIds: ids }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) setResult({ ok: false, message: data.message ?? 'The build didn’t go through. Nothing was changed.' })
      else {
        const warnings = ((data.shortages ?? []) as { name: string; short: number; unit: string }[]).map((s) => `${s.name} went ${s.short} ${s.unit} below zero. Check the count.`)
        setResult({ ok: true, message: `Built ${data.units.length} × ${data.recipe.name}. The supplies are off stock.`, built: data.units.map((u: { externalId: string }) => u.externalId), warnings })
        setIds([])
        setStatus('')
      }
    } catch {
      setResult({ ok: false, message: 'Couldn’t reach the server. Nothing was changed; try again.' })
    } finally {
      setBusy(false)
      input.current?.focus()
    }
  }

  if (!recipes.length) return <p>There are no recipes in use yet. Add one first: it says what goes into each unit.</p>

  return (
    <div style={{ display: 'grid', gap: 'var(--base)', maxWidth: 640 }}>
      <div>
        <label htmlFor={`${base}-recipe`} style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
          What are you building?
        </label>
        <select id={`${base}-recipe`} value={recipeID} onChange={(e) => setRecipeID(e.target.value)} disabled={ids.length > 0} aria-describedby={`${base}-uses`} style={{ minHeight: 40, minWidth: 280, fontSize: 16 }}>
          {recipes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <p id={`${base}-uses`} style={{ margin: '4px 0 0', fontSize: 14 }}>
          {recipe?.uses.length ? `Each one uses ${recipe.uses.join('; ')}.` : ''}
          {max !== null ? ` At most ${max} at a time.` : ''}
          {ids.length > 0 ? ' Build or clear this batch to change it.' : ''}
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <label htmlFor={`${base}-id`} style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
          Scan or type an ID, then press Enter
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input ref={input} id={`${base}-id`} value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off" autoFocus spellCheck={false} style={{ minHeight: 40, fontSize: 16, flex: 1 }} />
          <button type="submit" className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }}>
            Add
          </button>
        </div>
      </form>

      <p role="status" aria-live="polite" style={{ margin: 0, minHeight: '1.5em' }}>
        {status}
      </p>

      <section aria-labelledby={`${base}-batch`}>
        <h2 id={`${base}-batch`} style={{ margin: '0 0 8px', fontSize: 18 }}>
          This batch ({ids.length})
        </h2>
        {ids.length === 0 ? (
          <p style={{ margin: 0 }}>Nothing scanned yet.</p>
        ) : (
          <ol style={{ margin: 0, paddingInlineStart: 24 }}>
            {ids.map((id) => (
              <li key={id} style={{ marginBottom: 4 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 15 }}>{id}</span>{' '}
                <button type="button" onClick={() => remove(id)} aria-label={`Remove ${id}`} className="btn btn--style-secondary btn--size-small" style={{ margin: '0 0 0 8px' }}>
                  Remove
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={build} disabled={busy || ids.length === 0} className="btn btn--style-primary" style={{ margin: 0 }}>
          {busy ? 'Building…' : `Build ${ids.length || ''}`.trim()}
        </button>
        {ids.length > 0 && (
          <button type="button" onClick={() => (setIds([]), setStatus('Batch cleared.'))} className="btn btn--style-secondary" style={{ margin: 0 }}>
            Clear
          </button>
        )}
      </div>

      {result && (
        <div role={result.ok ? 'status' : 'alert'} style={{ padding: 12, borderRadius: 4, border: `2px solid ${result.ok ? 'var(--theme-success-500)' : 'var(--theme-error-500)'}` }}>
          <p style={{ margin: 0, fontWeight: 600 }}>{result.message}</p>
          {result.ok && result.warnings.length > 0 && (
            <ul style={{ margin: '8px 0 0' }}>
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {result.ok && (
            <p style={{ margin: '8px 0 0' }}>
              {result.built.join(', ')}. <a href={unitsHref}>See built units</a>
            </p>
          )}
        </div>
      )}
    </div>
  )
}
