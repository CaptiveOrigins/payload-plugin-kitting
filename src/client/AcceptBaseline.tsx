'use client'

import React, { useState } from 'react'

/** "Keep N ready": sets the recipe's number to keep after the person confirms it. Never automatic. */
export function AcceptBaseline({ recipe, recipeName, value, current, apiRoute }: { recipe: string; recipeName: string; value: number; current: number | null; apiRoute: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')
  if (current === value) return <span>Current number</span>
  const accept = async () => {
    setState('busy')
    try {
      const res = await fetch(`${apiRoute}/kitting/baseline`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipe, value }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setState('error')
        setMessage(data.message ?? 'Not saved.')
        return
      }
      setState('done')
      setMessage(`Saved: keep ${value} ready.`)
      setTimeout(() => window.location.reload(), 800)
    } catch {
      setState('error')
      setMessage('Couldn’t reach the server. Not saved.')
    }
  }
  return (
    <span>
      <button type="button" className="btn btn--style-secondary btn--size-small" style={{ margin: 0 }} disabled={state === 'busy' || state === 'done'} onClick={accept} aria-label={`Keep ${value} ready for ${recipeName}`}>
        {state === 'busy' ? 'Saving…' : `Use ${value}`}
      </button>
      <span role={state === 'error' ? 'alert' : 'status'} style={{ display: 'block', fontSize: 13 }}>
        {message}
      </span>
    </span>
  )
}
