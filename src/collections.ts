import type { CollectionAfterChangeHook, CollectionAfterOperationHook, CollectionBeforeChangeHook, CollectionBeforeDeleteHook, CollectionConfig, CollectionSlug, PayloadRequest } from 'payload'

import { ALLOW_DELETE, INTERNAL, alertFields, applyMovementToItem, mayManage, asInternal, idOf, prepareMovement, round, sameID, sendPendingAlerts, KittingError } from './stock.js'
import type { ResolvedSupplies } from './types.js'
import { refreshStockStates } from './readystock.js'
import { STOCK_METHODS } from './stocklevel.js'
import { normalizeUnit } from './units.js'

const OPENING_LOT = 'kittingOpeningLot'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const ALERT_FIELDS = ['belowLevelSince', 'alertStatus', 'alertAt', 'alertNote'] as const

/** After a change made by hand, bring ready-stock states up to date in the same transaction. */
const refreshAfter =
  (o: ResolvedSupplies): CollectionAfterChangeHook =>
  async ({ doc, req }) => {
    if (req.context?.[INTERNAL]) return doc
    await refreshStockStates(req.payload, { req, scope: o.scopeField ? idOf(doc[o.scopeField]) : null })
    return doc
  }
const sys = { overrideAccess: true, depth: 0, joins: false } as const
const never = () => false

/** The alert goes out at the end of the admin's own save, for the items it touched. */
const sendForTouched =
  (pick: (result: Doc) => unknown[]): CollectionAfterOperationHook =>
  async ({ operation, req, result }) => {
    if (req.context?.[INTERNAL] || !result || !['create', 'update', 'updateByID'].includes(operation)) return result
    const ids = pick(result as Doc)
      .map(idOf)
      .filter((id) => id !== null)
    if (ids.length) await sendPendingAlerts(req.payload, { req, ids: ids as (string | number)[] })
    return result
  }

/** Every link inside one owner (site): checked on every write path, including the Local API. */
async function sameScope(req: PayloadRequest, o: ResolvedSupplies, scope: unknown, collection: string, id: unknown, what: string) {
  if (!o.scopeField || idOf(id) === null) return
  const doc = (await req.payload.findByID({ collection: collection as CollectionSlug, id: idOf(id)!, ...sys, disableErrors: true, req })) as Doc | null
  if (!doc) throw new KittingError('notFound', `${what} doesn’t exist.`)
  if (!sameID(doc[o.scopeField], scope)) throw new KittingError('scope', `${what} belongs to another ${o.scopeField}.`)
}

