/**
 * Errors the data-access layer raises.
 *
 * Two rules hold for every message that can reach an agency:
 *  - it never names another agency, or hints at one existing;
 *  - it never carries a passport number, name or date of birth into a log.
 */

export class DalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The actor is not allowed to do this. Deliberately says nothing about what exists. */
export class ForbiddenError extends DalError {
  constructor(message = 'You do not have access to that.') {
    super(message, 403);
  }
}

export class NotAuthenticatedError extends DalError {
  constructor(message = 'Sign in to continue.') {
    super(message, 401);
  }
}

/**
 * Used for anything the actor may not see — including records that exist but belong to
 * another agency. An agency asking for someone else's passport gets exactly the same
 * answer as one asking for a passport that was never created.
 */
export class NotFoundError extends DalError {
  constructor(message = 'Not found.') {
    super(message, 404);
  }
}

export class ValidationError extends DalError {
  constructor(
    message: string,
    readonly fieldErrors: Record<string, string[]> = {},
  ) {
    super(message, 422);
  }
}

/** View-as sessions can look at everything an agency sees and change nothing. */
export class ReadOnlySessionError extends DalError {
  constructor() {
    super('You are viewing as an agency. Exit that view to make changes.', 403);
  }
}

export interface DuplicatePassportDetail {
  submittedAt: Date;
  status: string;
  /** Admin-only. Never populated in a response that reaches an agency. */
  agencyName?: string;
  agencyId?: string;
}

/**
 * A passport number already exists in the system. The submission is blocked, not warned:
 * it does not save.
 */
export class DuplicatePassportError extends DalError {
  constructor(
    readonly passportNumber: string,
    readonly detail: DuplicatePassportDetail,
  ) {
    super('This passport is already registered in the system.', 409);
  }
}
