# HelpRide API

Backend API for the **HelpRide** carpool / ride-sharing app.  
It powers Flutter clients for passengers and drivers, using PostgreSQL (Neon) + Prisma, with email/password + OAuth auth, driver profiles, rides, bookings, and ride requests.

---

## Tech Stack

- **Runtime:** Node.js, TypeScript, Express
- **Database:** PostgreSQL (Neon)
- **ORM:** Prisma
- **Auth:** JWT (access + refresh), email/password, OAuth (Google / Apple-ready)
- **Email:** Resend (for email verification OTP)
- **Storage:** AWS S3 (driver documents)
- **Realtime:** Pusher (chat)
- **Deployment:** Vercel (Serverless API)
- **Package Manager:** npm

---

## Repository Layout (API)

```txt
help-ride-api/
├─ src/
│  ├─ app.ts              # Express app setup
│  ├─ server.ts           # Server bootstrap
│  ├─ lib/
│  │  ├─ prisma.ts        # Prisma client
│  │  ├─ jwt.ts           # JWT helpers
│  │  └─ pusher.ts        # Pusher client
│  ├─ middleware/
│  │  ├─ auth.ts          # Auth guard (JWT)
│  │  └─ requireVerifiedEmail.ts # Enforce email verification for protected actions
│  ├─ controllers/
│  │  ├─ auth.controller.ts
│  │  ├─ ride.controller.ts
│  │  ├─ booking.controller.ts
│  │  ├─ driver.controller.ts
│  │  ├─ driverDocument.controller.ts
│  │  ├─ chat.controller.ts
│  │  ├─ rideRequest.controller.ts
│  │  └─ user.controller.ts
│  ├─ routes/
│  │  ├─ auth.routes.ts
│  │  ├─ ride.routes.ts
│  │  ├─ booking.routes.ts
│  │  ├─ driver.routes.ts
│  │  ├─ chat.routes.ts
│  │  ├─ rideRequest.routes.ts
│  │  └─ user.routes.ts
│  └─ types/              # Shared types (if any)
├─ prisma/
│  ├─ schema.prisma       # Prisma schema
│  └─ migrations/         # Auto-generated migrations
├─ docs/
│  ├─ help-ride-api.http  # HTTP test script (REST Client / VS Code)
│  └─ HelpRide-API.postman_collection.json
├─ package.json
├─ tsconfig.json
└─ vercel.json            # Vercel config
```

_Exact file names may differ slightly but the conceptual layout matches._

---

## Environment Variables

These should be set locally (e.g. `.env`) and in Vercel project settings.

```bash
# Database
DATABASE_URL="postgresql://...@ep-xxx.neon.tech/neondb?sslmode=require"

# JWT
JWT_ACCESS_SECRET="your-strong-access-secret"
JWT_REFRESH_SECRET="your-strong-refresh-secret"

# Email (Resend)
RESEND_API_KEY="re_xxx"
EMAIL_FROM="HelpRide <noreply@exocodelabs.tech>"

# AWS S3 (Driver documents)
AWS_S3_BUCKET="your-bucket-name"
AWS_REGION="us-east-1"
AWS_ACCESS_KEY_ID="AKIA..."
AWS_SECRET_ACCESS_KEY="..."

# Pusher (Chat)
PUSHER_APP_ID="your-app-id"
PUSHER_KEY="your-key"
PUSHER_SECRET="your-secret"
PUSHER_CLUSTER="your-cluster"

# Stripe
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
PAYMENT_PLATFORM_FEE_PCT=0.15
# Optional backward-compatible alias:
# STRIPE_PLATFORM_FEE_PCT=0.15

# Realtime dispatch bridge (Fly.io)
REALTIME_BASE_URL="https://your-realtime-app.fly.dev"
REALTIME_TO_API_SECRET="rts_xxx"
# Must match realtime service JWT verification secret:
# JWT_ACCESS_SECRET="same-value-used-by-realtime-service"

# Optional pricing model overrides (cents / basis points)
PAYMENT_BASE_FARE_CENTS=0
PAYMENT_PER_KM_RATE_CENTS=0
PAYMENT_SERVICE_FEE_CENTS=0
PAYMENT_TAX_BPS=0

# App
NODE_ENV="development"        # or "production"
PORT=4000                     # local dev port
```