export function itemsCollection(o: ResolvedSupplies): CollectionConfig {
  const beforeChange: CollectionBeforeChangeHook = async ({ data, originalDoc, operation, req }) => {
    const internal = req.context?.[INTERNAL]
    const level = data.lowStockLevel !== undefined ? data.lowStockLevel : originalDoc?.lowStockLevel
    const retired = data.retired !== undefined ? data.retired : originalDoc?.retired
    const effectiveLevel = retired ? null : level
    if (operation === 'create') {
      const opening = typeof data.openingStock === 'number' ? data.openingStock : typeof data.onHand === 'number' ? data.onHand : 0
      if (!Number.isFinite(opening) || opening < 0) throw new KittingError('quantity', 'Opening stock can’t be below zero.')
      data.onHand = round(opening)
      for (const f of ALERT_FIELDS) data[f] = null
      Object.assign(data, alertFields({}, data.onHand, effectiveLevel))
    } else if (!internal) {
      // On hand and alerts change only through movements and the level, never by hand.
      data.onHand = originalDoc?.onHand ?? 0
      for (const f of ALERT_FIELDS) data[f] = originalDoc?.[f] ?? null
      Object.assign(data, alertFields(originalDoc ?? {}, data.onHand, effectiveLevel))
    }
    if (operation === 'create') req.context = { ...req.context, [OPENING_LOT]: { lotNumber: data.openingLotNumber ?? null, expiresOn: data.openingExpiresOn ?? null } }
    delete data.openingStock
    delete data.openingLotNumber
    delete data.openingExpiresOn
    if (data.unit !== undefined) data.unit = normalizeUnit(data.unit) || 'each'
    if (Array.isArray(data.packs))
      for (const p of data.packs as Doc[]) {
        if (!(typeof p.size === 'number' && p.size > 0)) throw new KittingError('pack', `The pack "${p.name ?? ''}" needs a size of more than zero.`)
        if (normalizeUnit(p.name) === normalizeUnit(data.unit ?? originalDoc?.unit)) throw new KittingError('pack', 'A pack can’t have the same name as the unit.')
      }
    if (o.scopeField && data.supplier !== undefined) await sameScope(req, o, data[o.scopeField] ?? originalDoc?.[o.scopeField], o.suppliers, data.supplier, 'That supplier')
    return data
  }
  /** Opening stock is the first line of the item's history, so on hand always equals the sum of its movements. */
  const afterChange: CollectionAfterChangeHook = async ({ doc, operation, req }) => {
    if (operation !== 'create' || !(doc.onHand > 0)) return doc
    const by = req.user && req.user.collection === o.userSlug ? req.user.id : null
    const opening = (req.context?.[OPENING_LOT] ?? {}) as Doc
    await asInternal(req, { opening: true, by }, () =>
      req.payload.create({
        collection: o.movements as CollectionSlug,
        data: { item: doc.id, kind: 'adjusted', quantity: doc.onHand, reason: 'Opening stock', lotNumber: opening.lotNumber, expiresOn: opening.expiresOn } as never,
        ...sys,
        req,
      }),
    )
    return doc
  }
  const beforeDelete: CollectionBeforeDeleteHook = async ({ id, req }) => {
    if (req.context?.[ALLOW_DELETE]) return
    const used = await req.payload.count({ collection: o.movements as CollectionSlug, where: { item: { equals: id } }, overrideAccess: true, req })
    if (used.totalDocs) throw new KittingError('hasHistory', 'This supply has stock history, so it can’t be deleted. Tick “No longer used” instead.')
  }
  return {
    slug: o.items,
    labels: { singular: 'Supply', plural: 'Supplies' },
    admin: {
      group: o.adminGroup,
      useAsTitle: 'name',
      defaultColumns: ['name', 'onHand', 'unit', 'lowStockLevel', 'supplier'],
      description: 'What goes into the things you make. On hand changes only through stock movements.',
    },
    access: { read: o.read, create: o.manage, update: o.manage, delete: o.manage },
    hooks: { beforeChange: [beforeChange], afterChange: [afterChange, refreshAfter(o)], beforeDelete: [beforeDelete], afterOperation: [sendForTouched((r) => (Array.isArray(r.docs) ? r.docs : [r]))] },
    fields: [
      { name: 'name', type: 'text', required: true, label: 'Name' },
      {
        type: 'row',
        fields: [
          {
            name: 'unit',
            type: 'text',
            required: true,
            defaultValue: 'each',
            label: 'Counted in',
            admin: { description: 'The smallest unit you use it in: each, g, ml, µl… Stock is kept in this unit.', width: '50%' },
          },
          { name: 'sku', type: 'text', label: 'SKU or part number', admin: { width: '50%' } },
        ],
      },
      { name: 'supplier', type: 'relationship', relationTo: o.suppliers as CollectionSlug, label: 'Supplier' },
      {
        name: 'packs',
        type: 'array',
        label: 'Packs you buy it in',
        labels: { singular: 'Pack', plural: 'Packs' },
        admin: { description: 'For example a "1 kg bag" of 1000 g, or a "box of 100". You can then enter stock in packs. Units of the same kind (kg for g, l for ml) convert by themselves.' },
        fields: [
          {
            type: 'row',
            fields: [
              { name: 'name', type: 'text', required: true, label: 'Pack name', admin: { width: '60%' } },
              { name: 'size', type: 'number', required: true, min: 0.000001, label: 'How many in one', admin: { width: '40%', description: 'In the unit above.' } },
            ],
          },
        ],
      },
      {
        name: 'openingStock',
        type: 'number',
        virtual: true,
        min: 0,
        label: 'Opening stock',
        admin: { description: 'How many you have now, in the unit above. After this, stock changes only through movements.', condition: (_d, _s, { operation }) => operation === 'create' },
      },
      {
        type: 'row',
        admin: { condition: (d, _s, { operation }) => operation === 'create' && Boolean(d?.trackLots) },
        fields: [
          { name: 'openingLotNumber', type: 'text', virtual: true, label: 'Lot number of that stock', admin: { width: '50%' } },
          { name: 'openingExpiresOn', type: 'date', virtual: true, label: 'Use by', admin: { width: '50%', date: { pickerAppearance: 'dayOnly' } } },
        ],
      },
      {
        name: 'onHand',
        type: 'number',
        defaultValue: 0,
        label: 'On hand',
        admin: { readOnly: true, description: 'Changes only through stock movements.', condition: (_d, _s, { operation }) => operation !== 'create' },
      },
      {
        type: 'row',
        fields: [
          { name: 'lowStockLevel', type: 'number', min: 0, label: 'Low-stock level', admin: { width: '50%', description: 'One email when on hand falls below this. Empty: no alerts.' } },
          { name: 'reorderQuantity', type: 'number', min: 0, label: 'Reorder quantity', admin: { width: '50%', description: 'What you usually order. Empty: enough to get back to the level.' } },
        ],
      },
      {
        name: 'shrinkagePercent',
        type: 'number',
        min: 0,
        max: 100,
        label: 'Shrinkage allowance (%)',
        admin: {
          description: 'Stock lost to damage, spoilage, defects or errors, added to what recipes use. Empty: the site’s default. 0: none for this item. A recipe can set its own.',
        },
      },
      ...(o.adminView
        ? [
            {
              name: 'shrinkageSuggestion',
              type: 'ui' as const,
              admin: { components: { Field: '@extantape/payload-plugin-kitting/rsc#ShrinkageSuggestion' }, condition: (_d: unknown, _s: unknown, { operation }: { operation?: string }) => operation !== 'create' },
            },
          ]
        : []),
      {
        type: 'collapsible',
        label: 'Lots and use-by dates',
        admin: { initCollapsed: false },
        fields: [
          {
            name: 'trackLots',
            type: 'checkbox',
            defaultValue: false,
            label: 'Track lots',
            admin: { description: 'Each delivery becomes a lot with its own number and use-by date. The first to expire is used first, and every build records which lots it used.' },
          },
          {
            type: 'row',
            admin: { condition: (d) => Boolean(d?.trackLots) },
            fields: [
              { name: 'shelfLifeDays', type: 'number', min: 0, label: 'Shelf life (days)', admin: { width: '50%', description: 'Sets the use-by date of a delivery when none is given.' } },
              { name: 'expiryWarningDays', type: 'number', min: 0, label: 'Warn this many days ahead', admin: { width: '50%', description: `Empty: ${o.lotWarningDays}.` } },
            ],
          },
        ],
      },
      { name: 'notes', type: 'textarea', label: 'Notes' },
      { name: 'retired', type: 'checkbox', defaultValue: false, label: 'No longer used', admin: { position: 'sidebar', description: 'Keeps its history; no more alerts.' } },
      { name: 'belowLevelSince', type: 'date', label: 'Below level since', admin: { position: 'sidebar', readOnly: true, date: { pickerAppearance: 'dayAndTime' } } },
      {
        name: 'alertStatus',
        type: 'select',
        label: 'Low-stock email',
        options: [
          { label: 'Waiting to send', value: 'pending' },
          { label: 'Sending', value: 'sending' },
          { label: 'Sent', value: 'sent' },
          { label: 'Not sent', value: 'not-sent' },
          { label: 'Failed', value: 'failed' },
        ],
        admin: { position: 'sidebar', readOnly: true },
      },
      { name: 'alertAt', type: 'date', label: 'Email checked at', admin: { position: 'sidebar', readOnly: true, date: { pickerAppearance: 'dayAndTime' } } },
      { name: 'alertNote', type: 'text', label: 'Email note', admin: { position: 'sidebar', readOnly: true } },
    ],
  }
}

