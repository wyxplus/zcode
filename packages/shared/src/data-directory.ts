/** Node-only data-root and cross-process maintenance contract. Never import in a renderer. */
export {
  DATA_DIRECTORY_ROOT_MARKER,
  dataDirectoryLocatorSchema,
  getDataDirectoryControlPaths,
  resolveDataDirectoryHome,
  type DataDirectoryLocator,
  type DataDirectoryOptions,
  type DataDirectoryMaintenanceOptions,
  type DataDirectoryUsageLease,
  type DataDirectoryUsageRecord,
} from "./node/dataDirectoryTypes.js";
export {
  commitDataDirectoryLocator,
  getUnifiedDataRoot,
  initializeDataDirectory,
  readDataDirectoryLocator,
  resolveManagedDataRoot,
  validateDataDirectoryLocator,
  writeDataDirectoryRootMarker,
} from "./node/dataDirectoryLocator.js";
export { assertUnifiedDataDirectoryEnvironment } from "./node/dataDirectoryRoot.js";
export {
  acquireDataDirectoryUsageLease,
  assertDataDirectoryUnused,
  assertNoDataDirectoryMaintenance,
  beginDataDirectoryMaintenance,
  endDataDirectoryMaintenance,
  listLiveDataDirectoryLeases,
} from "./node/dataDirectoryLeases.js";
