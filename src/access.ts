import type { Where } from 'payload'
import { validOperatorSet } from 'payload/shared'

const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0

/**
 * A well-formed, non-empty Payload query: every key is `and`/`or` with a list of queries, or a field with an object
 * of known operators. Payload quietly skips a malformed constraint (`{ tenant: false }`), which would match every
 * row, so anything else is not a query.
 */
export function isWhere(w: unknown): w is Where {
  if (!plain(w)) return false
  return Object.entries(w).every(([key, value]) =>
    key === 'and' || key === 'or'
      ? Array.isArray(value) && value.length > 0 && value.every(isWhere)
      : plain(value) && Object.keys(value).every((op) => validOperatorSet.has(op as never)),
  )
}

/**
 * An access answer read strictly: exactly `true`, a well-formed query (the caller's reads must then apply it, with
 * `overrideAccess: false`), or `false` for everything else, a thrown error included.
 */
export async function trueOrWhere(check: () => unknown): Promise<true | Where | false> {
  try {
    const answer = await check()
    if (answer === true) return true
    if (isWhere(answer)) return answer
    return false
  } catch {
    return false
  }
}

/** For an admin view whose reads all apply the person's access: `true` or a query lets them in, anything else doesn't. */
export const mayUse = async (check: () => unknown): Promise<boolean> => (await trueOrWhere(check)) !== false

const siteID = (v: unknown): v is string | number => (typeof v === 'string' && v !== '') || (typeof v === 'number' && Number.isFinite(v))

/**
 * The sites a query allows, when it says nothing but which sites: `{ [scopeField]: { equals: id } }` or
 * `{ [scopeField]: { in: [ids] } }`, alone or combined with `and` (sites in every part) or `or` (sites in any part).
 * Anything else, another field or operator, an object or empty value, or no `scopeField` at all, is `null`: the
 * caller can't tell which rows it allows and must show none.
 */
export function sitesAllowed(where: unknown, scopeField: string | undefined): Set<string> | null {
  if (!isWhere(where)) return null
  const parts: (Set<string> | null)[] = []
  for (const [key, value] of Object.entries(where)) {
    if (key === 'and' || key === 'or') {
      const sets = (value as unknown[]).map((w) => sitesAllowed(w, scopeField))
      if (sets.some((x) => x === null)) return null
      const all = sets as Set<string>[]
      parts.push(key === 'or' ? new Set(all.flatMap((x) => [...x])) : new Set([...all[0]!].filter((id) => all.every((x) => x.has(id)))))
      continue
    }
    if (key !== scopeField) return null
    const ops = Object.entries(value as Record<string, unknown>)
    if (ops.length !== 1) return null
    const [op, arg] = ops[0]!
    if (op === 'equals' && siteID(arg)) parts.push(new Set([String(arg)]))
    else if (op === 'in' && Array.isArray(arg) && arg.every(siteID)) parts.push(new Set(arg.map(String)))
    else return null
  }
  // Several keys in one object are all required, as Payload reads them.
  return new Set([...parts[0]!].filter((id) => parts.every((x) => x!.has(id))))
}