export function suppliersCollection(o: ResolvedSupplies): CollectionConfig {
  return {
    slug: o.suppliers,
    labels: { singular: 'Supplier', plural: 'Suppliers' },
    admin: { group: o.adminGroup, useAsTitle: 'name', defaultColumns: ['name', 'email', 'phone', 'leadTimeDays'] },
    access: { read: o.read, create: o.manage, update: o.manage, delete: o.manage },
    fields: [
      { name: 'name', type: 'text', required: true, label: 'Name' },
      {
        type: 'row',
        fields: [
          { name: 'email', type: 'email', label: 'Order email', admin: { width: '50%' } },
          { name: 'phone', type: 'text', label: 'Phone', admin: { width: '50%' } },
        ],
      },
      { name: 'website', type: 'text', label: 'Website or ordering page' },
      { name: 'leadTimeDays', type: 'number', min: 0, label: 'Usual days to deliver' },
      { name: 'notes', type: 'textarea', label: 'Notes', admin: { description: 'Account details you need to order. Never passwords or card numbers.' } },
    ],
  }
}

export function movementsCollection(o: ResolvedSupplies): CollectionConfig {
  const beforeChange: CollectionBeforeChangeHook = async ({ data, operation, req }) => {
    if (operation !== 'create') throw new KittingError('appendOnly', 'Stock movements can’t be changed. Record an adjustment instead.')
    if (idOf(data.item) === null) throw new KittingError('itemRequired', 'Choose a supply.')
    return prepareMovement(req, data)
  }
  const afterChange: CollectionAfterChangeHook = async ({ doc, operation, req }) => {
    if (operation === 'create') await applyMovementToItem(req, doc)
    return doc
  }
  const beforeDelete: CollectionBeforeDeleteHook = ({ req }) => {
    if (!req.context?.[ALLOW_DELETE]) throw new KittingError('appendOnly', 'Stock movements can’t be deleted. Record an adjustment instead.')
  }
  return {
    slug: o.movements,
    labels: { singular: 'Stock movement', plural: 'Stock movements' },
    admin: {
      group: o.adminGroup,
      defaultColumns: ['createdAt', 'item', 'kind', 'change', 'lot', 'onHandAfter', 'by', 'reference'],
      description: 'The stock log. Each line is permanent: to fix a mistake, record an adjustment.',
    },
    defaultSort: '-createdAt',
    // Append-only, whatever the host's access says. Trusted cleanup scripts pass `kittingAllowDelete`.
    access: { read: o.read, create: o.manage, update: never, delete: never },
    hooks: { beforeChange: [beforeChange], afterChange: [afterChange, refreshAfter(o)], beforeDelete: [beforeDelete], afterOperation: [sendForTouched((r) => [r.item])] },
    fields: [
      { name: 'item', type: 'relationship', relationTo: o.items as CollectionSlug, required: true, label: 'Supply' },
      {
        type: 'row',
        fields: [
          {
            name: 'kind',
            type: 'select',
            required: true,
            defaultValue: 'received',
            label: 'What happened',
            options: [
              { label: 'Received (stock in)', value: 'received' },
              { label: 'Used (stock out)', value: 'used' },
              { label: 'Written off (spoiled, damaged, defective, expired, lost)', value: 'written-off' },
              { label: 'Adjusted (+ or −, for example after a count)', value: 'adjusted' },
            ],
            admin: { width: '40%' },
          },
          {
            name: 'quantity',
            type: 'number',
            required: true,
            label: 'Quantity',
            admin: { width: '30%', description: 'For an adjustment, type −3 to take 3 away.' },
          },
          {
            name: 'unit',
            type: 'text',
            label: 'Unit',
            admin: { width: '30%', description: 'Empty: the supply’s own unit. Or kg, l, or one of its packs.' },
          },
        ],
      },
      {
        name: 'writeOffReason',
        type: 'select',
        label: 'Why it was written off',
        options: [
          { label: 'Spoiled', value: 'spoiled' },
          { label: 'Damaged', value: 'damaged' },
          { label: 'Defective', value: 'defective' },
          { label: 'Expired', value: 'expired' },
          { label: 'Lost', value: 'lost' },
          { label: 'Other', value: 'other' },
        ],
        admin: { condition: (d) => d?.kind === 'written-off' },
      },
      {
        type: 'row',
        admin: { condition: (d, _s, { operation }) => operation === 'create' && d?.kind === 'received' },
        fields: [
          { name: 'lotNumber', type: 'text', virtual: true, label: 'Lot number', admin: { width: '50%', description: 'For supplies with lots tracked.' } },
          { name: 'expiresOn', type: 'date', virtual: true, label: 'Use by', admin: { width: '50%', date: { pickerAppearance: 'dayOnly' } } },
        ],
      },
      {
        name: 'lot',
        type: 'relationship',
        relationTo: o.lots as CollectionSlug,
        label: 'Lot',
        admin: { description: 'Empty: the first to expire that covers it.' },
        filterOptions: ({ data }) => (idOf(data?.item) === null ? false : { item: { equals: idOf(data.item) } }),
      },
      { name: 'reason', type: 'text', label: 'Why', admin: { description: 'For example: recount, damaged in shipping, order 1042.' } },
      { name: 'reference', type: 'text', label: 'Reference', admin: { description: 'An order, invoice or batch number.' } },
      { name: 'change', type: 'number', label: 'Change', admin: { position: 'sidebar', readOnly: true, description: 'In the supply’s own unit.' } },
      { name: 'shrinkageAllowance', type: 'number', label: 'Of which shrinkage allowance', admin: { position: 'sidebar', readOnly: true } },
      { name: 'onHandAfter', type: 'number', label: 'On hand after', admin: { position: 'sidebar', readOnly: true } },
      { name: 'by', type: 'relationship', relationTo: o.userSlug as CollectionSlug, label: 'Recorded by', admin: { position: 'sidebar', readOnly: true } },
      { name: 'recipe', type: 'relationship', relationTo: o.recipes as CollectionSlug, label: 'Recipe', admin: { position: 'sidebar', readOnly: true } },
      { name: 'count', type: 'number', label: 'Made', admin: { position: 'sidebar', readOnly: true } },
    ],
  }
}

