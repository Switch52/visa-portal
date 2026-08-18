/**
 * Validation level two: `$jsonSchema` validators applied to the collections themselves.
 *
 * These run inside MongoDB, so they hold even when the write does not come from the app —
 * a migration script, a bulk import, or somebody poking at the Atlas console at midnight.
 * Migration 001 applies them; changing one means writing a new numbered migration.
 */

import { CURRENCY_CODES } from '@/config/currencies';
import { PASSPORT_STATUSES } from '@/config/statuses';
import { APPLICATION_TYPES, GENDERS, PRIORITIES } from '@/config/validation';

type JsonSchema = Record<string, unknown>;

const objectId = { bsonType: 'objectId' };
const date = { bsonType: 'date' };
const nullableDate = { bsonType: ['date', 'null'] };
const nullableString = { bsonType: ['string', 'null'] };
const nullableObjectId = { bsonType: ['objectId', 'null'] };

const timestamps = {
  createdAt: date,
  updatedAt: date,
  deletedAt: nullableDate,
};

export const agencySchema: JsonSchema = {
  bsonType: 'object',
  required: ['name', 'nameNormalized', 'defaultCurrency', 'active', 'createdAt', 'updatedAt'],
  properties: {
    _id: objectId,
    name: { bsonType: 'string', minLength: 1, maxLength: 120 },
    nameNormalized: { bsonType: 'string', minLength: 1 },
    contactName: nullableString,
    contactEmail: nullableString,
    contactPhone: nullableString,
    defaultCurrency: { enum: CURRENCY_CODES },
    internalNotes: nullableString,
    active: { bsonType: 'bool' },
    ...timestamps,
  },
};

export const userSchema: JsonSchema = {
  bsonType: 'object',
  required: ['name', 'email', 'emailNormalized', 'role', 'agencyId', 'active', 'createdAt', 'updatedAt'],
  properties: {
    _id: objectId,
    name: { bsonType: 'string', minLength: 1, maxLength: 120 },
    email: { bsonType: 'string' },
    emailNormalized: { bsonType: 'string', pattern: '^[^A-Z\\s]+@[^A-Z\\s]+$' },
    role: { enum: ['admin', 'agency'] },
    // An agency user must carry an agency; an admin must not. Enforced below, not here,
    // because $jsonSchema cannot express the dependency on its own.
    agencyId: nullableObjectId,
    active: { bsonType: 'bool' },
    /**
     * The Clerk user this record is linked to, or null until they first sign in.
     *
     * Clerk answers "who is this"; this collection answers "what may they do". Keeping
     * the second half here is what preserves invite-only access — a Clerk account with
     * no row here gets nothing — and what makes deactivation immediate, since `active`
     * is re-read on every request rather than trusted from a token.
     */
    clerkUserId: nullableString,
    lastLoginAt: nullableDate,
    invitedBy: nullableObjectId,
    invitedAt: nullableDate,
    ...timestamps,
  },
};

/** The role/agency dependency, expressed as a plain query predicate alongside the schema. */
export const userValidatorExpression = {
  $or: [
    { role: 'admin', agencyId: null },
    { role: 'agency', agencyId: { $type: 'objectId' } },
  ],
};

export const routeSchema: JsonSchema = {
  bsonType: 'object',
  required: [
    'originCountry',
    'destinationCountry',
    'appointmentCenter',
    'centerNormalized',
    'displayLabel',
    'feeMinor',
    'feeCurrency',
    'active',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    _id: objectId,
    originCountry: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
    destinationCountry: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
    appointmentCenter: { bsonType: 'string', minLength: 1, maxLength: 120 },
    centerNormalized: { bsonType: 'string', minLength: 1 },
    displayLabel: { bsonType: 'string', minLength: 1 },
    // Money is always an integer in minor units with its own currency attached. `long` is
    // accepted alongside `int` so a large amount in a low-value currency still validates.
    feeMinor: { bsonType: ['int', 'long'], minimum: 0 },
    feeCurrency: { enum: CURRENCY_CODES },
    active: { bsonType: 'bool' },
    ...timestamps,
  },
};

