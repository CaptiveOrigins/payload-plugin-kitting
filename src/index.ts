export { kittingPlugin } from './plugin.js'
export {
  ALLOW_DELETE,
  allocate,
  applyRecipe,
  defaultAlertEmail,
  describeUse,
  isBelowLevel,
  isExpired,
  KittingError,
  sendPendingAlerts,
  stockReport,
  suggestedReorder,
  suggestWastePercent,
  wastePercent,
  writeOffExpired,
  type StockRow,
} from './stock.js'
export { conversionFactor, normalizeUnit, unitsFor, type Pack } from './units.js'
export type {
  AlertItem,
  AlertStatus,
  ApplyRecipeContext,
  ApplyRecipeResult,
  MovementKind,
  WasteReason,
  NegativeStock,
  RecipeRef,
  SendEmail,
  Shortage,
  KittingPluginOptions,
} from './types.js'
export type {
  LengthUnit,
  PackedBox,
  RateRequest,
  RateResult,
  ShippingAddress,
  ShippingProvider,
  ShippingRate,
  WeightUnit,
} from './contracts/shipping.js'