const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const MAX_DEPTH = 8
const STOCK_STATE_FIELDS = ['stockState', 'stockStateSince', 'stockAlertStatus', 'stockAlertNote'] as const

/** A recipe can use other recipes, but never itself, however deep. */
async function refuseCycle(req: PayloadRequest, o: ResolvedSupplies, selfID: unknown, lines: Doc[]) {
  const seen = new Set<string>()
  const walk = async (ls: Doc[], depth: number, path: string[]): Promise<void> => {
    for (const line of ls) {
      if (line.type !== 'recipe' || idOf(line.recipe) === null) continue
      const id = String(idOf(line.recipe))
      if (selfID !== null && id === String(selfID)) throw new KittingError('recipeCycle', `This recipe would use itself (through ${[...path, 'itself'].join(' → ')}).`)
      if (depth >= MAX_DEPTH) throw new KittingError('recipeDepth', `Recipes can be nested ${MAX_DEPTH} deep at most.`)
      if (seen.has(id)) continue
      seen.add(id)
      const sub = (await req.payload.findByID({ collection: o.recipes as CollectionSlug, id, ...sys, disableErrors: true, req })) as Doc | null
      if (sub) await walk((sub.lines ?? []) as Doc[], depth + 1, [...path, String(sub.name)])
    }
  }
  await walk(lines, 1, [])
}

