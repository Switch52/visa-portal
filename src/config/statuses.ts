/**
 * The passport status flow, in one place.
 *
 * Screens, API routes and the data-access layer all read the flow from here, so a new
 * state can be added without touching every screen. Nothing hardcodes a status list.
 */

export const PASSPORT_STATUSES = [
  'submitted',
  'on_hold',
  'ready',
  'added',
  'booked',
  'completed',
  'cancelled',
  'rejected',
] as const;

export type PassportStatus = (typeof PASSPORT_STATUSES)[number];

/** States a passport can still move on from. */
export const ACTIVE_STATUSES: readonly PassportStatus[] = [
  'submitted',
  'on_hold',
  'ready',
  'added',
  'booked',
];

/** States that end a passport's life; nothing transitions out of them. */
export const TERMINAL_STATUSES: readonly PassportStatus[] = ['completed', 'cancelled', 'rejected'];

export const STATUS_LABELS: Record<PassportStatus, string> = {
  submitted: 'Submitted',
  on_hold: 'On hold',
  ready: 'Ready',
  added: 'Added to main dashboard',
  booked: 'Booked',
  completed: 'Completed',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
};

export const STATUS_DESCRIPTIONS: Record<PassportStatus, string> = {
  submitted: 'The agency has entered it. Sitting in the intake queue.',
  on_hold: 'The agency asked us to wait before starting on this one.',
  ready: 'Cleared to be taken in — details check out, nothing blocking it.',
  added: 'Handed off into the main booking dashboard. Not yet confirmed booked.',
  booked: 'An appointment is confirmed. Only a booking-file import can set this.',
  completed: 'Finished and closed.',
  cancelled: 'Cancelled before completion.',
  rejected: 'Rejected — for example a duplicate resolved against this record.',
};

/**
 * How a status change is allowed to happen.
 *
 *  - `manual`      — an admin or (where permitted) an agency may make this move.
 *  - `booking_import` — ONLY importing a real booking file. This is the rule that keeps
 *    this portal and the main dashboard from disagreeing: nothing else may set `booked`,
 *    no matter how convenient a manual override would look.
 *  - `system`      — the portal makes the move on its own (a hold date passing).
 */
export type TransitionActorKind = 'manual' | 'booking_import' | 'system';

export interface Transition {
  readonly to: PassportStatus;
  readonly via: readonly TransitionActorKind[];
  /** Roles allowed to trigger a `manual` move. Agencies are deliberately restricted. */
  readonly roles: readonly ('admin' | 'agency')[];
  readonly note?: string;
}

export const TRANSITIONS: Record<PassportStatus, readonly Transition[]> = {
  submitted: [
    { to: 'on_hold', via: ['manual'], roles: ['admin', 'agency'] },
    { to: 'ready', via: ['manual'], roles: ['admin'] },
    { to: 'cancelled', via: ['manual'], roles: ['admin', 'agency'] },
    { to: 'rejected', via: ['manual'], roles: ['admin'] },
  ],
  on_hold: [
    {
      to: 'submitted',
      via: ['manual', 'system'],
      roles: ['admin', 'agency'],
      note: 'Surfaces automatically once holdUntil has passed.',
    },
    { to: 'ready', via: ['manual'], roles: ['admin'] },
    { to: 'cancelled', via: ['manual'], roles: ['admin', 'agency'] },
    { to: 'rejected', via: ['manual'], roles: ['admin'] },
  ],
  ready: [
    { to: 'on_hold', via: ['manual'], roles: ['admin'] },
    { to: 'added', via: ['manual'], roles: ['admin'], note: 'Bulk mark-as-added after a handoff export.' },
    { to: 'cancelled', via: ['manual'], roles: ['admin'] },
    { to: 'rejected', via: ['manual'], roles: ['admin'] },
  ],
  added: [
    {
      to: 'booked',
      via: ['booking_import'],
      roles: ['admin'],
      note: 'Import of a real booking file only. Never a manual edit or a direct API call.',
    },
    { to: 'ready', via: ['manual'], roles: ['admin'], note: 'Undo a mistaken handoff.' },
    { to: 'cancelled', via: ['manual'], roles: ['admin'] },
    { to: 'rejected', via: ['manual'], roles: ['admin'] },
  ],
  booked: [
    { to: 'completed', via: ['manual'], roles: ['admin'] },
    { to: 'cancelled', via: ['manual'], roles: ['admin'] },
    {
      to: 'added',
      via: ['booking_import'],
      roles: ['admin'],
      note: 'Only by undoing the import batch that booked it.',
    },
  ],
  completed: [],
  cancelled: [],
  rejected: [],
};

/** The one status no manual path may ever reach. Enforced in the DAL, not just the UI. */
export const IMPORT_ONLY_STATUSES: readonly PassportStatus[] = ['booked'];

export interface TransitionRequest {
  readonly from: PassportStatus;
  readonly to: PassportStatus;
  readonly via: TransitionActorKind;
  readonly role: 'admin' | 'agency';
}

export interface TransitionCheck {
  readonly allowed: boolean;
  readonly reason?: string;
}

export function checkTransition({ from, to, via, role }: TransitionRequest): TransitionCheck {
  if (from === to) return { allowed: false, reason: `Passport is already ${STATUS_LABELS[to]}.` };

  const transition = TRANSITIONS[from].find((t) => t.to === to);
  if (!transition) {
    return { allowed: false, reason: `A passport cannot move from ${STATUS_LABELS[from]} to ${STATUS_LABELS[to]}.` };
  }
  if (!transition.via.includes(via)) {
    return {
      allowed: false,
      reason:
        via === 'manual' && transition.via.includes('booking_import')
          ? `${STATUS_LABELS[to]} can only be set by importing a booking file.`
          : `That change cannot be made this way.`,
    };
  }
  if (via === 'manual' && !transition.roles.includes(role)) {
    return { allowed: false, reason: 'You do not have permission to make that change.' };
  }
  return { allowed: true };
}

/** Statuses an agency is allowed to edit the passport's details in. After booking, it locks. */
export const AGENCY_EDITABLE_STATUSES: readonly PassportStatus[] = [
  'submitted',
  'on_hold',
  'ready',
  'added',
];

export function isAgencyEditable(status: PassportStatus): boolean {
  return AGENCY_EDITABLE_STATUSES.includes(status);
}