Prisma uses `DATABASE_URL` to connect to Neon.

---

## Database Schema (Prisma Overview)

**Enums (simplified)**

```prisma
enum RoleDefault {
  passenger
  driver
}

enum AuthProvider {
  google
  apple
}

enum RideStatus {
  open
  ongoing
  completed
  cancelled
}

enum BookingStatus {
  pending
  confirmed
  cancelled_by_passenger
  cancelled_by_driver
  completed
}

enum PaymentStatus {
  unpaid
  paid
  refunded
}

enum NotificationType {
  ride_update
  payment
  system
}

enum DriverDocumentType {
  license
  insurance
  ownership
  other
}

enum DriverDocumentStatus {
  pending
  approved
  rejected
}

enum RideRequestStatus {
  pending
  matched
  cancelled
  expired
}
```

**Core models (high level)**

- `User`  
  - `id`, `name`, `email (unique)`, `phone?`, `passwordHash?`  
  - `roleDefault` (`passenger` / `driver`)  
  - `providerAvatarUrl?`  
  - `emailVerified` (bool)  
  - Relations: `oauthAccounts`, `driverProfile?`, `rides` (as driver), `bookings` (as passenger), `notifications`, `sosEvents`, `rideRequests`, `driverDocuments`, `refreshTokens`

- `OAuthAccount`  
  - Providers (Google / Apple), `providerUserId`, `providerEmail`, tokens

- `DriverProfile` (single car per driver – **Option A**)  
  - `userId` (1:1 with `User`)  
  - `carMake`, `carModel`, `carYear`, `carColor`, `plateNumber`, `licenseNumber`, `insuranceInfo?`, `isVerified`

- `Ride`  
  - `driverId` → `User`  
  - Location: `fromCity`, `fromLat`, `fromLng`, `toCity`, `toLat`, `toLng`  
  - Time: `startTime`, `arrivalTime?` (**new**)  
  - Pricing: `pricePerSeat (Decimal)`, `seatsTotal`, `seatsAvailable`  
  - `status` (`RideStatus`)  
  - Relations: `bookings`, `sosEvents`

- `Booking`  
  - `rideId`, `passengerId`, `seatsBooked`  
  - `status` (`BookingStatus`) – created as `pending`, driver confirms/rejects  
  - `paymentStatus` (`PaymentStatus`)  
  - `stripePaymentIntentId?`, `payments`

- `Payment`  
  - `bookingId`, `amount`, `currency`, `stripePaymentIntentId`, `status`

- `Notification`  
  - `userId`, `type`, `title`, `body`, `isRead`

- `SosEvent`  
  - `userId`, optional `rideId`, `lat`, `lng`

- `RideRequest`  
  - `passengerId`, origin/destination (city + lat/lng)  
  - `preferredDate`, `preferredTime?`, `arrivalTime?` (string)  
  - `seatsNeeded`, `rideType` (`one-time` / `recurring`), `tripType` (`one-way` / `round-trip`)  
  - optional `returnDate`, `returnTime`  
  - `status`: `pending | matched | cancelled | expired`

- `DriverDocument`  
  - `userId`, `type`, `s3Key`, `fileName`, `mimeType`, `status`

- `RefreshToken`  
  - `userId`, `tokenHash`, `expiresAt`, `revokedAt?`, `replacedByTokenId?`

- `Conversation`  
  - `rideId?`, `passengerId`, `driverId`  
  - `lastMessageAt?`, `lastMessagePreview?`

- `Message`  
  - `conversationId`, `senderId`, `body`, `createdAt`

> **Note**: The Prisma schema in `prisma/schema.prisma` is the source of truth. This section is an overview for devs.

---

## Running Locally

### 1. Install dependencies

```bash
npm install
```

### 2. Setup database

Ensure `DATABASE_URL` is set (Neon connection string). Then run:

```bash
npx prisma migrate dev --name init
npx prisma generate
```

If you’ve changed the schema and just want to sync in dev:

```bash
npx prisma migrate dev --name some_change
# or in emergency:
# npx prisma db push --force-reset
```