export function recipesCollection(o: ResolvedSupplies): CollectionConfig {
  const beforeChange: CollectionBeforeChangeHook = async ({ data, originalDoc, req }) => {
    const key = String(data.key ?? originalDoc?.key ?? '')
      .trim()
      .toLowerCase()
    if (!KEY.test(key)) throw new KittingError('key', 'The key is lowercase letters, numbers and hyphens, like sample-kit.')
    data.key = key
    const scope = o.scopeField ? (data[o.scopeField] ?? originalDoc?.[o.scopeField]) : undefined
    const clash = await req.payload.find({
      collection: o.recipes as CollectionSlug,
      where: { and: [{ key: { equals: key } }, ...(originalDoc?.id ? [{ id: { not_equals: originalDoc.id } }] : []), ...(o.scopeField ? [{ [o.scopeField]: { equals: idOf(scope) } }] : [])] },
      limit: 1,
      pagination: false,
      ...sys,
      req,
    })
    if (clash.docs.length) throw new KittingError('keyTaken', `Another recipe already uses the key "${key}".`)
    for (const line of (data.lines ?? []) as Doc[]) {
      if (line.type === 'recipe') {
        if (idOf(line.recipe) === null) throw new KittingError('lineRecipe', 'Choose the recipe this line uses.')
        line.item = null
        await sameScope(req, o, scope, o.recipes, line.recipe, 'A recipe used in this one')
      } else {
        if (idOf(line.item) === null) throw new KittingError('lineItem', 'Choose the supply this line uses.')
        line.type = 'item'
        line.recipe = null
        await sameScope(req, o, scope, o.items, line.item, 'A supply in this recipe')
      }
    }
    if (data.makes !== undefined && data.makes !== null && !(typeof data.makes === 'number' && data.makes > 0)) throw new KittingError('makes', '“Makes” is more than zero.')
    if (data.makesUnit !== undefined) data.makesUnit = normalizeUnit(data.makesUnit) || 'each'
    await refuseCycle(req, o, originalDoc?.id ?? null, (data.lines ?? originalDoc?.lines ?? []) as Doc[])
    // The ready-stock state and its email change only through Kitting.
    if (!req.context?.[INTERNAL]) for (const f of STOCK_STATE_FIELDS) data[f] = originalDoc?.[f] ?? null
    return data
  }
  return {
    slug: o.recipes,
    labels: { singular: 'Recipe', plural: 'Recipes' },
    admin: {
      group: o.adminGroup,
      useAsTitle: 'name',
      defaultColumns: ['name', 'key', 'active'],
      description: 'What goes into one of something you make. Making 50 uses 50 × each line.',
    },
    access: { read: o.read, create: o.manage, update: o.manage, delete: o.manage },
    hooks: { beforeChange: [beforeChange], afterChange: [refreshAfter(o)] },
    fields: [
      { name: 'name', type: 'text', required: true, label: 'What it makes', admin: { description: 'For example: Gift box.' } },
      { name: 'key', type: 'text', required: true, index: true, label: 'Key', admin: { description: 'A short code the site’s software uses to find this recipe, like gift-box.' } },
      { name: 'active', type: 'checkbox', defaultValue: true, label: 'In use', admin: { position: 'sidebar', description: 'Switched off, it can’t be used on its own. Recipes that use it still can.' } },
      {
        type: 'row',
        fields: [
          { name: 'makes', type: 'number', defaultValue: 1, min: 0.000001, label: 'Makes', admin: { width: '50%', description: 'How much one batch of this makes, for example 1000 (ml of syrup). Usually 1.' } },
          { name: 'makesUnit', type: 'text', defaultValue: 'each', label: 'Of', admin: { width: '50%', description: 'each, ml, g…' } },
        ],
      },
      {
        name: 'maxPerBatch',
        type: 'number',
        min: 1,
        label: 'Most to build at once',
        admin: { position: 'sidebar', description: 'The builder refuses a bigger batch. Empty: no limit.' },
      },
      {
        name: 'lines',
        type: 'array',
        required: true,
        minRows: 1,
        label: 'Supplies for one',
        labels: { singular: 'Supply', plural: 'Supplies' },
        fields: [
          {
            name: 'type',
            type: 'radio',
            defaultValue: 'item',
            label: 'Uses',
            options: [
              { label: 'A supply', value: 'item' },
              { label: 'Another recipe', value: 'recipe' },
            ],
            admin: { layout: 'horizontal', description: 'Another recipe: for example a house syrup used in many drinks. Its supplies are used too.' },
          },
          {
            type: 'row',
            fields: [
              {
                name: 'item',
                type: 'relationship',
                relationTo: o.items as CollectionSlug,
                label: 'Supply',
                admin: { width: '40%', condition: (_d, sibling) => sibling?.type !== 'recipe' },
              },
              {
                name: 'recipe',
                type: 'relationship',
                relationTo: o.recipes as CollectionSlug,
                label: 'Recipe',
                admin: { width: '40%', condition: (_d, sibling) => sibling?.type === 'recipe' },
              },
              { name: 'quantity', type: 'number', required: true, min: 0.000001, label: 'Quantity for one', admin: { width: '20%' } },
              { name: 'unit', type: 'text', label: 'Unit', admin: { width: '20%', description: 'Empty: the supply’s unit, or what the recipe makes.' } },
              {
                name: 'shrinkagePercent',
                type: 'number',
                min: 0,
                max: 100,
                label: 'Shrinkage %',
                admin: { width: '20%', description: 'Empty: the recipe’s or supply’s.', condition: (_d, sibling) => sibling?.type !== 'recipe' },
              },
            ],
          },
          { name: 'note', type: 'text', label: 'Note' },
        ],
      },
      {
        name: 'shrinkagePercent',
        type: 'number',
        min: 0,
        max: 100,
        label: 'Shrinkage allowance (%)',
        admin: { position: 'sidebar', description: 'For every supply in this recipe, for example a kit failure rate. Empty: each supply’s own.' },
      },
      {
        name: 'readyStock',
        type: 'group',
        label: 'Ready stock',
        admin: { description: 'For things you build ahead and keep ready, such as kits. How many to keep is worked out by the method you choose; the overview shows every method side by side.' },
        fields: [
          {
            name: 'method',
            type: 'select',
            defaultValue: 'statistical',
            label: 'How to decide how many to keep',
            options: STOCK_METHODS.map((m) => ({ label: m.label, value: m.value })),
            admin: { description: STOCK_METHODS.map((m) => `${m.label}: ${m.suits}`).join(' ') },
          },
          {
            type: 'row',
            fields: [
              { name: 'manual', type: 'number', min: 0, label: 'Fixed number', admin: { width: '33%', description: 'Also used until there’s enough sales history.' } },
              { name: 'leadTimeDays', type: 'number', min: 0, defaultValue: 5, label: 'Days to build', admin: { width: '33%', description: 'From deciding to build to ready.' } },
              { name: 'reviewDays', type: 'number', min: 1, defaultValue: 1, label: 'Check every (days)', admin: { width: '33%' } },
            ],
          },
          {
            type: 'row',
            fields: [
              { name: 'serviceLevel', type: 'number', min: 50, max: 99.9, defaultValue: 95, label: 'Service level (%)', admin: { width: '33%', description: 'How often you want to have one ready when it’s needed.' } },
              { name: 'coverDays', type: 'number', min: 1, defaultValue: 14, label: 'Days of cover', admin: { width: '33%', description: 'For “Days of cover”.' } },
              { name: 'windowDays', type: 'number', min: 7, defaultValue: 90, label: 'Sales history (days)', admin: { width: '33%' } },
            ],
          },
          {
            type: 'row',
            fields: [
              {
                name: 'baseline',
                type: 'number',
                min: 0,
                label: 'Keep this many ready',
                admin: { width: '50%', description: 'The number you’ve accepted. The overview suggests one; it never changes this by itself.' },
              },
              {
                name: 'suppliesLowWhen',
                type: 'select',
                defaultValue: 'either',
                label: 'Supplies count as low when',
                options: [
                  { label: 'Either of these', value: 'either' },
                  { label: 'A supply is below its level', value: 'below-level' },
                  { label: 'There isn’t enough to build up to the number above', value: 'cannot-reach' },
                ],
                admin: { width: '50%' },
              },
            ],
          },
          {
            type: 'row',
            fields: [
              { name: 'min', type: 'number', min: 0, label: 'Minimum', admin: { width: '50%', description: 'For “Minimum and maximum”: build when ready stock falls to this.' } },
              { name: 'max', type: 'number', min: 0, label: 'Maximum', admin: { width: '50%', description: '…up to this.' } },
            ],
          },
        ],
      },
      {
        name: 'unitWeight',
        type: 'number',
        min: 0,
        label: 'Weight of one, packed (g)',
        admin: { position: 'sidebar', description: 'For box suggestions and postage.' },
      },
      {
        name: 'stockState',
        type: 'select',
        label: 'Ready stock',
        options: [
          { label: 'OK', value: 'ok' },
          { label: 'Supplies low (enough ready)', value: 'info' },
          { label: 'Build more', value: 'build-more' },
          { label: 'Urgent: few ready and supplies low', value: 'urgent' },
        ],
        admin: { position: 'sidebar', readOnly: true },
      },
      { name: 'stockStateSince', type: 'date', label: 'Since', admin: { position: 'sidebar', readOnly: true, date: { pickerAppearance: 'dayAndTime' } } },
      { name: 'stockAlertStatus', type: 'select', label: 'Ready-stock email', options: ['pending', 'sending', 'sent', 'not-sent', 'failed'].map((v) => ({ label: v, value: v })), admin: { position: 'sidebar', readOnly: true } },
      { name: 'stockAlertNote', type: 'text', label: 'Email note', admin: { position: 'sidebar', readOnly: true } },
      { name: 'notes', type: 'textarea', label: 'Notes' },
    ],
  }
}

