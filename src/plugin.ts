import type { Access, CollectionConfig, Config, Plugin } from 'payload'

import { boxesCollection, itemsCollection, lotsCollection, postageCollection, requestsCollection, unitsCollection, movementsCollection, recipesCollection, suppliersCollection } from './collections.js'
import { withEcommerce } from './ecommerce.js'
import { kittingEndpoints } from './endpoints.js'
import type { ResolvedSupplies, KittingPluginOptions } from './types.js'

const clampPercent = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(n, 0), 100) : 0)

/**
 * Supplies: items, suppliers, an append-only stock log, recipes that use stock in one transaction,
 * one low-stock email per drop below the level, and a reorder list in the admin.
 */
export const kittingPlugin =
  (options: KittingPluginOptions = {}): Plugin =>
  (config: Config): Config => {
    const userSlug = config.admin?.user ?? 'users'
    const signedIn: Access = ({ req }) => Boolean(req.user && req.user.collection === userSlug)
    const o: ResolvedSupplies = {
      items: options.slugs?.items ?? 'supply-items',
      suppliers: options.slugs?.suppliers ?? 'suppliers',
      movements: options.slugs?.movements ?? 'supply-movements',
      recipes: options.slugs?.recipes ?? 'supply-recipes',
      lots: options.slugs?.lots ?? 'supply-lots',
      units: options.slugs?.units ?? 'assembled-units',
      requests: options.slugs?.requests ?? 'build-requests',
      boxes: options.slugs?.boxes ?? 'box-types',
      postage: options.slugs?.postage ?? 'postage-rates',
      onBuild: options.units?.onBuild,
      shippingProvider: options.shipping?.provider,
      boxSource: options.boxes?.source,
      currency: options.shipping?.currency ?? 'USD',
      ecommerce: {
        enabled: options.ecommerce?.enabled ?? false,
        products: options.ecommerce?.products ?? 'products',
        variants: options.ecommerce?.variants ?? 'variants',
        orders: options.ecommerce?.orders ?? 'orders',
        reference: options.ecommerce?.reference ?? ((order) => `Order ${String(order.id)}`),
        skipOrder: options.ecommerce?.skipOrder,
      },
      userSlug,
      read: options.access?.read ?? options.access?.manage ?? signedIn,
      manage: options.access?.manage ?? signedIn,
      scopeField: options.scopeField,
      negativeStock: options.negativeStock ?? 'refuse',
      recipients: options.alerts?.recipients ?? [],
      canSend: options.alerts?.canSend ?? (() => true),
      sendEmail: options.alerts?.sendEmail,
      render: options.alerts?.render,
      adminView: options.adminView ?? true,
      adminGroup: options.adminGroup ?? 'Supplies',
      shrinkage: { enabled: options.shrinkage?.enabled ?? true, defaultPercent: clampPercent(options.shrinkage?.defaultPercent) },
      lotWarningDays: options.lots?.warningDays ?? 14,
      autoWriteOff: options.lots?.autoWriteOff ?? true,
    }
    const ov = options.overrides ?? {}
    const apply = (c: CollectionConfig, f?: (c: CollectionConfig) => CollectionConfig) => (f ? f(c) : c)
    const added = [
      apply(itemsCollection(o), ov.items),
      apply(suppliersCollection(o), ov.suppliers),
      apply(movementsCollection(o), ov.movements),
      apply(recipesCollection(o), ov.recipes),
      apply(lotsCollection(o), ov.lots),
      apply(unitsCollection(o), ov.units),
      apply(requestsCollection(o), ov.requests),
      ...(o.boxSource ? [] : [apply(boxesCollection(o), ov.boxes)]),
      apply(postageCollection(o), ov.postage),
    ]
    // Never replace a host's own collection: a clash stops startup and says how to fix it.
    const clash = (config.collections ?? []).filter((c) => added.some((a) => a.slug === c.slug)).map((c) => c.slug)
    if (clash.length)
      throw new Error(`Kitting: the collection${clash.length > 1 ? 's' : ''} ${clash.join(', ')} already exist${clash.length > 1 ? '' : 's'} in this config. Give Kitting other slugs with its \`slugs\` option.`)
    const components = config.admin?.components ?? {}
    return {
      ...config,
      custom: { ...config.custom, kitting: o },
      collections: [...withEcommerce(o, config.collections ?? []), ...added],
      endpoints: [...(config.endpoints ?? []), ...kittingEndpoints],
      admin: o.adminView
        ? {
            ...config.admin,
            components: {
              ...components,
              afterNavLinks: [...(components.afterNavLinks ?? []), '@captiveorigins/payload-plugin-kitting/rsc#SuppliesNavLink'],
              views: {
                ...components.views,
                supplies: { Component: '@captiveorigins/payload-plugin-kitting/rsc#SuppliesView', path: '/supplies', exact: true },
                suppliesBuild: { Component: '@captiveorigins/payload-plugin-kitting/rsc#BuildView', path: '/supplies/build', exact: true },
              },
            },
          }
        : config.admin,
    }
  }
