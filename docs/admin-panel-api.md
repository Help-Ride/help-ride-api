# HelpRide Admin Panel API Handoff

This document is intended for frontend/admin-panel implementation. It documents the admin API that already exists in the HelpRide backend.

## Base URLs

Use one of these API base URLs:

```text
Local:      http://localhost:4000/api
Dev:        https://dev-help-ride-api.vercel.app/api
Production: https://help-ride-api.vercel.app/api
```

All endpoint paths below are relative to the `/api` base URL. For example:

```text
GET /admin/dashboard/stats
```

means:

```text
GET https://dev-help-ride-api.vercel.app/api/admin/dashboard/stats
```

## Authentication

All `/admin/*` endpoints require this header:

```http
x-admin-api-key: <ADMIN_API_KEY>
Accept: application/json
```

For JSON write requests, also send:

```http
Content-Type: application/json
```

Important security note: do not put `ADMIN_API_KEY` in a browser bundle or mobile app. A web admin panel should call a server-side admin proxy/BFF that injects this header from server environment variables, or the backend should be extended with proper admin login/session/role auth.

## Error Shape

Most error responses use:

```json
{
  "error": "Human-readable error message"
}
```

Common statuses:

```text
400 invalid input
401 missing/invalid x-admin-api-key
404 record not found
409 business conflict, for example duplicate payout/refund state
500 internal server error
502 upstream Stripe/refund failure
```

## Pagination And Filtering

Most list endpoints use page pagination:

```text
page: 1-based page number, default 1
limit: page size, default 50, max 100
```

Response shape:

```json
{
  "itemsKey": [],
  "total": 0,
  "page": 1,
  "limit": 50
}
```

Support tickets use cursor pagination instead:

```text
limit: default 50, max 100
cursor: previous response nextCursor
```

Date ranges use ISO date strings:

```text
dateFrom=2026-01-01T00:00:00.000Z
dateTo=2026-01-31T23:59:59.999Z
```

## Data Notes

Money fields are mixed:

- Payment records use integer cents, for example `amountCents`, `platformFeeCents`.
- Dashboard revenue fields are decimal dollars, for example `revenue.total`.
- Ride `pricePerSeat` is returned as a number.

Status aliases:

- Ride update accepts `in_progress`, but stores/returns `ongoing`.
- Booking filter `confirmed` includes legacy/current statuses: `confirmed`, `ACCEPTED`, `PAYMENT_PENDING`, `CONFIRMED`.
- Payment filter `paid` includes `paid` and `succeeded`; `pending` includes `pending` and `unpaid`.
- Ride request update `awaiting_payment` maps to backend status `matched`; `rejected` maps to `cancelled`.

## Core Response Shapes

These are representative shapes, not strict TypeScript definitions.

### Driver Admin Shape