export function lotsCollection(o: ResolvedSupplies): CollectionConfig {
  const beforeChange: CollectionBeforeChangeHook = async ({ data, originalDoc, operation, req }) => {
    const internal = req.context?.[INTERNAL]
    const itemID = idOf(data.item ?? originalDoc?.item)
    const item = itemID === null ? null : ((await req.payload.findByID({ collection: o.items as CollectionSlug, id: itemID, ...sys, disableErrors: true, req })) as Doc | null)
    if (!item) throw new KittingError('itemRequired', 'Choose a supply.')
    if (operation === 'update' && !sameID(item.id, originalDoc?.item)) throw new KittingError('lot', 'A lot can’t move to another supply.')
    // A lot takes its owner from its supply, so the person must be able to manage that supply.
    if (!internal && req.user && !(await mayManage(req, o, item.id))) throw new KittingError('forbidden', 'You can’t add or change lots of that supply.')
    if (!internal) data.onHand = operation === 'create' ? 0 : (originalDoc?.onHand ?? 0)
    if (o.scopeField) data[o.scopeField] = idOf(item[o.scopeField])
    const lotNumber = data.lotNumber !== undefined ? data.lotNumber : originalDoc?.lotNumber
    data.lotNumber = lotNumber ? String(lotNumber).trim() : null
    if (data.lotNumber) {
      const clash = await req.payload.find({
        collection: o.lots as CollectionSlug,
        where: { and: [{ item: { equals: item.id } }, { lotNumber: { equals: data.lotNumber } }, ...(originalDoc?.id ? [{ id: { not_equals: originalDoc.id } }] : [])] },
        limit: 1,
        pagination: false,
        ...sys,
        req,
      })
      if (clash.docs.length) throw new KittingError('lotTaken', `${item.name} already has a lot ${data.lotNumber}.`)
    }
    const expiresOn = data.expiresOn !== undefined ? data.expiresOn : originalDoc?.expiresOn
    const received = data.receivedOn ?? originalDoc?.receivedOn ?? new Date().toISOString()
    data.receivedOn = received
    data.label = [data.lotNumber ? `Lot ${data.lotNumber}` : `Received ${String(received).slice(0, 10)}`, expiresOn ? `use by ${String(expiresOn).slice(0, 10)}` : null].filter(Boolean).join(' · ')
    return data
  }
  const beforeDelete: CollectionBeforeDeleteHook = async ({ id, req }) => {
    if (req.context?.[ALLOW_DELETE]) return
    const used = await req.payload.count({ collection: o.movements as CollectionSlug, where: { lot: { equals: id } }, overrideAccess: true, req })
    if (used.totalDocs) throw new KittingError('hasHistory', 'This lot has stock history, so it can’t be deleted.')
  }
  return {
    slug: o.lots,
    labels: { singular: 'Lot', plural: 'Lots' },
    admin: {
      group: o.adminGroup,
      useAsTitle: 'label',
      defaultColumns: ['label', 'item', 'onHand', 'expiresOn'],
      description: 'Deliveries of supplies with lots tracked. Made when stock is received; the first to expire is used first.',
    },
    defaultSort: 'expiresOn',
    access: { read: o.read, create: o.manage, update: o.manage, delete: o.manage },
    hooks: { beforeChange: [beforeChange], beforeDelete: [beforeDelete] },
    fields: [
      { name: 'item', type: 'relationship', relationTo: o.items as CollectionSlug, required: true, label: 'Supply' },
      {
        type: 'row',
        fields: [
          { name: 'lotNumber', type: 'text', label: 'Lot number', admin: { width: '50%' } },
          { name: 'expiresOn', type: 'date', label: 'Use by', admin: { width: '50%', date: { pickerAppearance: 'dayOnly' } } },
        ],
      },
      { name: 'onHand', type: 'number', defaultValue: 0, label: 'On hand', admin: { readOnly: true, description: 'Changes only through stock movements.' } },
      { name: 'receivedOn', type: 'date', label: 'Received', admin: { position: 'sidebar', date: { pickerAppearance: 'dayAndTime' } } },
      { name: 'label', type: 'text', label: 'Label', admin: { hidden: true } },
      { name: 'notes', type: 'textarea', label: 'Notes' },
    ],
  }
}

const UNIT_FIELDS_BY_HAND = ['notes']

export function unitsCollection(o: ResolvedSupplies): CollectionConfig {
  const beforeChange: CollectionBeforeChangeHook = async ({ data, originalDoc, operation, req }) => {
    if (req.context?.[INTERNAL]) return data
    if (operation === 'create') throw new KittingError('useBuilder', 'Units are made with the builder, so their supplies come off stock.')
    // By hand, only notes change: status, lots and IDs change through the builder and its API.
    const kept: Doc = { ...originalDoc }
    for (const f of UNIT_FIELDS_BY_HAND) if (data[f] !== undefined) kept[f] = data[f]
    return kept
  }
  const beforeDelete: CollectionBeforeDeleteHook = ({ req }) => {
    if (!req.context?.[ALLOW_DELETE]) throw new KittingError('appendOnly', 'Built units can’t be deleted. Void one instead.')
  }
  const lotRow = (name: string, label: string) => ({ name, type: 'relationship' as const, relationTo: (name === 'lot' ? o.lots : o.items) as CollectionSlug, label, admin: { readOnly: true, width: '40%' } })
  return {
    slug: o.units,
    labels: { singular: 'Built unit', plural: 'Built units' },
    admin: {
      group: o.adminGroup,
      useAsTitle: 'externalId',
      defaultColumns: ['externalId', 'recipe', 'status', 'builtAt', 'assignedTo'],
      description: 'Things built from a recipe, each with its own ID. Build them on the Build page; each records the lots that went into it.',
    },
    defaultSort: '-builtAt',
    // One unit per ID per site, enforced by the database too, so two builds at once can't both use an ID.
    indexes: [{ fields: o.scopeField ? ['externalId', o.scopeField] : ['externalId'], unique: true }],
    access: { read: o.read, create: o.manage, update: o.manage, delete: o.manage },
    hooks: { beforeChange: [beforeChange], beforeDelete: [beforeDelete] },
    fields: [
      { name: 'externalId', type: 'text', required: true, index: Boolean(o.scopeField), label: 'ID', admin: { readOnly: true, description: 'The ID on the unit, for example the one printed on a tube.' } },
      { name: 'recipe', type: 'relationship', relationTo: o.recipes as CollectionSlug, required: true, label: 'Recipe', admin: { readOnly: true } },
      {
        name: 'status',
        type: 'select',
        required: true,
        defaultValue: 'ready',
        label: 'Status',
        options: [
          { label: 'Ready', value: 'ready' },
          { label: 'Assigned to an order', value: 'assigned' },
          { label: 'Shipped', value: 'shipped' },
          { label: 'Void', value: 'void' },
        ],
        admin: { readOnly: true, position: 'sidebar' },
      },
      {
        name: 'lotsUsed',
        type: 'array',
        label: 'What went into it',
        admin: { readOnly: true },
        fields: [
          {
            type: 'row',
            fields: [lotRow('item', 'Supply'), lotRow('lot', 'Lot'), { name: 'quantity', type: 'number', label: 'Quantity', admin: { readOnly: true, width: '20%' } }],
          },
        ],
      },
      { name: 'builtAt', type: 'date', label: 'Built', admin: { readOnly: true, position: 'sidebar', date: { pickerAppearance: 'dayAndTime' } } },
      { name: 'builtBy', type: 'relationship', relationTo: o.userSlug as CollectionSlug, label: 'Built by', admin: { readOnly: true, position: 'sidebar' } },
      { name: 'reference', type: 'text', label: 'Reference', admin: { readOnly: true, position: 'sidebar' } },
      { name: 'assignedTo', type: 'text', label: 'Assigned to', admin: { readOnly: true, position: 'sidebar', description: 'The order it went to.' } },
      { name: 'assignedAt', type: 'date', label: 'Assigned', admin: { readOnly: true, position: 'sidebar', date: { pickerAppearance: 'dayAndTime' } } },
      { name: 'shippedAt', type: 'date', label: 'Shipped', admin: { readOnly: true, position: 'sidebar', date: { pickerAppearance: 'dayAndTime' } } },
      {
        type: 'collapsible',
        label: 'Voided',
        admin: { condition: (d) => d?.status === 'void' },
        fields: [
          {
            name: 'voidReason',
            type: 'select',
            label: 'Why',
            options: [
              { label: 'A dud', value: 'dud' },
              { label: 'Damaged', value: 'damaged' },
              { label: 'Built by mistake', value: 'mistake' },
              { label: 'Other', value: 'other' },
            ],
            admin: { readOnly: true },
          },
          { name: 'voidNote', type: 'text', label: 'Note', admin: { readOnly: true } },
          { name: 'voidedAt', type: 'date', label: 'Voided', admin: { readOnly: true, date: { pickerAppearance: 'dayAndTime' } } },
          { name: 'returnedToStock', type: 'checkbox', label: 'Supplies went back to stock', admin: { readOnly: true } },
        ],
      },
      { name: 'notes', type: 'textarea', label: 'Notes' },
    ],
  }
}

