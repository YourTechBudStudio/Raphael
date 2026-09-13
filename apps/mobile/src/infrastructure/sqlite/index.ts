export { migrate, type Migration, type MigrationOutcome } from './migrate.ts';
export {
  serializeTransactions,
  type SqlConnection,
  type SqlDriver,
  type SqlParam,
  type SqlReader,
  type SqlTransaction,
} from './port.ts';
// Deliberately without the `.ts` extension, unlike its neighbours. An explicit extension defeats
// Metro's platform resolution, which is what selects `driver.web.ts` on web - and selecting it is
// the only thing keeping `expo-sqlite` out of the web bundle.
export { sqlDriver, SQLITE_SUPPORTED } from './driver';
