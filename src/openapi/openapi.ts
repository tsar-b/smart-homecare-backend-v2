import { env } from '../core/env.js';
import { BOOKING_TIMEZONE } from '../modules/bookings/booking.time.js';

const jsonBody = (schema: Record<string, unknown>) => ({
  required: true,
  content: { 'application/json': { schema } }
});

const jsonResponse = (description: string, schema?: Record<string, unknown>) => ({
  description,
  ...(schema ? { content: { 'application/json': { schema } } } : {})
});

const errorResponse = { $ref: '#/components/responses/Error' };
const authenticatedErrors = { '401': errorResponse, '403': errorResponse };
const bookingCreateResponses = {
  '201': {
    ...jsonResponse('Booking created, or original submission snapshot replayed. A replay is not current booking status; refresh detail/history.', { $ref: '#/components/schemas/Booking' }),
    headers: { 'Idempotency-Replayed': { description: 'Present with value true when replaying an already committed submission.', schema: { type: 'string', enum: ['true'] } } }
  },
  '400': errorResponse,
  '409': jsonResponse('IDEMPOTENCY_CONFLICT: changed retry identity/body/scope; BOOKING_RETRY_REVIEW_REQUIRED: ambiguous historical submission, inspect history before resubmitting; BOOKING_SLOT_UNAVAILABLE or BOOKING_SLOT_IN_PAST: new booking cannot claim this slot. Never automatically rotate IDs to resolve an uncertain previous booking.', { $ref: '#/components/schemas/Error' }),
  '503': jsonResponse('IDEMPOTENCY_STORE_UNAVAILABLE: retry RPC/migration/permissions unavailable, or commit response uncertain. Preserve draft, Idempotency-Key, client_request_id, endpoint and identical body; retry the same request after recovery. No direct-insert fallback.', { $ref: '#/components/schemas/Error' }),
  ...authenticatedErrors
};
const browserStartProperties = {
  redirectUri: { type: 'string', maxLength: 500, description: 'Exact server-allowlisted callback URI without query or fragment.' },
  state: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  codeChallenge: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' }
};
const exchangeProperties = {
  code: { type: 'string', minLength: 1, maxLength: 2048 },
  codeVerifier: { type: 'string', minLength: 43, maxLength: 128 }
};
const providerProperty = { type: 'string', enum: ['kakao', 'apple', 'google'] };
const browserErrors = { '400': errorResponse, '401': errorResponse, '403': errorResponse, '409': errorResponse, '429': errorResponse, '503': errorResponse };
const idParameter = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' }
};

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Smart HomeCare Backend API',
    version: '2.0.0',
    description: 'Supabase-only API for SHC authentication, catalog, bookings, private booking media, profiles, and administration.'
  },
  servers: [{ url: env.PUBLIC_API_URL }],
  tags: [
    { name: 'System' },
    { name: 'Authentication' },
    { name: 'Users' },
    { name: 'Catalog' },
    { name: 'Bookings' },
    { name: 'Kakao' },
    { name: 'Admin' }
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'Supabase access token' }
    },
    parameters: {
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string', minLength: 8, maxLength: 200 },
        description: 'Stable key reused with the same client_request_id, endpoint and exact body for an identical booking retry, including after an uncertain 503/network response. Committed receipts have no automatic TTL. Reusing an identity with changed content conflicts; do not mint a new key to hide an unknown outcome.'
      }
    },
    responses: {
      Error: {
        description: 'Request failed',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
      }
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          details: {},
          requestId: { type: 'string' }
        }
      },
      Profile: {
        type: 'object',
        required: ['id', '_id', 'isAdmin', 'isGuest'],
        properties: {
          id: { type: 'string' },
          _id: { type: 'string', description: 'Legacy frontend alias for id.' },
          userId: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
          name: { type: ['string', 'null'] },
          phone: { type: ['string', 'null'] },
          email: { type: ['string', 'null'], format: 'email' },
          provider: { type: ['string', 'null'], enum: ['standard', 'guest', 'kakao', 'apple', 'google', null] },
          isAdmin: { type: 'boolean' },
          isGuest: { type: 'boolean' },
          emailVerified: { type: 'boolean' },
          address: { type: ['string', 'null'] },
          addressDetail: { type: ['string', 'null'] },
          createdAt: { type: ['string', 'null'], format: 'date-time' },
          updatedAt: { type: ['string', 'null'], format: 'date-time' }
        }
      },
      Session: {
        type: 'object',
        required: ['token', 'accessToken', 'refreshToken', 'user', 'requiresEmailConfirmation'],
        properties: {
          token: { type: ['string', 'null'], description: 'Legacy alias for accessToken.' },
          accessToken: { type: ['string', 'null'] },
          refreshToken: { type: ['string', 'null'] },
          expiresAt: { type: ['integer', 'null'] },
          expiresIn: { type: ['integer', 'null'] },
          user: { $ref: '#/components/schemas/Profile' },
          requiresEmailConfirmation: { type: 'boolean' }
        }
      },
      RegistrationPending: {
        type: 'object',
        required: ['token', 'accessToken', 'refreshToken', 'expiresAt', 'expiresIn', 'user', 'requiresEmailConfirmation'],
        properties: {
          token: { type: 'null' },
          accessToken: { type: 'null' },
          refreshToken: { type: 'null' },
          expiresAt: { type: 'null' },
          expiresIn: { type: 'null' },
          user: { type: 'null' },
          requiresEmailConfirmation: { const: true }
        },
        additionalProperties: false
      },
      RegisterInput: {
        type: 'object',
        required: ['name', 'email', 'password'],
        properties: {
          name: { type: 'string', maxLength: 120 },
          phone: { type: 'string', maxLength: 50 },
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8, maxLength: 200 },
          address: { type: 'string', maxLength: 500 },
          addressDetail: { type: 'string', maxLength: 500 }
        }
      },
      LoginInput: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', maxLength: 200 }
        }
      },
      GuestInput: {
        type: 'object',
        required: ['name', 'phone', 'address'],
        properties: {
          name: { type: 'string', maxLength: 120 },
          phone: { type: 'string', maxLength: 50 },
          address: { type: 'string', maxLength: 500 },
          addressDetail: { type: 'string', maxLength: 500 }
        }
      },
      SelectedOption: {
        type: 'object',
        required: ['option_id', 'value'],
        properties: {
          option_id: { type: 'string' },
          value: { type: 'string', maxLength: 200 }
        }
      },
      BookingCreate: {
        type: 'object',
        required: [
          'client_request_id',
          'subtype_id',
          'service_type_id',
          'pricing_tier_id',
          'reservation_date',
          'reservation_time'
        ],
        properties: {
          client_request_id: { type: 'string', format: 'uuid' },
          subtype_id: { type: 'string' },
          service_type_id: { type: 'string' },
          pricing_tier_id: { type: 'string' },
          options: { type: 'array', maxItems: 30, items: { $ref: '#/components/schemas/SelectedOption' } },
          name: { type: 'string' },
          phone: { type: 'string' },
          address: { type: 'string' },
          addressDetail: { type: 'string' },
          reservation_date: { type: 'string', format: 'date' },
          reservation_time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
          timezone: {
            type: 'string', default: BOOKING_TIMEZONE,
            description: 'Compatibility input: valid IANA values are accepted, but new bookings always use Asia/Seoul business-local date/time without conversion.'
          },
          memo: { type: 'string', maxLength: 2000 },
          symptom: { type: 'string', maxLength: 2000 }
        },
        additionalProperties: false
      },
      LegacyBookingCreate: {
        type: 'object',
        description: 'Deprecated V1 compatibility request. New clients must use /api/bookings.',
        required: ['client_request_id', 'reservation_date', 'reservation_time'],
        properties: {
          client_request_id: { type: 'string', format: 'uuid' },
          asset_id: { type: 'string' },
          subtype_id: { type: 'string' },
          subtype: { type: 'string' },
          service_type_id: { type: 'string' },
          service_type: { type: 'string' },
          pricing_tier_id: { type: 'string' },
          tier: { type: 'string' },
          total_price: { type: 'integer', minimum: -1 },
          options: { type: 'array', maxItems: 30, items: { $ref: '#/components/schemas/SelectedOption' } },
          reservation_date: { type: 'string', format: 'date' },
          reservation_time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
          timezone: {
            type: 'string', default: BOOKING_TIMEZONE,
            description: 'Compatibility input: valid IANA values are accepted, but new bookings always use Asia/Seoul business-local date/time without conversion.'
          }
        },
        allOf: [
          { anyOf: [{ required: ['subtype_id'] }, { required: ['asset_id'] }, { required: ['subtype'] }] },
          { anyOf: [{ required: ['service_type_id'] }, { required: ['service_type'] }] }
        ]
      },
      Booking: {
        type: 'object',
        required: ['id', 'status', 'reservationDate', 'reservationTime', 'totalPrice'],
        properties: {
          id: { type: 'string' },
          _id: { type: 'string' },
          user_id: { type: 'string' },
          serviceType: { type: 'string' },
          serviceTypeId: { type: 'string' },
          serviceLabel: { type: 'string' },
          subtype: { type: 'string' },
          subtypeId: { type: 'string' },
          pricingTierId: { type: ['string', 'null'] },
          options: { type: 'array', items: { type: 'object', additionalProperties: true } },
          reservationDate: { type: 'string', format: 'date' },
          reservationTime: { type: 'string' },
          status: { type: 'string' },
          totalPrice: { type: 'integer', minimum: -1 },
          price_source: { type: 'string', enum: ['catalog', 'legacy_client'] }
        },
        additionalProperties: true
      },
      BookingAttachment: {
        type: 'object',
        required: ['id', 'clientAttachmentId', 'bookingId', 'kind', 'contentType', 'sizeBytes', 'status', 'createdAt', 'completedAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          clientAttachmentId: { type: 'string', format: 'uuid' },
          bookingId: { type: 'string' },
          kind: { type: 'string', enum: ['image', 'video'] },
          contentType: {
            type: 'string',
            enum: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime']
          },
          sizeBytes: { type: 'integer', minimum: 1, maximum: 45000000 },
          status: { type: 'string', enum: ['pending', 'ready'] },
          createdAt: { type: 'string', format: 'date-time' },
          completedAt: { type: ['string', 'null'], format: 'date-time' }
        },
        additionalProperties: false
      },
      BookingAttachmentIntentInput: {
        type: 'object',
        required: ['clientAttachmentId', 'kind', 'contentType', 'sizeBytes'],
        properties: {
          clientAttachmentId: { type: 'string', format: 'uuid' },
          kind: { type: 'string', enum: ['image', 'video'] },
          contentType: {
            type: 'string',
            enum: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime']
          },
          sizeBytes: { type: 'integer', minimum: 1, maximum: 45000000 }
        },
        additionalProperties: false
      },
      BookingAttachmentUploadIntent: {
        type: 'object',
        required: [
          'attachment',
          'uploadMethod',
          'signedUrl',
          'tusEndpoint',
          'uploadToken',
          'storageApiKey',
          'chunkSizeBytes',
          'expiresAt',
          'bucketId',
          'objectPath'
        ],
        properties: {
          attachment: { $ref: '#/components/schemas/BookingAttachment' },
          uploadMethod: {
            type: 'string',
            enum: ['signed_put', 'tus'],
            description: 'tus is returned only when the trusted booking-media pilot is enabled.'
          },
          signedUrl: { type: ['string', 'null'], format: 'uri' },
          tusEndpoint: { type: ['string', 'null'], format: 'uri' },
          uploadToken: {
            type: 'string',
            description: 'Short-lived path-bound capability. Never persist or log it; use it as x-signature for TUS.'
          },
          storageApiKey: {
            type: ['string', 'null'],
            description: 'Public Supabase publishable/anon key required as apikey by signed TUS. Null for signed PUT. This is never a backend secret/service-role key.'
          },
          chunkSizeBytes: { type: 'integer', const: 6291456 },
          expiresAt: {
            type: 'string',
            format: 'date-time',
            description: 'Signed token expiry. Internal orphan-prevention tombstones use a longer worst-case TUS window.'
          },
          bucketId: { type: 'string', enum: ['shc-booking-images-v1', 'shc-booking-videos-v1'] },
          objectPath: { type: 'string' }
        },
        additionalProperties: false
      },
      BookingAttachmentDownload: {
        type: 'object',
        required: ['downloadUrl', 'downloadUrlExpiresAt'],
        properties: {
          downloadUrl: { type: 'string', format: 'uri' },
          downloadUrlExpiresAt: { type: 'string', format: 'date-time' }
        },
        additionalProperties: false
      }
    }
  },
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        operationId: 'health',
        security: [],
        responses: { '200': jsonResponse('Process is alive', { type: 'object', properties: { ok: { const: true } } }) }
      }
    },
    '/ready': {
      get: {
        tags: ['System'],
        operationId: 'readiness',
        description: 'Checks Supabase Auth/database reachability, private media buckets and atomic booking retry RPC/permissions. Requires migration 20261013042516_atomic_booking_retry.sql after 001-008 before deploying this API; no mixed old/new booking writers. It does not prove Storage RLS or native/provider flows; run the separate deployment acceptance checks.',
        security: [],
        responses: {
          '200': jsonResponse('Required Supabase and booking retry readiness checks passed; not a claim of completed native/cloud acceptance'),
          '503': jsonResponse('A Supabase dependency or required atomic booking retry migration/RPC/permission is unavailable; health may still be 200')
        }
      }
    },
    '/api/app/initialize': {
      get: {
        tags: ['Catalog'],
        operationId: 'initializeApp',
        security: [],
        responses: { '200': jsonResponse('Versioned catalog and application bootstrap payload') }
      }
    },
    '/api/auth/browser/config': {
      get: { tags: ['Authentication'], operationId: 'browserAuthConfig', security: [],
        responses: { '200': jsonResponse('Enabled providers and recovery support; no-store', {
          type: 'object', properties: { providers: { type: 'array', items: providerProperty }, recovery: { type: 'boolean' } }
        }) } }
    },
    '/api/auth/oauth/start': {
      post: { tags: ['Authentication'], operationId: 'startBrowserOAuth', security: [],
        description: 'Shared browser-PKCE start for Google, Apple and Kakao. Mobile development route-check buttons use this exact endpoint, not a fake login. Backend provider enablement is always required (OAUTH_PROVIDER_DISABLED / 503), plus exact callback allowlisting (AUTH_REDIRECT_INVALID / 400). Supabase provider credentials/configuration must also be completed before real sign-in can work.',
        requestBody: jsonBody({ type: 'object', additionalProperties: false,
          required: ['provider', 'redirectUri', 'state', 'codeChallenge'], properties: { ...browserStartProperties, provider: providerProperty } }),
        responses: { '200': jsonResponse('Supabase authorization URL; no-store', { type: 'object', properties: { authorizationUrl: { type: 'string', format: 'uri' } } }), ...browserErrors } }
    },
    '/api/auth/oauth/exchange': {
      post: { tags: ['Authentication'], operationId: 'exchangeBrowserOAuth', security: [],
        requestBody: jsonBody({ type: 'object', additionalProperties: false,
          required: ['provider', 'code', 'codeVerifier'], properties: { ...exchangeProperties, provider: providerProperty } }),
        responses: { '200': jsonResponse('Verified SHC session; no-store', { $ref: '#/components/schemas/Session' }), ...browserErrors } }
    },
    '/api/auth/recovery/start': {
      post: { tags: ['Authentication'], operationId: 'requestPasswordRecovery', security: [],
        requestBody: jsonBody({ type: 'object', additionalProperties: false,
          required: ['email', 'redirectUri', 'state', 'codeChallenge'], properties: { ...browserStartProperties, email: { type: 'string', format: 'email', maxLength: 254 } } }),
        responses: { '202': jsonResponse('Generic response regardless of account existence; no-store'), ...browserErrors } }
    },
    '/api/auth/recovery/finish': {
      post: { tags: ['Authentication'], operationId: 'finishPasswordRecovery', security: [],
        requestBody: jsonBody({ type: 'object', additionalProperties: false,
          required: ['code', 'codeVerifier', 'password'], properties: { ...exchangeProperties,
            password: { type: 'string', minLength: 8, maxLength: 200, description: 'At least one Latin letter and one digit; whitespace is preserved.' } } }),
        responses: { '200': jsonResponse('Password changed; no app session returned; sign in again'), ...browserErrors } }
    },
    '/api/auth/register': {
      post: {
        tags: ['Authentication'],
        operationId: 'register',
        security: [],
        requestBody: jsonBody({ $ref: '#/components/schemas/RegisterInput' }),
        responses: {
          '201': jsonResponse('Confirmed account and SHC profile created', { $ref: '#/components/schemas/Session' }),
          '202': jsonResponse('Email confirmation required; no SHC profile has been read or linked', { $ref: '#/components/schemas/RegistrationPending' }),
          '400': errorResponse,
          '409': errorResponse
        }
      }
    },
    '/api/auth/login': {
      post: {
        tags: ['Authentication'],
        operationId: 'login',
        security: [],
        requestBody: jsonBody({ $ref: '#/components/schemas/LoginInput' }),
        responses: { '200': jsonResponse('Supabase session issued', { $ref: '#/components/schemas/Session' }), '401': errorResponse }
      }
    },
    '/api/auth/guest': {
      post: {
        tags: ['Authentication'],
        operationId: 'registerGuest',
        security: [],
        requestBody: jsonBody({ $ref: '#/components/schemas/GuestInput' }),
        description: 'Disabled until verified phone ownership is implemented.',
        responses: { '503': jsonResponse('GUEST_VERIFICATION_REQUIRED', { $ref: '#/components/schemas/Error' }) }
      }
    },
    '/api/auth/apple': {
      post: {
        tags: ['Authentication'],
        operationId: 'loginApple',
        security: [],
        requestBody: jsonBody({
          type: 'object',
          required: ['identityToken'],
          properties: {
            identityToken: { type: 'string' },
            authorizationCode: { type: 'string' },
            name: { type: 'string' }
          }
        }),
        responses: { '200': jsonResponse('Apple identity verified and session issued', { $ref: '#/components/schemas/Session' }), '401': errorResponse, '503': errorResponse }
      }
    },
    '/api/auth/refresh': {
      post: {
        tags: ['Authentication'],
        operationId: 'refreshSession',
        security: [],
        requestBody: jsonBody({
          type: 'object',
          properties: { refresh_token: { type: 'string' }, refreshToken: { type: 'string' } },
          anyOf: [{ required: ['refresh_token'] }, { required: ['refreshToken'] }]
        }),
        responses: { '200': jsonResponse('Rotated Supabase session', { $ref: '#/components/schemas/Session' }), '401': errorResponse }
      }
    },
    '/api/auth/logout': {
      post: {
        tags: ['Authentication'],
        operationId: 'logout',
        security: [{ bearerAuth: [] }],
        responses: { '204': jsonResponse('All sessions revoked'), ...authenticatedErrors }
      }
    },
    '/api/auth/password': {
      patch: {
        tags: ['Authentication'],
        operationId: 'updatePassword',
        security: [{ bearerAuth: [] }],
        requestBody: jsonBody({
          type: 'object',
          required: ['password'],
          properties: { password: { type: 'string', minLength: 8, maxLength: 200 } }
        }),
        responses: { '200': jsonResponse('Password updated'), ...authenticatedErrors }
      }
    },
    '/api/users/me': {
      get: {
        tags: ['Users'],
        operationId: 'getCurrentUser',
        security: [{ bearerAuth: [] }],
        responses: { '200': jsonResponse('Current SHC profile', { $ref: '#/components/schemas/Profile' }), ...authenticatedErrors }
      },
      patch: {
        tags: ['Users'],
        operationId: 'updateCurrentUser',
        security: [{ bearerAuth: [] }],
        requestBody: jsonBody({ type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, phone: { type: 'string' }, address: { type: 'string' }, addressDetail: { type: ['string', 'null'] }, password: { type: 'string', minLength: 8 } } }),
        responses: { '200': jsonResponse('Updated SHC profile', { $ref: '#/components/schemas/Profile' }), ...authenticatedErrors }
      },
      delete: {
        tags: ['Users'],
        operationId: 'deleteCurrentUser',
        security: [{ bearerAuth: [] }],
        responses: {
          '503': jsonResponse('ACCOUNT_DELETION_UNAVAILABLE until complete erasure and provider revocation exist', { $ref: '#/components/schemas/Error' }),
          ...authenticatedErrors
        }
      }
    },
    '/api/catalog/initialize': {
      get: { tags: ['Catalog'], operationId: 'initializeBookingCatalog', security: [], responses: { '200': jsonResponse('Legacy-compatible nested booking catalog') } }
    },
    '/api/catalog/service-types': {
      get: { tags: ['Catalog'], operationId: 'listServiceTypes', security: [], responses: { '200': jsonResponse('Service types') } }
    },
    '/api/catalog/options': {
      get: { tags: ['Catalog'], operationId: 'listRequestOptions', security: [], responses: { '200': jsonResponse('Booking options') } }
    },
    '/api/catalog/pricing': {
      get: { tags: ['Catalog'], operationId: 'listPricingTiers', security: [], responses: { '200': jsonResponse('Pricing tiers') } }
    },
    '/api/bookings': {
      post: {
        tags: ['Bookings'],
        operationId: 'createBooking',
        description: 'Atomically commits the booking and durable private receipt. Retry an uncertain response with the same identity/body/endpoint. An original 201 snapshot can replay even after cancellation or date passage; fetch detail/history for current status. Requires the atomic-booking migration before this API accepts writes.',
        security: [{ bearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: jsonBody({ $ref: '#/components/schemas/BookingCreate' }),
        responses: bookingCreateResponses
      }
    },
    '/api/booking': {
      post: {
        tags: ['Bookings'],
        operationId: 'createLegacyBooking',
        deprecated: true,
        description: 'Temporary V1 compatibility route. It is the only route that accepts legacy client total_price. Uses the same atomic retry receipts; retry against this same route rather than changing to the canonical endpoint. Requires the atomic-booking migration and no mixed old/new writers.',
        security: [{ bearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: jsonBody({ $ref: '#/components/schemas/LegacyBookingCreate' }),
        responses: bookingCreateResponses
      }
    },
    '/api/bookings/history': {
      get: {
        tags: ['Bookings'],
        operationId: 'getBookingHistory',
        security: [{ bearerAuth: [] }],
        responses: { '200': jsonResponse('Current user booking history', { type: 'array', items: { $ref: '#/components/schemas/Booking' } }), ...authenticatedErrors }
      }
    },
    '/api/bookings/availability': {
      get: {
        tags: ['Bookings'],
        operationId: 'getBookingAvailability',
        security: [],
        parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }],
        responses: { '200': jsonResponse('Configured slots with live availability', { type: 'array', items: { type: 'object', required: ['time', 'available'], properties: { time: { type: 'string' }, available: { type: 'boolean' } } } }) }
      }
    },
    '/api/bookings/{id}': {
      get: {
        tags: ['Bookings'],
        operationId: 'getBooking',
        security: [{ bearerAuth: [] }],
        parameters: [idParameter],
        responses: { '200': jsonResponse('Owned booking detail', { $ref: '#/components/schemas/Booking' }), '404': errorResponse, ...authenticatedErrors }
      }
    },
    '/api/bookings/{id}/cancel': {
      patch: {
        tags: ['Bookings'],
        operationId: 'cancelBooking',
        security: [{ bearerAuth: [] }],
        parameters: [idParameter],
        responses: { '200': jsonResponse('Booking cancelled', { $ref: '#/components/schemas/Booking' }), '409': errorResponse, ...authenticatedErrors }
      }
    },
    '/api/bookings/{bookingId}/attachments/upload-intents': {
      post: {
        tags: ['Bookings'],
        operationId: 'createBookingAttachmentUploadIntent',
        description: 'Creates a stable private Storage destination. Do not send Idempotency-Key; clientAttachmentId is the retry identity and upload capabilities are never persisted in the generic idempotency store. Upload with object Cache-Control max-age=0. Limits include 12 intents per authenticated user per minute, 12 rows/100000000 reserved bytes per owner, and the service-role-configured project circuit breaker (default 100 rows/500000000 bytes). Video and TUS intents are default-off and require the trusted media pilot flag.',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'bookingId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: jsonBody({ $ref: '#/components/schemas/BookingAttachmentIntentInput' }),
        responses: {
          '200': jsonResponse('Existing pending intent refreshed', { $ref: '#/components/schemas/BookingAttachmentUploadIntent' }),
          '201': jsonResponse('Upload intent created', { $ref: '#/components/schemas/BookingAttachmentUploadIntent' }),
          '400': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
          '429': errorResponse,
          '503': jsonResponse(
            'Media unavailable. BOOKING_MEDIA_PILOT_DISABLED means video/TUS is disabled; PROJECT_MEDIA_LIMIT_REACHED means the service-level reservation circuit breaker is full.',
            { $ref: '#/components/schemas/Error' }
          ),
          ...authenticatedErrors
        }
      }
    },
    '/api/bookings/{bookingId}/attachments': {
      get: {
        tags: ['Bookings'],
        operationId: 'listBookingAttachments',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'bookingId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': jsonResponse('Owned booking attachment metadata; request a download URL only when opening media', {
            type: 'array',
            maxItems: 6,
            items: { $ref: '#/components/schemas/BookingAttachment' }
          }),
          '404': errorResponse,
          '503': errorResponse,
          ...authenticatedErrors
        }
      }
    },
    '/api/bookings/{bookingId}/attachments/{attachmentId}/complete': {
      post: {
        tags: ['Bookings'],
        operationId: 'completeBookingAttachment',
        description: 'Verifies stored size, MIME metadata, and a bounded allowlisted header signature before publishing an uploaded object. This is not full decoding, malware scanning, or duration enforcement.',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'bookingId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'attachmentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }
        ],
        responses: {
          '200': jsonResponse('Attachment is ready', { $ref: '#/components/schemas/BookingAttachment' }),
          '404': errorResponse,
          '409': errorResponse,
          '422': errorResponse,
          '503': errorResponse,
          ...authenticatedErrors
        }
      }
    },
    '/api/bookings/{bookingId}/attachments/{attachmentId}/download-url': {
      get: {
        tags: ['Bookings'],
        operationId: 'getBookingAttachmentDownloadUrl',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'bookingId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'attachmentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }
        ],
        responses: {
          '200': jsonResponse('Fresh five-minute private download capability', { $ref: '#/components/schemas/BookingAttachmentDownload' }),
          '404': errorResponse,
          '503': errorResponse,
          ...authenticatedErrors
        }
      }
    },
    '/api/bookings/{bookingId}/attachments/{attachmentId}': {
      delete: {
        tags: ['Bookings'],
        operationId: 'deleteBookingAttachment',
        description: 'Removes the object and retains a private tombstone until every signed write capability has expired.',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'bookingId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'attachmentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }
        ],
        responses: { '204': { description: 'Attachment hidden and deletion accepted' }, '404': errorResponse, '409': errorResponse, '503': errorResponse, ...authenticatedErrors }
      }
    },
    '/api/kakao/login': {
      post: {
        tags: ['Kakao'],
        operationId: 'loginKakao',
        security: [],
        requestBody: jsonBody({ type: 'object', required: ['accessToken'], properties: { accessToken: { type: 'string' }, shippingAddr: { type: ['object', 'null'], additionalProperties: true } } }),
        responses: { '200': jsonResponse('Kakao identity verified and session issued', { $ref: '#/components/schemas/Session' }), '401': errorResponse }
      }
    },
    '/api/kakao/address': {
      get: {
        tags: ['Kakao'],
        operationId: 'searchKakaoAddress',
        security: [],
        parameters: [{ name: 'query', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { '200': jsonResponse('Kakao address-search response'), '503': errorResponse }
      }
    },
    '/api/kakao/expand-address': {
      get: {
        tags: ['Kakao'],
        operationId: 'expandKakaoAddress',
        security: [],
        parameters: [{ name: 'query', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { '200': jsonResponse('Up to five expanded Kakao addresses'), '503': errorResponse }
      }
    },
    '/api/kakao/delete': {
      delete: {
        tags: ['Kakao'],
        operationId: 'deleteKakaoAccount',
        security: [{ bearerAuth: [] }],
        responses: {
          '503': jsonResponse(
            'ACCOUNT_DELETION_UNAVAILABLE until an account-deleting state, session revocation, provider unlink, Storage purge, and database erasure saga exist',
            { $ref: '#/components/schemas/Error' }
          ),
          ...authenticatedErrors
        }
      }
    },
    '/api/admin/bookings': {
      get: {
        tags: ['Admin'],
        operationId: 'adminListBookings',
        security: [{ bearerAuth: [] }],
        responses: { '200': jsonResponse('Up to 500 bookings', { type: 'array', items: { $ref: '#/components/schemas/Booking' } }), ...authenticatedErrors }
      }
    },
    '/api/admin/bookings/filter': {
      post: {
        tags: ['Admin'],
        operationId: 'adminFilterBookings',
        security: [{ bearerAuth: [] }],
        requestBody: jsonBody({ type: 'object', required: ['start', 'end'], properties: { start: { type: 'string', format: 'date' }, end: { type: 'string', format: 'date' }, status: { type: 'string' } } }),
        responses: { '200': jsonResponse('Filtered bookings', { type: 'array', items: { $ref: '#/components/schemas/Booking' } }), ...authenticatedErrors }
      }
    },
    '/api/admin/bookings/{id}/status': {
      patch: {
        tags: ['Admin'],
        operationId: 'adminUpdateBooking',
        security: [{ bearerAuth: [] }],
        parameters: [idParameter],
        requestBody: jsonBody({ type: 'object', properties: { status: { type: 'string' }, totalPrice: { type: 'integer', minimum: -1 }, options: { type: 'array', items: {} } } }),
        responses: { '200': jsonResponse('Booking updated', { $ref: '#/components/schemas/Booking' }), '404': errorResponse, ...authenticatedErrors }
      }
    },
    '/api/admin/bookings/{id}': {
      get: {
        tags: ['Admin'],
        operationId: 'adminGetBooking',
        security: [{ bearerAuth: [] }],
        parameters: [idParameter],
        responses: { '200': jsonResponse('Booking detail', { $ref: '#/components/schemas/Booking' }), '404': errorResponse, ...authenticatedErrors }
      },
      delete: {
        tags: ['Admin'],
        operationId: 'adminDeleteBooking',
        security: [{ bearerAuth: [] }],
        parameters: [idParameter],
        responses: { '200': jsonResponse('Booking deleted'), '404': errorResponse, '503': errorResponse, ...authenticatedErrors }
      }
    },
    '/api/admin/bookings/{bookingId}/attachments': {
      get: {
        tags: ['Admin'],
        operationId: 'adminListBookingAttachments',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'bookingId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': jsonResponse('Booking attachment metadata; listing writes a best-effort operational audit row but does not mint download capabilities', {
            type: 'array',
            maxItems: 6,
            items: { $ref: '#/components/schemas/BookingAttachment' }
          }),
          '404': errorResponse,
          '503': errorResponse,
          ...authenticatedErrors
        }
      }
    },
    '/api/admin/bookings/{bookingId}/attachments/{attachmentId}/download-url': {
      get: {
        tags: ['Admin'],
        operationId: 'adminGetBookingAttachmentDownloadUrl',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'bookingId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'attachmentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }
        ],
        responses: { '200': jsonResponse('Private download capability with best-effort operational audit', { $ref: '#/components/schemas/BookingAttachmentDownload' }), '404': errorResponse, '503': errorResponse, ...authenticatedErrors }
      }
    },
    '/api/admin/bookings/{bookingId}/attachments/{attachmentId}': {
      delete: {
        tags: ['Admin'],
        operationId: 'adminDeleteBookingAttachment',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'bookingId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'attachmentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }
        ],
        responses: { '204': { description: 'Attachment deletion accepted; best-effort operational audit is attempted' }, '404': errorResponse, '503': errorResponse, ...authenticatedErrors }
      }
    },
    '/api/admin/users': {
      get: {
        tags: ['Admin'],
        operationId: 'adminListUsers',
        security: [{ bearerAuth: [] }],
        responses: { '200': jsonResponse('SHC user profiles', { type: 'array', items: { $ref: '#/components/schemas/Profile' } }), ...authenticatedErrors }
      }
    },
    '/api/admin/users/{id}/role': {
      patch: {
        tags: ['Admin'],
        operationId: 'adminUpdateUserRole',
        security: [{ bearerAuth: [] }],
        parameters: [idParameter],
        requestBody: jsonBody({ type: 'object', required: ['isAdmin'], properties: { isAdmin: { type: 'boolean' } } }),
        responses: { '200': jsonResponse('Admin role updated'), '404': errorResponse, '409': errorResponse, ...authenticatedErrors }
      }
    },
    '/api/admin/users/{id}': {
      delete: {
        tags: ['Admin'],
        operationId: 'adminDeleteUser',
        security: [{ bearerAuth: [] }],
        parameters: [idParameter],
        responses: { '200': jsonResponse('User and dependent records deleted'), '404': errorResponse, '409': errorResponse, '503': errorResponse, ...authenticatedErrors }
      }
    },
    '/api/admin/data/{table}': {
      get: {
        tags: ['Admin'],
        operationId: 'adminListResource',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'table', in: 'path', required: true, schema: { type: 'string', enum: ['requests', 'assets', 'categories', 'options', 'pricings', 'servicetypes', 'subtypes', 'timeslots', 'audit_logs'] } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
          { name: 'sort', in: 'query', schema: { type: 'string' } },
          { name: 'direction', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } }
        ],
        responses: { '200': jsonResponse('Paginated allowlisted resource'), ...authenticatedErrors }
      },
      post: {
        tags: ['Admin'],
        operationId: 'adminCreateResource',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'table', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: jsonBody({ type: 'object', additionalProperties: true }),
        responses: { '201': jsonResponse('Allowlisted catalog resource created'), '400': errorResponse, ...authenticatedErrors }
      }
    },
    '/api/admin/data/{table}/{id}': {
      patch: {
        tags: ['Admin'],
        operationId: 'adminUpdateResource',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'table', in: 'path', required: true, schema: { type: 'string' } }, idParameter],
        requestBody: jsonBody({ type: 'object', additionalProperties: true }),
        responses: { '200': jsonResponse('Allowlisted resource updated'), '404': errorResponse, ...authenticatedErrors }
      },
      delete: {
        tags: ['Admin'],
        operationId: 'adminDeleteResource',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'table', in: 'path', required: true, schema: { type: 'string' } }, idParameter],
        responses: { '200': jsonResponse('Allowlisted resource deleted'), '404': errorResponse, ...authenticatedErrors }
      }
    }
  },
  'x-legacy-aliases': {
    '/api/register': '/api/auth/register',
    '/api/login': '/api/auth/login',
    '/api/booking/initialize': '/api/catalog/initialize',
    '/api/servicetypes': '/api/catalog/service-types',
    '/api/options': '/api/catalog/options',
    '/api/pricing': '/api/catalog/pricing',
    '/api/timeslots': '/api/bookings/availability',
    '/api/history': '/api/bookings/history',
    '/api/historydetail/{id}': '/api/bookings/{id}'
  }
};