/** Builds waiting for an order: made by assignUnits when not enough are ready, filled by later builds. */
export function requestsCollection(o: ResolvedSupplies): CollectionConfig {
  const beforeChange: CollectionBeforeChangeHook = async ({ data, originalDoc, operation, req }) => {
    if (req.context?.[INTERNAL]) return data
    if (operation === 'create') throw new KittingError('useAssign', 'Build requests are made when an order can’t be filled from ready stock.')
    // By hand: cancel an open request, or edit notes. Nothing else.
    const kept: Doc = { ...originalDoc }
    if (data.notes !== undefined) kept.notes = data.notes
    if (data.status === 'cancelled' && originalDoc?.status === 'open') kept.status = 'cancelled'
    return kept
  }
  const beforeDelete: CollectionBeforeDeleteHook = ({ req }) => {
    if (!req.context?.[ALLOW_DELETE]) throw new KittingError('appendOnly', 'Build requests can’t be deleted. Cancel one instead.')
  }
  return {
    slug: o.requests,
    labels: { singular: 'Build request', plural: 'Build requests' },
    admin: {
      group: o.adminGroup,
      useAsTitle: 'reference',
      defaultColumns: ['reference', 'recipe', 'count', 'filled', 'status', 'createdAt'],
      description: 'Orders waiting for units to be built, oldest first. Building that recipe fills them in order.',
    },
    defaultSort: 'createdAt',
    access: { read: o.read, create: o.manage, update: o.manage, delete: o.manage },
    hooks: { beforeChange: [beforeChange], beforeDelete: [beforeDelete] },
    fields: [
      { name: 'reference', type: 'text', required: true, label: 'For', admin: { readOnly: true } },
      { name: 'recipe', type: 'relationship', relationTo: o.recipes as CollectionSlug, required: true, label: 'Recipe', admin: { readOnly: true } },
      {
        type: 'row',
        fields: [
          { name: 'count', type: 'number', required: true, min: 1, label: 'Needed', admin: { readOnly: true, width: '50%' } },
          { name: 'filled', type: 'number', defaultValue: 0, label: 'Filled so far', admin: { readOnly: true, width: '50%' } },
        ],
      },
      {
        name: 'status',
        type: 'select',
        required: true,
        defaultValue: 'open',
        label: 'Status',
        options: [
          { label: 'Waiting to be built', value: 'open' },
          { label: 'Filled', value: 'filled' },
          { label: 'Cancelled', value: 'cancelled' },
        ],
        admin: { position: 'sidebar', description: 'You can cancel a waiting request.' },
      },
      { name: 'units', type: 'relationship', relationTo: o.units as CollectionSlug, hasMany: true, label: 'Units given to it', admin: { readOnly: true } },
      { name: 'notes', type: 'textarea', label: 'Notes' },
    ],
  }
}

const dimensionsRow = (prefix: string) => ({
  type: 'row' as const,
  fields: [
    { name: `${prefix}Length`, type: 'number' as const, min: 0, label: 'Length', admin: { width: '25%' } },
    { name: `${prefix}Width`, type: 'number' as const, min: 0, label: 'Width', admin: { width: '25%' } },
    { name: `${prefix}Height`, type: 'number' as const, min: 0, label: 'Height', admin: { width: '25%' } },
    {
      name: `${prefix}Unit`,
      type: 'select' as const,
      defaultValue: 'cm',
      label: 'In',
      options: [
        { label: 'cm', value: 'cm' },
        { label: 'inches', value: 'in' },
      ],
      admin: { width: '25%' },
    },
  ],
})