### 3. Start dev server

```bash
npm run dev
```

By default the API listens on `http://localhost:4000` and the base path is `/api` (e.g. `http://localhost:4000/api/health`).

---

## API Documentation

There are two dev-friendly docs in `docs/`:

- **VS Code REST Client file**: `docs/help-ride-api.http`  
- **Postman collection**: `docs/HelpRide-API.postman_collection.json`

Both are kept in sync with the implementation and include working examples for all major flows:

- Auth (email + OAuth, refresh, logout)
- Email verification (OTP)
- Driver profiles
- Driver documents (S3 presign)
- Chat (conversations + messages)
- Rides (with `arrivalTime`)
- Ride requests
- Bookings (including driver confirm/reject)
- User profile update

Base URLs:

- Local: `http://localhost:4000/api`
- Dev (Vercel): `https://dev-help-ride-api.vercel.app/api`
- Production (Vercel): `https://help-ride-api.vercel.app/api`

---

## Auth & Email Verification

### Register

`POST /api/auth/register`

```json
{
  "name": "Email User",
  "email": "emailuser@example.com",
  "password": "StrongPass123!"
}
```

- Creates a user with `emailVerified = false`.
- Sends a verification OTP to the email.
- Call `POST /api/auth/verify-email/verify-otp` to receive tokens.

### Login

`POST /api/auth/login`

```json
{
  "email": "emailuser@example.com",
  "password": "StrongPass123!"
}
```

- Validates credentials and sends a verification OTP.
- Call `POST /api/auth/verify-email/verify-otp` to receive tokens.

### Refresh Tokens

`POST /api/auth/refresh`

```json
{
  "refreshToken": "your-refresh-token"
}
```

- Validates the refresh token, rotates it, and returns new access + refresh tokens.
- Refresh tokens are stored hashed in the database for revocation and rotation.

### Logout (Revoke Refresh Token)

`POST /api/auth/logout`

```json
{
  "refreshToken": "your-refresh-token"
}
```

- Revokes the current refresh token so it can’t be used again.

### OAuth Login

`POST /api/auth/oauth`

```json
{
  "provider": "google",
  "providerUserId": "google-1234567890",
  "email": "testuser@example.com",
  "name": "Test User",
  "avatarUrl": "https://example.com/avatar.png"
}
```

- Upserts `User` (by `email`) and `OAuthAccount` (by `provider + providerUserId`).
- Marks `emailVerified = true` for OAuth sign-ins.
- Returns user and tokens.

### Get Current User

`GET /api/auth/me` (JWT required)

- Uses `authGuard` middleware to read `Authorization: Bearer <accessToken>`.
- Returns the current user, including `driverProfile` if it exists.

### Email Verification Flow (OTP)

1. **Send OTP**

   `POST /api/auth/verify-email/send-otp`

   ```json
   {
     "email": "emailuser@example.com"
   }
   ```

   - Sends a one-time code to the user’s email via Resend.
   - Stores the OTP + expiry against the user.

2. **Verify OTP**

   `POST /api/auth/verify-email/verify-otp`

   ```json
   {
     "email": "emailuser@example.com",
     "otp": "123456"
   }
   ```

- Verifies the OTP.
- Marks `emailVerified = true` on the user and returns access + refresh tokens.
- Response includes `user` and `tokens`.

### Email Verification Enforcement (middleware)

Protected actions require `emailVerified = true`:

- Posting rides
- Booking rides
- Creating ride requests
- Becoming a driver (`DriverProfile`)

Middleware (conceptually):

```ts
// requireVerifiedEmail.ts
if (!req.userId) 401
const user = await prisma.user.findUnique(...)
if (!user?.emailVerified) {
  return res.status(403).json({
    error: "Email verification required",
    code: "EMAIL_NOT_VERIFIED",
    message: "Please verify your email before posting or booking rides."
  })
}
```

Used on routes like `/rides`, `/bookings`, `/ride-requests`, `/drivers` (POST).

---

## Users Module

### Get User Profile (Public)

`GET /api/users/:id`

- Returns safe public fields only (`id`, `name`, `providerAvatarUrl`, `roleDefault`).

### Update User Profile

