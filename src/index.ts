export { kittingPlugin } from './plugin.js'
export { ecommerceSource, syncAvailability } from './ecommerce.js'
export { byCost, packings, postageFor, recommendBoxes, type BoxOption, type Packing } from './boxes.js'
export { readyStatus, refreshStockStates, sendStockAlerts, stateFor, type ReadyStatus, type StockState } from './readystock.js'
export { assignUnits, fillRequests, release, shipUnits, swapUnit } from './fulfil.js'
export { buildUnits, cleanExternalIds, recommendReadyStock, splitLots, voidUnit, type VoidReason } from './build.js'
export {
  compareMethods,
  dailyDemand,
  holt,
  recommend,
  settingsFromRecipe,
  STOCK_METHODS,
  weightedStats,
  zFor,
  type Recommendation,
  type StockMethod,
  type StockSettings,
} from './stocklevel.js'
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
  suggestShrinkagePercent,
  shrinkagePercent,
  writeOffExpired,
  type StockRow,
} from './stock.js'
export { conversionFactor, normalizeUnit, unitsFor, type Pack } from './units.js'
export type {
  AlertItem,
  AlertStatus,
  ApplyRecipeContext,
  ApplyRecipeResult,
  AssignContext,
  AssignResult,
  BuildContext,
  BuildResult,
  BuiltUnit,
  LotUse,
  UnitStatus,
  MovementKind,
  WriteOffReason,
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
export { cheapestPerBox } from './contracts/shipping.js'
export { linesByRecipe, type Availability, type CommerceSource, type FulfilmentResult, type OrderLine, type PlacedOrder } from './contracts/commerce.js'