export const passportSchema: JsonSchema = {
  bsonType: 'object',
  required: [
    'firstName',
    'lastName',
    'passportNumber',
    'passportNumberNormalized',
    'passportExpiryDate',
    'dateOfBirth',
    'nationality',
    'gender',
    'agencyId',
    'routeId',
    'submittedAt',
    'applicationType',
    'priority',
    'status',
    'statusHistory',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    _id: objectId,
    firstName: { bsonType: 'string', minLength: 1, maxLength: 100 },
    lastName: { bsonType: 'string', minLength: 1, maxLength: 100 },
    passportNumber: { bsonType: 'string', minLength: 5, maxLength: 20 },
    passportNumberNormalized: { bsonType: 'string', pattern: '^[A-Z0-9]{5,20}$' },
    passportExpiryDate: date,
    dateOfBirth: date,
    nationality: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
    gender: { enum: [...GENDERS] },
    contactNumber: nullableString,
    contactNumberDialCode: { bsonType: ['string', 'null'], pattern: '^[0-9]{1,6}$' },
    contactEmail: nullableString,
    agencyId: objectId,
    routeId: objectId,
    submittedAt: date,
    submittedBy: nullableObjectId,
    applicationType: { enum: [...APPLICATION_TYPES] },
    // Shared by the members of one family application; absent for a single applicant.
    groupRef: nullableString,
    priority: { enum: [...PRIORITIES] },
    holdUntil: nullableDate,
    notes: nullableString,
    status: { enum: [...PASSPORT_STATUSES] },
    statusHistory: {
      bsonType: 'array',
      items: {
        bsonType: 'object',
        required: ['status', 'at', 'actorRole', 'via'],
        properties: {
          status: { enum: [...PASSPORT_STATUSES] },
          at: date,
          actorId: nullableObjectId,
          actorRole: { enum: ['admin', 'agency', 'system'] },
          via: { enum: ['manual', 'booking_import', 'system', 'migration'] },
          note: nullableString,
        },
      },
    },
    addedAt: nullableDate,
    addedBy: nullableObjectId,
    bookingId: nullableObjectId,
    source: { bsonType: ['object', 'null'] },
    ...timestamps,
  },
};

export const sessionSchema: JsonSchema = {
  bsonType: 'object',
  required: ['userId', 'tokenHash', 'createdAt', 'expiresAt', 'lastSeenAt'],
  properties: {
    _id: objectId,
    userId: objectId,
    tokenHash: { bsonType: 'string', minLength: 32 },
    createdAt: date,
    expiresAt: date,
    lastSeenAt: date,
    revokedAt: nullableDate,
    ipHash: nullableString,
    userAgent: nullableString,
    viewingAsAgencyId: nullableObjectId,
    viewAsStartedAt: nullableDate,
  },
};

export const otpSchema: JsonSchema = {
  bsonType: 'object',
  required: ['emailNormalized', 'codeHash', 'createdAt', 'expiresAt', 'attempts'],
  properties: {
    _id: objectId,
    emailNormalized: { bsonType: 'string' },
    codeHash: { bsonType: 'string', minLength: 32 },
    createdAt: date,
    expiresAt: date,
    attempts: { bsonType: ['int', 'long'], minimum: 0 },
    consumedAt: nullableDate,
    invalidatedAt: nullableDate,
    ipHash: nullableString,
  },
};

export const auditLogSchema: JsonSchema = {
  bsonType: 'object',
  required: ['at', 'actorRole', 'action', 'entity'],
  properties: {
    _id: objectId,
    at: date,
    actorId: nullableObjectId,
    actorRole: { enum: ['admin', 'agency', 'system'] },
    onBehalfOfAgencyId: nullableObjectId,
    action: { bsonType: 'string', minLength: 1 },
    entity: { bsonType: 'string', minLength: 1 },
    entityId: nullableObjectId,
    agencyId: nullableObjectId,
  },
};

export const COLLECTION_VALIDATORS: Record<string, JsonSchema> = {
  agencies: agencySchema,
  users: userSchema,
  routes: routeSchema,
  passports: passportSchema,
  sessions: sessionSchema,
  otps: otpSchema,
  audit_log: auditLogSchema,
};