`PUT /api/users/:id` (JWT – must match current user)

```json
{
  "name": "Updated Name",
  "phone": "+14165551234",
  "providerAvatarUrl": "https://example.com/avatar.png"
}
```

- Partial update of the current user's profile.

---

## Driver Profile Module

Single-car model for now (one `DriverProfile` per `User`).

### Create Driver Profile (Become Driver)

`POST /api/drivers` (JWT + emailVerified)

```json
{
  "carMake": "Toyota",
  "carModel": "Corolla",
  "carYear": "2020",
  "carColor": "White",
  "plateNumber": "ABC-123",
  "licenseNumber": "LIC-987654",
  "insuranceInfo": "Intact Insurance - Policy #123456"
}
```

- Creates `DriverProfile` for the current user and flips `roleDefault` to `driver` if needed.

### Get Driver Profile

`GET /api/drivers/:userId`

- Public read of driver profile for a given user id.

### Update Driver Profile

`PUT /api/drivers/:userId` (JWT – must match current user)

```json
{
  "carColor": "Black",
  "carModel": "Corolla SE"
}
```

- Partial update of driver profile.

### Update Vehicle (Alias)

`PUT /api/drivers/:userId/vehicles/:vehicleId` (JWT + emailVerified – must match current user)

- Compatibility alias backed by the single `DriverProfile` record.
- `vehicleId` must equal the driver's `DriverProfile.id`.

### Delete Vehicle (Alias)

`DELETE /api/drivers/:userId/vehicles/:vehicleId` (JWT + emailVerified – must match current user)

- Deletes the driver's `DriverProfile` (blocked if the driver has active rides).

---

## Driver Documents (S3)

### Get Upload URL (Presign)

`POST /api/drivers/:id/documents/presign` (JWT – must match current user)

```json
{
  "type": "license",
  "fileName": "license.jpg",
  "mimeType": "image/jpeg"
}
```

- Returns a presigned S3 upload URL and creates a `DriverDocument` row with `pending` status.

### List My Documents

`GET /api/drivers/:id/documents` (JWT – must match current user)

- Returns documents with presigned download URLs.

---

## Rides Module

### Create Ride

`POST /api/rides` (JWT + emailVerified)

```json
{
  "fromCity": "Waterloo",
  "fromLat": 43.4643,
  "fromLng": -80.5204,
  "toCity": "Toronto",
  "toLat": 43.6532,
  "toLng": -79.3832,
  "startTime": "2025-12-15T14:00:00.000Z",
  "arrivalTime": "2025-12-15T16:30:00.000Z",
  "pricePerSeat": 20.5,
  "seatsTotal": 3
}
```

- Validates coordinates, start time, and optional `arrivalTime`.
- Ensures `arrivalTime > startTime` when provided.
- Initializes `seatsAvailable = seatsTotal` and `status = "open"`.

### Search Rides (Public)

`GET /api/rides?fromCity=Waterloo&toCity=Toronto&seats=1`

- Public endpoint – unauthenticated users can browse.
- Filters by city names and minimum seats.

### Get My Rides

`GET /api/rides/me/list` (JWT)

- Lists rides where `driverId = currentUser`.

### Get Ride By ID

`GET /api/rides/:id`

- Public read of a single ride.

### Update Ride

`PUT /api/rides/:id` (JWT – must be the driver for the ride)

```json
{
  "startTime": "2025-12-15T15:00:00.000Z",
  "arrivalTime": "2025-12-15T17:00:00.000Z",
  "pricePerSeat": 22.5
}
```

- Validates times and allows updating `arrivalTime` (or clearing it by sending `null` / empty string).
- Leaves `seatsAvailable` unchanged for now (can be improved later).

### Delete Ride

`DELETE /api/rides/:id` (JWT – must be driver)

- Soft-delete or hard-delete depending on implementation (currently likely hard delete).

### Start Ride (Driver)

`POST /api/rides/:id/start` (JWT + emailVerified – must be driver)

- Transitions ride `status` to `ongoing`.

### Complete Ride (Driver)

`POST /api/rides/:id/complete` (JWT + emailVerified – must be driver)

- Transitions ride `status` to `completed`.

