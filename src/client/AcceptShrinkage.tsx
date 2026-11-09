'use client'

import React, { useState } from 'react'

/** "Use 4%": sets the supply's shrinkage allowance after the person clicks. Never automatic. */
export function AcceptShrinkage({ url, percent, name }: { url: string; percent: number; name: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const accept = async () => {
    setState('busy')
    try {
      const res = await fetch(url, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shrinkagePercent: percent }) })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setState('error')
        setMessage(data?.errors?.[0]?.message ?? 'Not saved.')
        return
      }
      setState('done')
      setMessage(`Saved: ${percent}%. Reloading…`)
      setTimeout(() => window.location.reload(), 800)
    } catch {
      setState('error')
      setMessage('Couldn’t reach the server. Not saved.')
    }
  }
  return (
    <span>
      <button type="button" className="btn btn--style-secondary btn--size-small" style={{ margin: '8px 0 0' }} disabled={state === 'busy' || state === 'done'} onClick={accept} aria-label={`Use ${percent}% shrinkage allowance for ${name}`}>
        {state === 'busy' ? 'Saving…' : `Use ${percent}%`}
      </button>
      <span role={state === 'error' ? 'alert' : 'status'} style={{ display: 'block', fontSize: 13 }}>
        {message}
      </span>
    </span>
  )
}
