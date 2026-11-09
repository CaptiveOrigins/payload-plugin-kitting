import type { Access, CollectionConfig, Config, Plugin } from 'payload'

import { itemsCollection, movementsCollection, recipesCollection, suppliersCollection } from './collections.js'
import type { ResolvedSupplies, KittingPluginOptions } from './types.js'

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
    }
    const ov = options.overrides ?? {}
    const apply = (c: CollectionConfig, f?: (c: CollectionConfig) => CollectionConfig) => (f ? f(c) : c)
    const added = [
      apply(itemsCollection(o), ov.items),
      apply(suppliersCollection(o), ov.suppliers),
      apply(movementsCollection(o), ov.movements),
      apply(recipesCollection(o), ov.recipes),
    ]
    const components = config.admin?.components ?? {}
    return {
      ...config,
      custom: { ...config.custom, kitting: o },
      collections: [...(config.collections ?? []).filter((c) => !added.some((a) => a.slug === c.slug)), ...added],
      admin: o.adminView
        ? {
            ...config.admin,
            components: {
              ...components,
              afterNavLinks: [...(components.afterNavLinks ?? []), '@captiveorigins/payload-plugin-kitting/rsc#SuppliesNavLink'],
              views: { ...components.views, supplies: { Component: '@captiveorigins/payload-plugin-kitting/rsc#SuppliesView', path: '/supplies' } },
            },
          }
        : config.admin,
    }
  }