### Cancel Ride (Driver)

`POST /api/rides/:id/cancel` (JWT + emailVerified – must be driver)

- Transitions ride `status` to `cancelled` and initiates refunds for confirmed paid bookings.

---

## Ride Requests Module

Used when no matching ride exists and passengers want to post what they need.

### Create JIT Payment Intent

`POST /api/ride-requests/jit/intent` (JWT passenger, emailVerified)

- For departure times within 2 hours.
- Creates a payment intent first.
- On successful Stripe webhook, the API creates a `RideRequest` with `mode = "JIT"` and dispatches it to realtime matching.

### Create Ride Request

`POST /api/ride-requests` (JWT passenger, emailVerified)

```json
{
  "fromCity": "Waterloo",
  "fromLat": 43.4643,
  "fromLng": -80.5204,
  "toCity": "Toronto",
  "toLat": 43.6532,
  "toLng": -79.3832,
  "preferredDate": "2025-12-20T14:00:00.000Z",
  "preferredTime": "14:00",
  "arrivalTime": "17:00",
  "seatsNeeded": 1,
  "rideType": "one-time",
  "tripType": "one-way"
}
```

- Validates required fields and ISO dates.
- For `tripType = "round-trip"`, ensures `returnDate >= preferredDate`.
- For departures within 2 hours, returns an error and asks you to use `/api/ride-requests/jit/intent`.
- Creates a regular `RideRequest` with `mode = "OFFER"` and `status = "pending"`.

### Search Ride Requests (Public)

`GET /api/ride-requests?fromCity=Waterloo&toCity=Toronto&status=pending`

- Public endpoint.
- Filters by `fromCity`, `toCity`, and `status` (`pending`, `matched`, `cancelled`, `expired` – defaults to `pending`).

### Get My Ride Requests

`GET /api/ride-requests/me/list` (JWT)

- Lists ride requests created by the current user.

### Get Ride Request By ID

`GET /api/ride-requests/:id`

- Public read of a single ride request.

### Get Ride Request Detail (Public)

`GET /api/ride-requests/:id/detail`

- Public detail view that includes `offers`.

### Ride Request Offers

- `POST /api/ride-requests/:id/offers` (JWT + emailVerified, driver) – create offer for a request (links an existing `rideId`).
- `GET /api/ride-requests/:id/offers` (JWT) – passenger sees all offers; driver sees own offers.
- `PUT /api/ride-requests/:id/offers/:offerId/accept` (JWT + emailVerified, passenger) – accepts offer and creates booking.
- `PUT /api/ride-requests/:id/offers/:offerId/reject` (JWT + emailVerified, passenger) – rejects offer.
- `PUT /api/ride-requests/:id/offers/:offerId/cancel` (JWT + emailVerified, driver) – cancels offer.
- `GET /api/ride-requests/offers/me/list` (JWT, driver) – list driver's offers across requests.

### Update Ride Request (Passenger)

`PUT /api/ride-requests/:id` (JWT – must be owner)

```json
{
  "preferredTime": "09:30",
  "arrivalTime": "12:00",
  "seatsNeeded": 2
}
```

- Partial update of the request fields.

### Cancel Ride Request (Passenger)

`POST /api/ride-requests/:id/cancel` (JWT + emailVerified – must be owner)

`DELETE /api/ride-requests/:id` (alias)

- Marks the request as `CANCELLED` and triggers realtime cancellation.
- For JIT requests, initiates Stripe refund before cancellation.

---

## Bookings Module

Passenger booking → driver approval → seats updated.

### Create Booking (Passenger)

`POST /api/bookings/:rideId` (JWT passenger, emailVerified)

```json
{
  "seats": 1,
  "passengerPickupName": "Conestoga Mall, Waterloo",
  "passengerPickupLat": 43.4723,
  "passengerPickupLng": -80.5449,
  "passengerDropoffName": "Union Station, Toronto",
  "passengerDropoffLat": 43.6532,
  "passengerDropoffLng": -79.3832
}
```

- Validates ride, seat availability, user, and passenger pickup/dropoff names + coordinates.
- Creates a `Booking` with:
  - `status = "pending"`
  - `paymentStatus = "unpaid"`

