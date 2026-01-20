# HelpRide API Documentation

A production-ready backend API for **HelpRide**, a ride-sharing platform connecting drivers and passengers.
This API powers authentication, rides, bookings, driver profiles, and ride requests.

---

## 🌐 Base URLs

```text
Local:   http://localhost:4000/api
Dev:     https://dev-help-ride-api.vercel.app/api
```

---

## 🧱 Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js (Vercel serverless)
- **Language:** TypeScript
- **Database:** PostgreSQL (via Prisma ORM)
- **Auth:** JWT + Email OTP + OAuth (Google)
- **Deployment:** Vercel
- **Testing:** VS Code REST Client (.http)

---

## 🔐 Authentication

### Register (Email + Password)

`POST /auth/register`

```json
{
  "name": "Email User",
  "email": "user@example.com",
  "password": "StrongPass123!"
}
```

Triggers email OTP verification.

---

### Login

`POST /auth/login`

```json
{
  "email": "user@example.com",
  "password": "StrongPass123!"
}
```

---

### Verify Email (OTP)

- Send OTP: `POST /auth/verify-email/send-otp`
- Verify OTP: `POST /auth/verify-email/verify-otp`

---

### OAuth Login

`POST /auth/oauth`

```json
{
  "provider": "google",
  "providerUserId": "google-123",
  "email": "test@example.com",
  "name": "Test User",
  "avatarUrl": "https://example.com/avatar.png"
}
```

---

### Get Current User

`GET /auth/me`
Header:

```
Authorization: Bearer <accessToken>
```

---

## 🚗 Rides

### Pricing Rules (Ontario)

The API resolves the final per-seat price on create/update using these rules:

1. Fixed route price (if configured)
2. ONTIME uplift (+30%) if booking is within 2 hours of departure
3. Minimum price protection (distance ≥ 55 km, seats ≤ 2, price < $20 → $20)
4. Same-drop ceiling (distance ≥ 50 km → price ≤ $15)
5. Upper safety cap (price ≤ distance × $0.30)

`pricePerSeat` in requests is treated as the base/desired value before rules apply.

---

### Create Ride (Driver)

`POST /rides`

```json
{
  "fromCity": "Waterloo",
  "fromLat": 43.46,
  "fromLng": -80.52,
  "toCity": "Toronto",
  "toLat": 43.65,
  "toLng": -79.38,
  "startTime": "2025-12-20T08:00:00.000Z",
  "arrivalTime": "2025-12-21T08:00:00.000Z",
  "seatsTotal": 1,
  "rideType": "one-time",
  "tripType": "one-way",
  "pricePerSeat": 22
}
```

---

### Search Rides (Public)

`GET /rides?fromCity=Waterloo&toCity=Toronto&seats=1`

---

### Get Ride by ID

`GET /rides/{rideId}`

---

### Update Ride (Driver)

`PUT /rides/{rideId}`

---

### Delete Ride (Driver)

`DELETE /rides/{rideId}`

---

## 📩 Bookings

### Create Booking (Passenger)

`POST /bookings/{rideId}`

```json
{
  "seats": 1
}
```

---

### My Bookings (Passenger)

`GET /bookings/me/list`

---

### Ride Bookings (Driver)

`GET /bookings/ride/{rideId}`

---

## 🧑‍✈️ Driver Profile

### Create Driver Profile

`POST /drivers`

```json
{
  "carMake": "Toyota",
  "carModel": "Corolla",
  "carYear": "2020",
  "carColor": "White",
  "plateNumber": "ABC-123",
  "licenseNumber": "LIC-987654",
  "insuranceInfo": "Policy #123456"
}
```

---

### Get Driver Profile

`GET /drivers/{userId}`

---

### Update Driver Profile

`PUT /drivers/{userId}`

---

## 📌 Ride Requests

Passengers create ride requests; drivers can browse pending requests and offer rides.

### Create Ride Request

`POST /ride-requests`

```json
{
  "fromCity": "Waterloo",
  "toCity": "Toronto",
  "preferredDate": "2025-12-20T08:00:00.000Z",
  "seatsNeeded": 1,
  "rideType": "one-time",
  "tripType": "one-way"
}
```

---

## 💵 Fixed Route Pricing

### Create Fixed Route Price

`POST /fixed-route-prices`

```json
{
  "fromCity": "Brampton",
  "toCity": "Whitby",
  "pricePerSeat": 12,
  "isActive": true
}
```

---

### List Fixed Route Prices

`GET /fixed-route-prices`

---

### Update Fixed Route Price

`PUT /fixed-route-prices/{id}`

```json
{
  "pricePerSeat": 15,
  "isActive": true
}
```

---

### Delete Fixed Route Price

`DELETE /fixed-route-prices/{id}`

---

### List Ride Requests (Public)

`GET /ride-requests?fromCity=Waterloo&toCity=Toronto`

---

### My Ride Requests

`GET /ride-requests/me/list`

---

### Delete Ride Request

`DELETE /ride-requests/{rideRequestId}`

---

### Create Ride Request Offer (Driver)

`POST /ride-requests/{rideRequestId}/offers`

```json
{
  "rideId": "ride-id",
  "seatsOffered": 1
}
```

---

### List Ride Request Offers (Passenger/Driver)

`GET /ride-requests/{rideRequestId}/offers`

---

### My Ride Request Offers (Driver)

`GET /ride-requests/offers/me/list`

---

### Accept Offer (Passenger)

`PUT /ride-requests/{rideRequestId}/offers/{offerId}/accept`

Accepting an offer confirms the ride and creates a confirmed booking.

---

### Reject Offer (Passenger)

`PUT /ride-requests/{rideRequestId}/offers/{offerId}/reject`

---

### Cancel Offer (Driver)

`PUT /ride-requests/{rideRequestId}/offers/{offerId}/cancel`

---

## 👤 User Profile

### Update Profile

`PUT /users/{userId}`

```json
{
  "name": "Updated Name",
  "phone": "+1-226-000-0000"
}
```

---

## 📄 Driver Documents

### Get Upload URL

`POST /drivers/{userId}/documents/presign`

```json
{
  "type": "license",
  "fileName": "license.jpg",
  "mimeType": "image/jpeg"
}
```

---

### List Documents

`GET /drivers/{userId}/documents`

---

## 🩺 Health Check

`GET /health`

---

## 🔐 Environment Variables

```env
DATABASE_URL=postgresql://...
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...
NODE_ENV=development
```

---

## 🚀 Roadmap

- Payments (Stripe)
- Driver verification workflow
- Ratings & reviews
- Live location tracking
- Admin dashboard

---

## 👨‍💻 Maintained By

**HelpRide Backend Team**
