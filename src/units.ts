/**
 * Units and conversions. An item keeps its stock in one unit (its `unit`, for example g). You can
 * enter quantities in any unit of the same kind (kg for g, l for µl) or in one of the item's packs
 * ("1 kg bag" = 1000 g, "box of 100" = 100 each), and Kitting converts once, on the way in.
 */

type Family = 'mass' | 'volume' | 'count'

/** Size of each unit in its family's base (g, ml, each). */
const UNITS: Record<string, { family: Family; size: number }> = {
  mg: { family: 'mass', size: 0.001 },
  g: { family: 'mass', size: 1 },
  kg: { family: 'mass', size: 1000 },
  oz: { family: 'mass', size: 28.349523125 },
  lb: { family: 'mass', size: 453.59237 },
  'µl': { family: 'volume', size: 0.001 },
  ml: { family: 'volume', size: 1 },
  cl: { family: 'volume', size: 10 },
  l: { family: 'volume', size: 1000 },
  'fl oz': { family: 'volume', size: 29.5735295625 },
  each: { family: 'count', size: 1 },
  dozen: { family: 'count', size: 12 },
}

const ALIASES: Record<string, string> = {
  milligram: 'mg',
  milligrams: 'mg',
  gram: 'g',
  grams: 'g',
  gr: 'g',
  kilo: 'kg',
  kilos: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  ounce: 'oz',
  ounces: 'oz',
  pound: 'lb',
  pounds: 'lb',
  lbs: 'lb',
  ul: 'µl',
  'μl': 'µl', // Greek mu
  microlitre: 'µl',
  microlitres: 'µl',
  microliter: 'µl',
  microliters: 'µl',
  millilitre: 'ml',
  millilitres: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  centilitre: 'cl',
  centiliter: 'cl',
  litre: 'l',
  litres: 'l',
  liter: 'l',
  liters: 'l',
  floz: 'fl oz',
  'fl. oz': 'fl oz',
  unit: 'each',
  units: 'each',
  piece: 'each',
  pieces: 'each',
  pcs: 'each',
  pc: 'each',
  ea: 'each',
  item: 'each',
  items: 'each',
}

/** One of an item's packs: a name and how many of the item's unit are in it. */
export type Pack = { name?: unknown; size?: unknown }

export const normalizeUnit = (unit: unknown): string => {
  const s = String(unit ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
  return ALIASES[s] ?? s
}

/** Is this a unit Kitting knows (as opposed to a free-text one like "roll")? */
export const isKnownUnit = (unit: unknown) => normalizeUnit(unit) in UNITS

/**
 * How many of `to` one `from` is, or null when they can't be converted. `packs` are the item's own
 * packs, sized in `to` (the item's unit). Free-text units only convert to themselves.
 */
export function conversionFactor(from: unknown, to: unknown, packs: Pack[] = []): number | null {
  const f = normalizeUnit(from)
  const t = normalizeUnit(to)
  if (!f || f === t) return 1
  const pack = packs.find((p) => normalizeUnit(p.name) === f)
  if (pack) {
    const size = Number(pack.size)
    return Number.isFinite(size) && size > 0 ? size : null
  }
  const a = UNITS[f]
  const b = UNITS[t]
  if (!a || !b || a.family !== b.family) return null
  return a.size / b.size
}

/** The units someone can enter for an item, for help text: its own, the same kind, and its packs. */
export function unitsFor(unit: unknown, packs: Pack[] = []): string[] {
  const own = normalizeUnit(unit)
  const family = UNITS[own]?.family
  const same = family ? Object.keys(UNITS).filter((u) => UNITS[u]!.family === family && u !== own) : []
  return [own || 'each', ...same, ...packs.map((p) => String(p.name ?? '').trim()).filter(Boolean)]
}