/** Boxes you ship in, with how many of each recipe fit: the basis for box suggestions. */
export function boxesCollection(o: ResolvedSupplies): CollectionConfig {
  const beforeChange: CollectionBeforeChangeHook = async ({ data, originalDoc, req }) => {
    const scope = o.scopeField ? (data[o.scopeField] ?? originalDoc?.[o.scopeField]) : undefined
    for (const fit of (data.fits ?? []) as Doc[]) await sameScope(req, o, scope, o.recipes, fit.recipe, 'A recipe in this box')
    return data
  }
  return {
    slug: o.boxes,
    labels: { singular: 'Box', plural: 'Boxes' },
    admin: {
      group: o.adminGroup,
      useAsTitle: 'name',
      defaultColumns: ['name', 'cost', 'active'],
      description: 'Boxes you ship in. Box suggestions use what fits, the weights and the cost, plus postage.',
    },
    access: { read: o.read, create: o.manage, update: o.manage, delete: o.manage },
    hooks: { beforeChange: [beforeChange] },
    fields: [
      { name: 'name', type: 'text', required: true, label: 'Name', admin: { description: 'For example: Small mailer.' } },
      { name: 'active', type: 'checkbox', defaultValue: true, label: 'In use', admin: { position: 'sidebar' } },
      { type: 'collapsible', label: 'Outside size', fields: [dimensionsRow('outside')] },
      {
        type: 'row',
        fields: [
          { name: 'cost', type: 'number', min: 0, defaultValue: 0, label: 'Cost of one box', admin: { width: '33%' } },
          { name: 'emptyWeight', type: 'number', min: 0, defaultValue: 0, label: 'Empty weight (g)', admin: { width: '33%' } },
          { name: 'maxWeight', type: 'number', min: 0, label: 'Most it can weigh (g)', admin: { width: '33%', description: 'Empty: no limit.' } },
        ],
      },
      {
        name: 'fits',
        type: 'array',
        label: 'What fits',
        labels: { singular: 'Recipe', plural: 'Recipes' },
        admin: { description: 'How many of each thing fit in this box. Only these are suggested.' },
        fields: [
          {
            type: 'row',
            fields: [
              { name: 'recipe', type: 'relationship', relationTo: o.recipes as CollectionSlug, required: true, label: 'Recipe', admin: { width: '60%' } },
              { name: 'units', type: 'number', required: true, min: 1, label: 'How many fit', admin: { width: '40%' } },
            ],
          },
        ],
      },
      { name: 'notes', type: 'textarea', label: 'Notes' },
    ],
  }
}

/** Your own postage by weight, used when no shipping plugin gives real rates. */
export function postageCollection(o: ResolvedSupplies): CollectionConfig {
  return {
    slug: o.postage,
    labels: { singular: 'Postage rate', plural: 'Postage rates' },
    admin: {
      group: o.adminGroup,
      useAsTitle: 'name',
      defaultColumns: ['name', 'upToGrams', 'cost'],
      description: 'What one parcel costs to send, by weight. The cheapest band a parcel fits is used. A shipping plugin’s real rates replace these when it has them.',
    },
    defaultSort: 'upToGrams',
    access: { read: o.read, create: o.manage, update: o.manage, delete: o.manage },
    fields: [
      { name: 'name', type: 'text', required: true, label: 'Name', admin: { description: 'For example: Ground, up to 500 g.' } },
      {
        type: 'row',
        fields: [
          { name: 'upToGrams', type: 'number', required: true, min: 1, label: 'Up to (g)', admin: { width: '50%' } },
          { name: 'cost', type: 'number', required: true, min: 0, label: 'Cost', admin: { width: '50%' } },
        ],
      },
    ],
  }
}

/** Kitting's settings for a site (one per site): what a site owner changes without touching code. */
export function settingsCollection(o: ResolvedSupplies): CollectionConfig {
  const beforeChange: CollectionBeforeChangeHook = async ({ data, originalDoc, req }) => {
    const scope = o.scopeField ? idOf(data[o.scopeField] ?? originalDoc?.[o.scopeField]) : null
    const clash = await req.payload.find({
      collection: o.settings as CollectionSlug,
      where: { and: [...(originalDoc?.id ? [{ id: { not_equals: originalDoc.id } }] : []), ...(o.scopeField ? [{ [o.scopeField]: { equals: scope } }] : [])] },
      limit: 1,
      pagination: false,
      ...sys,
      req,
    })
    if (clash.docs.length) throw new KittingError('settingsTaken', o.scopeField ? `This ${o.scopeField} already has Kitting settings. Edit those instead.` : 'Kitting settings already exist. Edit those instead.')
    data.title = 'Kitting settings'
    return data
  }
  const refresh: CollectionAfterChangeHook = async ({ doc, req }) => {
    await refreshStockStates(req.payload, { req, scope: o.scopeField ? idOf(doc[o.scopeField]) : null })
    return doc
  }
  return {
    slug: o.settings,
    labels: { singular: 'Kitting settings', plural: 'Kitting settings' },
    admin: {
      group: o.adminGroup,
      useAsTitle: 'title',
      description: 'Settings for this site. Anything left empty uses the defaults set in code.',
    },
    access: { read: o.read, create: o.manage, update: o.manage, delete: o.manage },
    hooks: { beforeChange: [beforeChange], afterChange: [refresh] },
    fields: [
      { name: 'title', type: 'text', defaultValue: 'Kitting settings', admin: { hidden: true } },
      {
        name: 'shrinkage',
        type: 'select',
        label: 'Shrinkage allowance',
        options: [
          { label: o.shrinkage.enabled ? 'On (the default)' : 'On', value: 'on' },
          { label: o.shrinkage.enabled ? 'Off' : 'Off (the default)', value: 'off' },
        ],
        admin: {
          description: 'Shrinkage is stock lost to damage, spoilage, defects or errors. When on, each recipe takes a little extra off stock to cover it, so stock stays close to real without counting every day. Off: recipes take exactly what they list.',
        },
      },
      {
        name: 'shrinkageDefaultPercent',
        type: 'number',
        min: 0,
        max: 100,
        label: 'Default shrinkage allowance (%)',
        admin: { description: `For supplies without their own. Empty: ${o.shrinkage.defaultPercent}%.`, condition: (d) => d?.shrinkage !== 'off' },
      },
    ],
  }
}
