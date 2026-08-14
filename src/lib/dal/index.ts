/**
 * The data-access layer. One way in.
 *
 * Every read and write takes the acting user and applies the agency scope itself. No
 * route handler, server component or script touches the driver directly — ESLint blocks
 * importing `@/lib/mongodb` or `@/lib/db/*` from anywhere but here and the migrations, so
 * there is one place to audit and one place to fix.
 */

export type { Actor, ActorRole } from './actor';
export { adminActor, agencyActor, systemActor, isAdmin, isViewingAs, scopeAgencyId } from './actor';

export {
  DalError,
  DuplicatePassportError,
  ForbiddenError,
  NotAuthenticatedError,
  NotFoundError,
  ReadOnlySessionError,
  ValidationError,
} from './errors';

export {
  countAuditEntries,
  listAuditActions,
  listAuditEntries,
  redact,
  writeAudit,
  type AuditAction,
  type AuditEntry,
  type AuditFilters,
  type AuditView,
} from './audit';

export {
  getAdminDashboard,
  getAgencyDashboard,
  getAgencyRows,
  type ActivityEntry,
  type AdminDashboard,
  type AgencyDashboard,
  type AgencyRow,
} from './dashboard';

export {
  createAgency,
  getAgency,
  getOwnAgency,
  listAgencies,
  setAgencyActive,
  updateAgency,
  type AgencySummary,
} from './agencies';

export {
  getUser,
  inviteUser,
  listUsers,
  setUserActive,
  type UserSummary,
} from './users';

export {
  buildDisplayLabel,
  createRoute,
  getRoute,
  listRouteOptions,
  listRoutes,
  repriceRoutes,
  updateRoute,
  type RepriceResult,
  type RouteDetail,
  type RouteOption,
} from './routes';

export {
  commitImport,
  getBookingForPassport,
  hashFile,
  listImportBatches,
  previewImport,
  undoImport,
  type BatchSummary,
  type CommitResult,
  type ImportPreview,
  type PreviewRow,
  type UndoResult,
} from './bookings';

export {
  getExportRecords,
  getHandoffQueue,
  getHandoffSummary,
  markAsAdded,
  recordExport,
  type MarkAddedResult,
  type QueueEntry,
  type QueueGroup,
  type QueueSummary,
} from './handoff';

export {
  getAgencyBalance,
  getBalanceOverview,
  getBalances,
  getLedger,
  listPayments,
  newIdempotencyKey,
  recordCredit,
  recordOpeningBalance,
  recordPayment,
  toDisplayEgp,
  voidPayment,
  type AgencyBalance,
  type CurrencyBalance,
  type LedgerLine,
  type PaymentInput,
  type PaymentView,
  type RecordedPayment,
} from './ledger';

export {
  getDisplayRate,
  getExportTemplate,
  resetExportTemplate,
  saveDisplayRate,
  saveExportTemplate,
  type DisplayRate,
} from './settings';

export {
  changePassportStatus,
  changePassportStatuses,
  checkDuplicates,
  countByStatus,
  countPassports,
  createPassport,
  createPassports,
  describeDuplicate,
  getPassport,
  getPassportHistory,
  listPassports,
  releaseDueHolds,
  updatePassport,
  type BatchResult,
  type BatchRowResult,
  type PassportEdit,
  type PassportFilters,
  type PassportView,
  type StatusHistoryView,
} from './passports';