```json
{
  "id": "driverProfileId",
  "userId": "userId",
  "name": "Driver Name",
  "email": "driver@example.com",
  "phone": "+14165551234",
  "verificationStatus": "pending",
  "vehicle": {
    "make": "Toyota",
    "model": "Camry",
    "year": "2020",
    "color": "Black",
    "plateNumber": "ABC123"
  },
  "licenseNumber": "LIC123",
  "insuranceInfo": "Policy details",
  "documents": [
    {
      "id": "docId",
      "type": "license",
      "fileName": "license.jpg",
      "status": "pending",
      "uploadedAt": "2026-01-01T00:00:00.000Z",
      "s3Key": "driver-documents/..."
    }
  ],
  "assignedRouteIds": [],
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

`verificationStatus` can be `pending`, `approved`, or `rejected`. The API accepts a `suspended` filter but returns an empty list because suspension is not supported by the current schema.

### Ride Shape

Ride responses are Prisma ride objects with numeric `pricePerSeat`. Common fields:

```json
{
  "id": "rideId",
  "driverId": "driverUserId",
  "fromCity": "Toronto",
  "fromLat": 43.6532,
  "fromLng": -79.3832,
  "toCity": "Waterloo",
  "toLat": 43.4643,
  "toLng": -80.5204,
  "startTime": "2026-03-10T15:00:00.000Z",
  "arrivalTime": "2026-03-10T17:00:00.000Z",
  "stops": ["Mississauga"],
  "amenities": ["ac", "music"],
  "additionalNotes": "Optional notes",
  "pricePerSeat": 32.5,
  "seatsTotal": 3,
  "seatsAvailable": 3,
  "status": "open",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

Allowed amenities: `ac`, `music`, `wifi`, `pet_friendly`, `luggage_space`, `child_seat`.

### Payment Shape

Payment responses are Prisma payment objects with nested booking data on list/detail endpoints. Common fields:

```json
{
  "id": "paymentId",
  "bookingId": "bookingId",
  "amountCents": 3250,
  "platformFeeCents": 488,
  "currency": "cad",
  "status": "paid",
  "paymentIntentId": "pi_...",
  "driverTransferId": null,
  "driverTransferAmountCents": null,
  "driverTransferredAt": null,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

## Endpoint Catalog

### Dashboard

#### GET /admin/dashboard/stats

Use for dashboard summary cards.

Query params:

```text
dateFrom?: ISO date
dateTo?: ISO date
```

Example:

```http
GET /admin/dashboard/stats?dateFrom=2026-01-01&dateTo=2026-02-01
x-admin-api-key: <ADMIN_API_KEY>
```

Response:

```json
{
  "rides": {
    "total": 0,
    "active": 0,
    "completed": 0,
    "cancelled": 0
  },
  "bookings": {
    "total": 0,
    "pending": 0,
    "confirmed": 0,
    "completed": 0
  },
  "drivers": {
    "total": 0,
    "approved": 0,
    "pending": 0
  },
  "payments": {
    "total": 0,
    "pending": 0,
    "distributed": 0
  },
  "revenue": {
    "total": 0,
    "platformFee": 0,
    "driverAmount": 0
  },
  "routes": {
    "active": 0,
    "total": 0
  }
}
```

### Global Search

#### GET /admin/search

Use for a global search box.

Query params:

```text
q: required
types?: comma-separated rides,drivers,bookings,users. Default all.
limit?: default 20, max 100
```

Example:

```http
GET /admin/search?q=toronto&types=rides,drivers,bookings,users&limit=20
x-admin-api-key: <ADMIN_API_KEY>
```

Response:

```json
{
  "results": {
    "rides": [],
    "drivers": [],
    "bookings": [],
    "users": []
  },
  "total": 0
}
```

There is no dedicated admin user-management API yet. User search is read-only via this endpoint.

## Driver Management

### GET /admin/drivers

List driver profiles.

Query params:

```text
status?: pending | approved | rejected | suspended
page?: number
limit?: number
```

Response:

```json
{
  "drivers": [],
  "total": 0,
  "page": 1,
  "limit": 50
}
```

### GET /admin/drivers/:driverId

Get one driver profile. `driverId` is the user's id (`driverProfile.userId`), not the driver profile id.

Response:

```json
{
  "driver": {}
}
```

### POST /admin/drivers/:driverId/verify

Approve or reject a driver.

Request body:

```json
{
  "action": "approve",
  "reason": "All checks passed",
  "sendNotification": true
}
```

Allowed `action`: `approve`, `reject`, `suspend`.

Important: `suspend` currently returns `400` with `Suspend action is not supported by current schema`.

Response:

```json
{
  "driver": {},
  "action": "approve",
  "reason": "All checks passed"
}
```

### PATCH /admin/drivers/:driverId/documents/:docId

Approve or reject a driver document.

Request body:

```json
{
  "status": "approved"
}
```

Allowed `status`: `approved`, `rejected`.

Response:

```json
{
  "document": {
    "id": "docId",
    "userId": "driverUserId",
    "type": "license",
    "s3Key": "...",
    "fileName": "license.jpg",
    "status": "approved"
  }
}
```

### POST /admin/drivers/:driverId/documents/request

Ask a driver to upload an additional document.

Request body:

```json
{
  "documentType": "insurance",
  "reason": "Current policy is expired"
}
```

Allowed `documentType`: `license`, `insurance`, `selfie`, `registration`, `ownership`.

Response:

```json
{
  "message": "Additional document request sent",
  "requested": {
    "driverId": "driverUserId",
    "documentType": "insurance",
    "reason": "Current policy is expired"
  }
}
```

### GET /admin/drivers/:driverId/documents/:docId/url

Get a temporary download URL for a driver document.

Query params:

```text
expiresIn?: seconds, default 3600, max 86400
```

Response:

```json
{
  "url": "https://...",
  "expiresAt": "2026-01-01T01:00:00.000Z"
}
```

## Ride Management

### GET /admin/rides

List rides.

Query params:

```text
status?: open | full | in_progress | ongoing | completed | cancelled | draft
driverId?: user id
date?: ISO date. Filters by that local day in server timezone.
page?: number
limit?: number
```

Response:

```json
{
  "rides": [],
  "total": 0,
  "page": 1,
  "limit": 50
}
```

Each ride includes selected `driver` fields and `_count.bookings`.

### GET /admin/rides/:rideId

Get ride details with driver, bookings, booking passenger/payments, and conversations.

Response:

```json
{
  "ride": {}
}
```

### POST /admin/rides

Create one ride.

Required body:

```json
{
  "driverId": "driverUserId",
  "fromCity": "Toronto",
  "fromLat": 43.6532,
  "fromLng": -79.3832,
  "toCity": "Waterloo",
  "toLat": 43.4643,
  "toLng": -80.5204,
  "startTime": "2026-03-10T15:00:00.000Z",
  "pricePerSeat": 32.5,
  "seatsTotal": 3
}
```

Optional body:

```json
{
  "arrivalTime": "2026-03-10T17:00:00.000Z",
  "stops": ["Mississauga"],
  "amenities": ["ac", "music"],
  "additionalNotes": "Optional note",
  "status": "open"
}
```

Response: `201`

```json
{
  "ride": {}
}
```

### POST /admin/rides/bulk

Bulk create rides.

Request body:

```json
{
  "driverId": "fallbackDriverUserId",
  "rides": [
    {
      "clientRowId": "csv-row-1",
      "driverId": "optionalOverrideDriverUserId",
      "fromCity": "Toronto",
      "fromLat": 43.6532,
      "fromLng": -79.3832,
      "toCity": "Kitchener",
      "toLat": 43.4516,
      "toLng": -80.4925,
      "startTime": "2026-03-11T14:00:00.000Z",
      "pricePerSeat": 30,
      "seatsTotal": 3
    }
  ]
}
```

Response:

```json
{
  "created": 1,
  "failed": 0,
  "results": [
    {
      "clientRowId": "csv-row-1",
      "rideId": "rideId"
    }
  ]
}
```

Rows that fail return `{ "clientRowId": "...", "error": "..." }`.

### PATCH /admin/rides/:rideId

Update ride details. Body may contain any create fields. Validation details:

- Send `fromLat` and `fromLng` together.
- Send `toLat` and `toLng` together.
- `arrivalTime` can be `null` or an ISO date after `startTime`.
- `seatsTotal` cannot be below currently booked seats.
- `status` accepts `open`, `in_progress`, `ongoing`, `completed`, `cancelled`.
- `stops` and `amenities` must be arrays of strings.

Example:

```json
{
  "pricePerSeat": 35,
  "seatsTotal": 4,
  "status": "open"
}
```

Response:

```json
{
  "ride": {}
}
```

### PUT /admin/rides/:rideId/assign

Assign a ride to a different driver.

Request body:

```json
{
  "driverId": "driverUserId",
  "sendNotification": true
}
```

Response:

```json
{
  "ride": {}
}
```

### PUT /admin/rides/:rideId/cancel

Cancel a ride and active bookings.

Request body:

```json
{
  "sendNotification": true,
  "refundBookings": false
}
```

Response:

```json
{
  "ride": {},
  "cancelledBookings": []
}
```

### PUT /admin/rides/:rideId/status

Update ride status.

Request body:

```json
{
  "status": "in_progress",
  "sendNotification": true
}
```

Allowed `status`: `open`, `in_progress`, `ongoing`, `completed`, `cancelled`.

Response:

```json
{
  "ride": {}
}
```

### GET /admin/rides/:rideId/eligible-drivers

List drivers who could be assigned to a ride.

Query params:

```text
limit?: default 50, max 200
```

Response:

```json
{
  "drivers": [
    {
      "driver": {},
      "eligible": true,
      "reasons": {
        "verified": true,
        "routeMatch": true,
        "scheduleConflict": false,
        "vehicleCapacity": true,
        "other": []
      }
    }
  ]
}
```

Current eligibility logic checks verified driver and rough +/- 2 hour schedule conflict. `routeMatch` and `vehicleCapacity` are currently always `true`.

### GET /admin/rides/export

Export rides.

Query params:

```text
format?: csv | json, default csv
status?: open | full | in_progress | ongoing | completed | cancelled | draft
dateFrom?: ISO date
dateTo?: ISO date
```

For `format=csv`, response is a CSV file attachment named `rides-export.csv`.

For `format=json`, response is an array:

```json
[
  {
    "id": "rideId",
    "driverId": "driverUserId",
    "fromCity": "Toronto",
    "toCity": "Waterloo",
    "startTime": "2026-03-10T15:00:00.000Z",
    "arrivalTime": null,
    "status": "open",
    "pricePerSeat": 32.5,
    "seatsTotal": 3,
    "seatsAvailable": 3,
    "bookings": 0,
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z"
  }
]
```

## Ride Request Management

### GET /admin/ride-requests

List ride requests.

Query params:

```text
status?: pending | matched | accepted | rejected
page?: number
limit?: number
```

Response:

```json
{
  "requests": [],
  "total": 0,
  "page": 1,
  "limit": 50
}
```

Each request includes selected `passenger`, selected `driver`, and `_count.offers`.

### POST /admin/ride-requests/:requestId/offers

Create an offer for a ride request.

Option A: create offer from an existing ride:

```json
{
  "rideId": "rideId",
  "seatsOffered": 1
}
```

Option B: create a new ride and offer in one request:

```json
{
  "driverId": "driverUserId",
  "fromCity": "Toronto",
  "fromLat": 43.6532,
  "fromLng": -79.3832,
  "toCity": "Waterloo",
  "toLat": 43.4643,
  "toLng": -80.5204,
  "startTime": "2026-03-10T15:00:00.000Z",
  "arrivalTime": "2026-03-10T17:00:00.000Z",
  "pricePerSeat": 32.5,
  "seatsTotal": 3,
  "seatsOffered": 1,
  "notes": "Optional ride notes"
}
```

Response: `201`

```json
{
  "offer": {},
  "request": {}
}
```

Constraints:

- Ride request must be open (`PENDING`, `OFFERING`, or legacy `pending`).
- Active duplicate offers for the same request and driver are rejected.
- Reopenable offers may be updated back to `SENT`.

### POST /admin/ride-requests/:requestId/offers/bulk

Create multiple offers for one ride request.

Request body:

```json
{
  "driverId": "optionalFallbackDriverUserId",
  "offers": [
    {
      "clientRowId": "offer-1",
      "rideId": "rideId",
      "seatsOffered": 1
    }
  ]
}
```

Each offer row supports the same fields as the single-offer endpoint.

Response:

```json
{
  "created": 1,
  "failed": 0,
  "results": [
    {
      "clientRowId": "offer-1",
      "offerId": "offerId"
    }
  ]
}
```

### PUT /admin/ride-requests/:requestId/status

Update ride request status.

Request body:

```json
{
  "status": "matched"
}
```

Accepted input statuses: `awaiting_payment`, `matched`, `accepted`, `rejected`, `pending`.

Response:

```json
{
  "request": {}
}
```

## Booking Management

### GET /admin/bookings

List bookings.

Query params:

```text
rideId?: ride id
passengerId?: user id
status?: pending | confirmed | completed | cancelled | no_show
page?: number
limit?: number
```

Response:

```json
{
  "bookings": [],
  "total": 0,
  "page": 1,
  "limit": 50
}
```

Each booking includes `ride`, selected `passenger`, and `payments`.

### GET /admin/bookings/:bookingId

Get booking details with passenger, ride/driver, and payments.

Response:

```json
{
  "booking": {}
}
```

### PUT /admin/bookings/:bookingId/confirm

Confirm a pending booking and decrement ride seats.

Request body is optional. The current implementation ignores `reason`.

```json
{
  "reason": "Manual approval"
}
```

Response:

```json
{
  "booking": {},
  "ride": {}
}
```

Constraints:

- Booking must be `pending`.
- Ride must be `open` or `ongoing`.
- Ride must have enough seats available.

### PUT /admin/bookings/:bookingId/cancel

Cancel an active booking and optionally refund.

Request body:

```json
{
  "reason": "Admin override",
  "refundRequired": true
}
```

The current implementation uses `refundRequired`; `reason` is accepted by callers but not persisted.

Response:

```json
{
  "booking": {},
  "ride": {}
}
```

### GET /admin/bookings/export

Export bookings.

Query params:

```text
format?: csv | json, default csv
status?: pending | confirmed | completed | cancelled | no_show
dateFrom?: ISO date
dateTo?: ISO date
```

For `format=csv`, response is a CSV file attachment named `bookings-export.csv`.

For `format=json`, response is an array:

```json
[
  {
    "id": "bookingId",
    "rideId": "rideId",
    "passengerId": "passengerUserId",
    "status": "pending",
    "paymentStatus": "pending",
    "seatsBooked": 1,
    "fromCity": "Toronto",
    "toCity": "Waterloo",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z"
  }
]
```

## Payment Management

### GET /admin/payments

List payments.

Query params:

```text
bookingId?: booking id
driverId?: driver user id
status?: paid | pending | refunded | failed
dateFrom?: ISO date
dateTo?: ISO date
page?: number
limit?: number
```

Response:

```json
{
  "payments": [],
  "total": 0,
  "page": 1,
  "limit": 50
}
```

Each payment includes booking, booking ride summary, and selected passenger fields.

### GET /admin/payments/:paymentId

Get payment detail with booking, passenger, ride, and driver.

Response:

```json
{
  "payment": {}
}
```

### PUT /admin/payments/:paymentId/mark-paid

Manually mark a payment as paid.

Request body:

```json
{
  "paymentIntentId": "optional_unique_payment_intent_id"
}
```

Response:

```json
{
  "payment": {}
}
```

If `paymentIntentId` duplicates another payment, returns `409`.

### POST /admin/payments/:paymentId/payout

Create Stripe transfer to the driver's connected account.

Request body:

```json
{
  "amount": 27.62
}
```

`amount` is optional and is in major currency units. Partial payouts are not supported, so if provided it must equal `amountCents - platformFeeCents`.

Response:

```json
{
  "payment": {},
  "payout": {
    "id": "tr_...",
    "amount": 2762,
    "currency": "cad",
    "destination": "acct_...",
    "sourceTransactionId": "ch_...",
    "created": 1760000000
  }
}
```

Important conflict cases:

- Already has `driverTransferId`: `409`.
- Payment is refunded: `409`.
- Payment not paid/succeeded: `409`.
- Driver missing Stripe Connect account or payouts disabled: `409`.

### POST /admin/payments/:paymentId/refund

Create a Stripe refund.

Headers:

```http
Idempotency-Key: refund-<unique-client-generated-key>
```

Request body:

```json
{
  "reason": "Service disruption",
  "amount": 10
}
```

`reason` is required. `amount` is optional and in major currency units. If omitted, backend refunds the full original payment amount. Amount cannot exceed the original payment.

Response:

```json
{
  "payment": {},
  "refund": {
    "id": "re_...",
    "amount": 1000,
    "status": "succeeded",
    "reason": "Service disruption"
  }
}
```

Important conflict cases:

- Payment already refunded: `409`.
- Payment has `driverTransferId`: `409`; reverse the transfer in Stripe first.

### GET /admin/payments/export

Export payments.

Query params:

```text
format?: csv | json, default csv
status?: paid | pending | refunded | failed
dateFrom?: ISO date
dateTo?: ISO date
```

For `format=csv`, response is a CSV file attachment named `payments-export.csv`.

For `format=json`, response is an array:

```json
[
  {
    "id": "paymentId",
    "bookingId": "bookingId",
    "rideId": "rideId",
    "driverId": "driverUserId",
    "amountCents": 3250,
    "platformFeeCents": 488,
    "currency": "cad",
    "status": "paid",
    "paymentIntentId": "pi_...",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z"
  }
]
```

## Support Tickets

### GET /admin/support-tickets

List support tickets.

Query params:

```text
status?: open | in_progress | resolved | closed
userId?: user id
limit?: default 50, max 100
cursor?: ticket id from previous nextCursor
```

Response:

```json
{
  "tickets": [
    {
      "id": "ticketId",
      "userId": "userId",
      "subject": "Payment issue",
      "description": "The payment sheet closed.",
      "status": "open",
      "adminResponse": null,
      "attachmentS3Key": null,
      "attachmentUrl": null,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "nextCursor": "ticketId"
}
```

### GET /admin/support-tickets/:id

Get support ticket detail. Includes selected user details.

Response:

```json
{
  "id": "ticketId",
  "userId": "userId",
  "user": {
    "id": "userId",
    "name": "User Name",
    "email": "user@example.com",
    "phone": "+14165551234"
  },
  "subject": "Payment issue",
  "description": "The payment sheet closed.",
  "status": "open",
  "adminResponse": null,
  "attachmentUrl": null
}
```

### POST /admin/support-tickets

Create a ticket on behalf of a user.

Request body:

```json
{
  "userId": "userId",
  "subject": "Manual incident follow-up",
  "description": "Driver and passenger reported a route issue."
}
```

`relatedUserId` is also accepted as an alias of `userId`.

Response: `201`

```json
{
  "ticket": {}
}
```

### PATCH /admin/support-tickets/:id

Update ticket status and/or admin response.

Request body:

```json
{
  "status": "in_progress",
  "adminResponse": "We are checking this."
}
```

Allowed `status`: `open`, `in_progress`, `resolved`, `closed`.

Response is the updated ticket object, not wrapped:

```json
{
  "id": "ticketId",
  "status": "in_progress",
  "adminResponse": "We are checking this.",
  "attachmentUrl": null
}
```

### POST /admin/support-tickets/:id/resolve

Resolve a ticket.

Request body:

```json
{
  "resolution": "Issue resolved and user informed."
}
```

Response:

```json
{
  "ticket": {}
}
```

## App Config / Settings

These aliases point to the same global app config:

```text
GET /admin/app-config
PATCH /admin/app-config
GET /admin/settings
PUT /admin/settings
```

### GET /admin/app-config

Response:

```json
{
  "id": "global",
  "maintenanceMode": false,
  "maintenanceMessage": null,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

### PATCH /admin/app-config

Request body:

```json
{
  "maintenanceMode": true,
  "maintenanceMessage": "HelpRide is temporarily under maintenance."
}
```

At least one of `maintenanceMode` or `maintenanceMessage` is required.

Response is the updated config.

### GET /admin/settings

Alias of `GET /admin/app-config`.

### PUT /admin/settings

Alias of `PATCH /admin/app-config`.

## Current Non-Admin But Admin-Like Endpoint

Fixed route pricing currently exists outside `/admin`:

```text
GET /fixed-route-prices
POST /fixed-route-prices
PUT /fixed-route-prices/:id
DELETE /fixed-route-prices/:id
```

These routes are currently protected by normal bearer auth and verified email, not `x-admin-api-key`. If the admin panel needs to manage fixed route pricing, the backend should add or move these under `/admin/fixed-route-prices` before using them in production admin tooling.

## Known API Gaps For Full Admin Panel

The existing API is enough for an MVP admin panel covering operations, drivers, rides, bookings, payments, support, settings, and exports. Missing or incomplete areas:

- Dedicated user management: list users, get user detail, suspend/restore/delete user, edit safe user fields.
- Driver suspension: exposed as an input action but currently unsupported by schema.
- Fixed route pricing under admin guard.
- Admin login/session/role auth. Current admin access is API-key based.
- Audit log endpoints for admin actions.
- Fine-grained report/export endpoints beyond rides/bookings/payments.

## Suggested Frontend Screens To Map To Existing Endpoints

```text
Dashboard
  GET /admin/dashboard/stats
  GET /admin/search

Drivers
  GET /admin/drivers
  GET /admin/drivers/:driverId
  POST /admin/drivers/:driverId/verify
  PATCH /admin/drivers/:driverId/documents/:docId
  POST /admin/drivers/:driverId/documents/request
  GET /admin/drivers/:driverId/documents/:docId/url

Rides
  GET /admin/rides
  GET /admin/rides/:rideId
  POST /admin/rides
  POST /admin/rides/bulk
  PATCH /admin/rides/:rideId
  PUT /admin/rides/:rideId/assign
  PUT /admin/rides/:rideId/status
  PUT /admin/rides/:rideId/cancel
  GET /admin/rides/:rideId/eligible-drivers
  GET /admin/rides/export

Ride Requests
  GET /admin/ride-requests
  POST /admin/ride-requests/:requestId/offers
  POST /admin/ride-requests/:requestId/offers/bulk
  PUT /admin/ride-requests/:requestId/status

Bookings
  GET /admin/bookings
  GET /admin/bookings/:bookingId
  PUT /admin/bookings/:bookingId/confirm
  PUT /admin/bookings/:bookingId/cancel
  GET /admin/bookings/export

Payments
  GET /admin/payments
  GET /admin/payments/:paymentId
  PUT /admin/payments/:paymentId/mark-paid
  POST /admin/payments/:paymentId/payout
  POST /admin/payments/:paymentId/refund
  GET /admin/payments/export

Support
  GET /admin/support-tickets
  GET /admin/support-tickets/:id
  POST /admin/support-tickets
  PATCH /admin/support-tickets/:id
  POST /admin/support-tickets/:id/resolve

Settings
  GET /admin/app-config
  PATCH /admin/app-config
  GET /admin/settings
  PUT /admin/settings
```
