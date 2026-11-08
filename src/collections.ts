import type { CollectionAfterChangeHook, CollectionAfterOperationHook, CollectionBeforeChangeHook, CollectionBeforeDeleteHook, CollectionConfig, CollectionSlug, PayloadRequest } from 'payload'

import { ALLOW_DELETE, INTERNAL, alertFields, applyMovementToItem, asInternal, idOf, prepareMovement, round, sameID, sendPendingAlerts, SuppliesError } from './stock.js'
import type { ResolvedSupplies } from './types.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const ALERT_FIELDS = ['belowLevelSince', 'alertStatus', 'alertAt', 'alertNote'] as const
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
  if (!doc) throw new SuppliesError('notFound', `${what} doesn’t exist.`)
  if (!sameID(doc[o.scopeField], scope)) throw new SuppliesError('scope', `${what} belongs to another ${o.scopeField}.`)
}

export function itemsCollection(o: ResolvedSupplies): CollectionConfig {
  const beforeChange: CollectionBeforeChangeHook = async ({ data, originalDoc, operation, req }) => {
    const internal = req.context?.[INTERNAL]
    const level = data.lowStockLevel !== undefined ? data.lowStockLevel : originalDoc?.lowStockLevel
    const retired = data.retired !== undefined ? data.retired : originalDoc?.retired
    const effectiveLevel = retired ? null : level
    if (operation === 'create') {
      const opening = typeof data.openingStock === 'number' ? data.openingStock : typeof data.onHand === 'number' ? data.onHand : 0
      if (!Number.isFinite(opening) || opening < 0) throw new SuppliesError('quantity', 'Opening stock can’t be below zero.')
      data.onHand = round(opening)
      for (const f of ALERT_FIELDS) data[f] = null
      Object.assign(data, alertFields({}, data.onHand, effectiveLevel))
    } else if (!internal) {
      // On hand and alerts change only through movements and the level, never by hand.
      data.onHand = originalDoc?.onHand ?? 0
      for (const f of ALERT_FIELDS) data[f] = originalDoc?.[f] ?? null
      Object.assign(data, alertFields(originalDoc ?? {}, data.onHand, effectiveLevel))
    }
    delete data.openingStock
    if (o.scopeField && data.supplier !== undefined) await sameScope(req, o, data[o.scopeField] ?? originalDoc?.[o.scopeField], o.suppliers, data.supplier, 'That supplier')
    return data
  }
  /** Opening stock is the first line of the item's history, so on hand always equals the sum of its movements. */
  const afterChange: CollectionAfterChangeHook = async ({ doc, operation, req }) => {
    if (operation !== 'create' || !(doc.onHand > 0)) return doc
    const by = req.user && req.user.collection === o.userSlug ? req.user.id : null
    await asInternal(req, { opening: true, by }, () =>
      req.payload.create({ collection: o.movements as CollectionSlug, data: { item: doc.id, kind: 'adjusted', quantity: doc.onHand, reason: 'Opening stock' } as never, ...sys, req }),
    )
    return doc
  }
  const beforeDelete: CollectionBeforeDeleteHook = async ({ id, req }) => {
    if (req.context?.[ALLOW_DELETE]) return
    const used = await req.payload.count({ collection: o.movements as CollectionSlug, where: { item: { equals: id } }, overrideAccess: true, req })
    if (used.totalDocs) throw new SuppliesError('hasHistory', 'This supply has stock history, so it can’t be deleted. Tick “No longer used” instead.')
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
    hooks: { beforeChange: [beforeChange], afterChange: [afterChange], beforeDelete: [beforeDelete], afterOperation: [sendForTouched((r) => (Array.isArray(r.docs) ? r.docs : [r]))] },
    fields: [
      { name: 'name', type: 'text', required: true, label: 'Name' },
      {
        type: 'row',
        fields: [
          { name: 'unit', type: 'text', required: true, defaultValue: 'each', label: 'Unit', admin: { description: 'How you count it: each, ml, metres, box of 100…', width: '50%' } },
          { name: 'sku', type: 'text', label: 'SKU or part number', admin: { width: '50%' } },
        ],
      },
      { name: 'supplier', type: 'relationship', relationTo: o.suppliers as CollectionSlug, label: 'Supplier' },
      {
        name: 'openingStock',
        type: 'number',
        virtual: true,
        min: 0,
        label: 'Opening stock',
        admin: { description: 'How many you have now. After this, stock changes only through movements.', condition: (_d, _s, { operation }) => operation === 'create' },
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
    if (operation !== 'create') throw new SuppliesError('appendOnly', 'Stock movements can’t be changed. Record an adjustment instead.')
    if (idOf(data.item) === null) throw new SuppliesError('itemRequired', 'Choose a supply.')
    return prepareMovement(req, data)
  }
  const afterChange: CollectionAfterChangeHook = async ({ doc, operation, req }) => {
    if (operation === 'create') await applyMovementToItem(req, doc)
    return doc
  }
  const beforeDelete: CollectionBeforeDeleteHook = ({ req }) => {
    if (!req.context?.[ALLOW_DELETE]) throw new SuppliesError('appendOnly', 'Stock movements can’t be deleted. Record an adjustment instead.')
  }
  return {
    slug: o.movements,
    labels: { singular: 'Stock movement', plural: 'Stock movements' },
    admin: {
      group: o.adminGroup,
      defaultColumns: ['createdAt', 'item', 'kind', 'change', 'onHandAfter', 'by', 'reference'],
      description: 'The stock log. Each line is permanent: to fix a mistake, record an adjustment.',
    },
    defaultSort: '-createdAt',
    // Append-only, whatever the host's access says. Trusted cleanup scripts pass `suppliesAllowDelete`.
    access: { read: o.read, create: o.manage, update: never, delete: never },
    hooks: { beforeChange: [beforeChange], afterChange: [afterChange], beforeDelete: [beforeDelete], afterOperation: [sendForTouched((r) => [r.item])] },
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
              { label: 'Adjusted (+ or −)', value: 'adjusted' },
            ],
            admin: { width: '50%' },
          },
          {
            name: 'quantity',
            type: 'number',
            required: true,
            label: 'Quantity',
            admin: { width: '50%', description: 'In the supply’s unit. For an adjustment, type −3 to take 3 away.' },
          },
        ],
      },
      { name: 'reason', type: 'text', label: 'Why', admin: { description: 'For example: recount, damaged in shipping, order 1042.' } },
      { name: 'reference', type: 'text', label: 'Reference', admin: { description: 'An order, invoice or batch number.' } },
      { name: 'change', type: 'number', label: 'Change', admin: { position: 'sidebar', readOnly: true } },
      { name: 'onHandAfter', type: 'number', label: 'On hand after', admin: { position: 'sidebar', readOnly: true } },
      { name: 'by', type: 'relationship', relationTo: o.userSlug as CollectionSlug, label: 'Recorded by', admin: { position: 'sidebar', readOnly: true } },
      { name: 'recipe', type: 'relationship', relationTo: o.recipes as CollectionSlug, label: 'Recipe', admin: { position: 'sidebar', readOnly: true } },
      { name: 'count', type: 'number', label: 'Made', admin: { position: 'sidebar', readOnly: true } },
    ],
  }
}