### Get My Bookings (Passenger)

`GET /api/bookings/me/list` (JWT)

- Lists bookings where `passengerId = current user`.

### Get Bookings For Ride (Driver)

`GET /api/bookings/ride/:rideId` (JWT driver)

- Only the driver for that ride can see its bookings.

### Confirm Booking (Driver)

`PUT /api/bookings/:id/confirm` (JWT driver)

- Marks `status = "confirmed"`.
- Decrements `seatsAvailable` on the associated ride.

### Reject Booking (Driver)

`PUT /api/bookings/:id/reject` (JWT driver)

- Marks `status = "cancelled_by_driver"` for that booking.
- Does **not** decrement seats.

### Cancel Booking (Passenger)

`POST /api/bookings/:id/cancel` (JWT + emailVerified – must be owner)

`PUT /api/bookings/:id/cancel` (alias)

`DELETE /api/bookings/:id` (alias)

- Marks `status = "cancelled_by_passenger"`.
- If payment was already completed, initiates Stripe refund automatically.

---

## Chat Module

Passenger ↔ driver chat scoped to a ride, with realtime delivery via Pusher.

### Create or Get Conversation

`POST /api/chat/conversations` (JWT)

```json
{
  "rideId": "ride-uuid",
  "passengerId": "passenger-uuid"
}
```

- Passenger can omit `passengerId` (it defaults to the current user).
- Driver must provide `passengerId`.
- Returns an existing conversation for the ride if one already exists.

### List My Conversations

`GET /api/chat/conversations` (JWT)

- Returns conversations where the current user is the passenger or driver.

### List Messages

`GET /api/chat/conversations/:id/messages?limit=50&cursor=<messageId>` (JWT)

- Returns newest messages first, plus `nextCursor` for pagination.
- Each message includes `readAt` (`null` until the recipient marks it read).

### Mark Messages Read

`POST /api/chat/conversations/:id/read` (JWT)

- Marks unread incoming messages in the conversation as read.
- Returns `readCount`, `readAt`, and `messageIds` for updated messages.
- Broadcasts `message:read` on the conversation realtime channel.

### Send Message

`POST /api/chat/conversations/:id/messages` (JWT)

```json
{
  "body": "Hey, I am at the pickup point."
}
```

- Creates the message and broadcasts `message:new` to the Pusher channel.

### Pusher Auth (Private Channels)

`POST /api/chat/pusher/auth` (JWT)

```json
{
  "socket_id": "1234.5678",
  "channel_name": "private-conversation-<conversationId>"
}
```

- Only conversation participants can subscribe.

---

## Users Module

### Update My Profile

`PUT /api/users/:id` (JWT – must match `id`)

```json
{
  "name": "Updated Name",
  "phone": "+1-226-000-0000",
  "providerAvatarUrl": "https://example.com/new-avatar.png"
}
```

- Allows the user to update their own basic profile fields.
- Does **not** allow changing email, roles, or verification flags.

---

## Error Format

Errors are returned as simple JSON:

```json
{
  "error": "Human-readable error message",
  "code": "OPTIONAL_MACHINE_READABLE_CODE"
}
```

Common status codes:

- `400` – Validation error / bad input
- `401` – Unauthorized (no/invalid token)
- `403` – Forbidden (e.g. email not verified, not owner/driver)
- `404` – Not found
- `409` – Conflict (e.g. duplicate email)
- `500` – Internal server error

---

## Roadmap / Future Enhancements

Planned (but not all implemented yet):

- **Notifications system** (DB + push + in-app feed)
  - Ride / ride-request matching alerts
  - Booking request/confirmation/cancellation notifications
- **Real-time chat** between passenger and driver (Pusher / websockets)
- **Phone verification** (OTP-based) for added safety
- **Advanced ride search**
  - Coordinate-based proximity search
  - Route-based matching with stored polylines, distance, and duration
- **Admin tools**
  - Driver verification / suspension
  - Basic log and abuse review tools
- **Payments**
  - Stripe integration for secure card payments
  - Sync `Payment` + `Booking` status


This README is meant as a working API guide for developers integrating the Flutter app and for backend contributors extending HelpRide.
