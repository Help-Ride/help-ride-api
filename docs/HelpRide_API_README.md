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

### List Ride Requests (Public)

`GET /ride-requests?fromCity=Waterloo&toCity=Toronto`

---

### My Ride Requests

`GET /ride-requests/me/list`

---

### Delete Ride Request

`DELETE /ride-requests/{rideRequestId}`

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