const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function recipesCollection(o: ResolvedSupplies): CollectionConfig {
  const beforeChange: CollectionBeforeChangeHook = async ({ data, originalDoc, req }) => {
    const key = String(data.key ?? originalDoc?.key ?? '')
      .trim()
      .toLowerCase()
    if (!KEY.test(key)) throw new SuppliesError('key', 'The key is lowercase letters, numbers and hyphens, like sample-kit.')
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
    if (clash.docs.length) throw new SuppliesError('keyTaken', `Another recipe already uses the key "${key}".`)
    for (const line of (data.lines ?? []) as Doc[]) await sameScope(req, o, scope, o.items, line.item, 'A supply in this recipe')
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
    hooks: { beforeChange: [beforeChange] },
    fields: [
      { name: 'name', type: 'text', required: true, label: 'What it makes', admin: { description: 'For example: Gift box.' } },
      { name: 'key', type: 'text', required: true, index: true, label: 'Key', admin: { description: 'A short code the site’s software uses to find this recipe, like gift-box.' } },
      { name: 'active', type: 'checkbox', defaultValue: true, label: 'In use', admin: { position: 'sidebar', description: 'Switched off, it can’t be used.' } },
      {
        name: 'lines',
        type: 'array',
        required: true,
        minRows: 1,
        label: 'Supplies for one',
        labels: { singular: 'Supply', plural: 'Supplies' },
        fields: [
          {
            type: 'row',
            fields: [
              { name: 'item', type: 'relationship', relationTo: o.items as CollectionSlug, required: true, label: 'Supply', admin: { width: '60%' } },
              { name: 'quantity', type: 'number', required: true, min: 0.000001, label: 'Quantity for one', admin: { width: '40%' } },
            ],
          },
          { name: 'note', type: 'text', label: 'Note' },
        ],
      },
      { name: 'notes', type: 'textarea', label: 'Notes' },
    ],
  }
}
