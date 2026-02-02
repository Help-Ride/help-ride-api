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

Response:

```json
{
  "user": {
    "id": "user-uuid",
    "name": "Email User",
    "email": "user@example.com",
    "roleDefault": "passenger",
    "providerAvatarUrl": null
  },
  "tokens": {
    "accessToken": "<jwt>",
    "refreshToken": "<jwt>"
  }
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

Response:

```json
{
  "user": {
    "id": "user-uuid",
    "name": "Email User",
    "email": "user@example.com",
    "roleDefault": "passenger",
    "providerAvatarUrl": null
  },
  "tokens": {
    "accessToken": "<jwt>",
    "refreshToken": "<jwt>"
  }
}
```

---

### Verify Email (OTP)

#### Send OTP

`POST /auth/verify-email/send-otp`

```json
{
  "email": "user@example.com"
}
```

Response:

```json
{
  "message": "Verification OTP sent."
}
```

#### Verify OTP

`POST /auth/verify-email/verify-otp`

```json
{
  "email": "user@example.com",
  "otp": "123456"
}
```

Response:

```json
{
  "user": {
    "id": "user-uuid",
    "name": "Email User",
    "email": "user@example.com",
    "roleDefault": "passenger",
    "providerAvatarUrl": null
  },
  "tokens": {
    "accessToken": "<jwt>",
    "refreshToken": "<jwt>"
  }
}
```

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

Response:

```json
{
  "user": {
    "id": "user-uuid",
    "name": "Test User",
    "email": "test@example.com",
    "roleDefault": "passenger",
    "providerAvatarUrl": "https://example.com/avatar.png"
  },
  "tokens": {
    "accessToken": "<jwt>",
    "refreshToken": "<jwt>"
  }
}
```

---

### Refresh Tokens

`POST /auth/refresh`

```json
{
  "refreshToken": "<jwt>"
}
```

Response:

```json
{
  "tokens": {
    "accessToken": "<jwt>",
    "refreshToken": "<jwt>"
  }
}
```

---

### Logout

`POST /auth/logout`

```json
{
  "refreshToken": "<jwt>"
}
```

Response:

```json
{
  "message": "Logged out successfully."
}
```

---

### Password Reset (OTP)

#### Send OTP

`POST /auth/password-reset/send-otp`

```json
{
  "email": "user@example.com"
}
```

Response:

```json
{
  "message": "Password reset OTP sent."
}
```

#### Verify OTP

`POST /auth/password-reset/verify-otp`

```json
{
  "email": "user@example.com",
  "otp": "123456",
  "newPassword": "NewStrongPass123!"
}
```

Response:

```json
{
  "message": "Password reset successful."
}
```

---

### Get Current User

`GET /auth/me`
Header:

```
Authorization: Bearer <accessToken>
```

Response:

```json
{
  "id": "user-uuid",
  "name": "Email User",
  "email": "user@example.com",
  "roleDefault": "passenger",
  "providerAvatarUrl": null,
  "driverProfile": null
}
```

---

## 🚗 Rides

### Pricing Rules (Ontario)

The API resolves the final per-seat price on create/update using these rules:

1. Fixed route price (if configured)
2. Ride timing classification based on departure lead time:
   - `PREBOOKED`: ride created/updated at least 10 hours before departure
   - `ONTIME`: ride created/updated within 2 hours of departure
3. ONTIME uplift (+30%) if ride timing is `ONTIME`
4. Minimum price protection (distance ≥ 55 km, seats ≤ 2, price < $20 → $20)
5. Same-drop ceiling (same destination and distance ≥ 50 km → price ≤ $15)
6. Upper safety cap (final price ≤ distance × $0.30)

`pricePerSeat` in requests is treated as the base/desired value before rules apply.
Ride responses include `rideTiming` (`PREBOOKED`, `ONTIME`, or `STANDARD`) for UI badges.

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

Response:

```json
{
  "id": "ride-uuid",
  "driverId": "user-uuid",
  "fromCity": "Waterloo",
  "fromLat": 43.46,
  "fromLng": -80.52,
  "toCity": "Toronto",
  "toLat": 43.65,
  "toLng": -79.38,
  "startTime": "2025-12-20T08:00:00.000Z",
  "arrivalTime": null,
  "pricePerSeat": 22,
  "seatsTotal": 1,
  "seatsAvailable": 1,
  "status": "open",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z"
}
```

---

### Search Rides (Public)

`GET /rides?fromCity=Waterloo&toCity=Toronto&seats=1`

Response:

```json
[
  {
    "id": "ride-uuid",
    "fromCity": "Waterloo",
    "toCity": "Toronto",
    "startTime": "2025-12-20T08:00:00.000Z",
    "pricePerSeat": 22,
    "seatsAvailable": 1,
    "status": "open",
    "driver": {
      "id": "driver-uuid",
      "name": "Driver Name",
      "providerAvatarUrl": null
    }
  }
]
```

---

### Search Rides (Geolocation)

`GET /rides?fromLat=43.4643&fromLng=-80.5204&toLat=43.6532&toLng=-79.3832&radiusKm=25&seats=1`

Response:

```json
[
  {
    "id": "ride-uuid",
    "fromCity": "Waterloo",
    "toCity": "Toronto",
    "startTime": "2025-12-20T08:00:00.000Z",
    "pricePerSeat": 22,
    "seatsAvailable": 1,
    "status": "open",
    "driver": {
      "id": "driver-uuid",
      "name": "Driver Name",
      "providerAvatarUrl": null
    }
  }
]
```

---

### Get My Rides (Driver)

`GET /rides/me/list`

Response:

```json
[
  {
    "id": "ride-uuid",
    "driverId": "driver-uuid",
    "fromCity": "Waterloo",
    "toCity": "Toronto",
    "startTime": "2025-12-20T08:00:00.000Z",
    "pricePerSeat": 22,
    "seatsTotal": 1,
    "seatsAvailable": 1,
    "status": "open",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T00:00:00.000Z"
  }
]
```

---

### Get Ride by ID

`GET /rides/{rideId}`

Response:

```json
{
  "id": "ride-uuid",
  "driverId": "driver-uuid",
  "fromCity": "Waterloo",
  "toCity": "Toronto",
  "startTime": "2025-12-20T08:00:00.000Z",
  "pricePerSeat": 22,
  "seatsTotal": 1,
  "seatsAvailable": 1,
  "status": "open",
  "driver": {
    "id": "driver-uuid",
    "name": "Driver Name",
    "providerAvatarUrl": null
  },
  "bookings": [
    {
      "id": "booking-uuid",
      "seatsBooked": 1,
      "status": "pending"
    }
  ]
}
```

---

### Update Ride (Driver)

`PUT /rides/{rideId}`

Response:

```json
{
  "id": "ride-uuid",
  "driverId": "driver-uuid",
  "fromCity": "Waterloo",
  "toCity": "Toronto",
  "startTime": "2025-12-20T08:00:00.000Z",
  "pricePerSeat": 22,
  "seatsTotal": 2,
  "seatsAvailable": 2,
  "status": "open",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T01:00:00.000Z"
}
```

---

### Delete Ride (Driver)

`DELETE /rides/{rideId}`

Response:

```
204 No Content
```

---

### Ride Lifecycle (Driver)

- Start: `POST /rides/{rideId}/start`
- Complete: `POST /rides/{rideId}/complete`
- Cancel: `POST /rides/{rideId}/cancel`

Cancel body:

```json
{
  "reason": "Driver unavailable"
}
```

Start response:

```json
{
  "id": "ride-uuid",
  "status": "ongoing",
  "updatedAt": "2025-01-01T02:00:00.000Z"
}
```

Complete response:

```json
{
  "ride": {
    "id": "ride-uuid",
    "status": "completed",
    "updatedAt": "2025-01-01T03:00:00.000Z"
  },
  "bookings": {
    "count": 2
  }
}
```

Cancel response:

```json
{
  "ride": {
    "id": "ride-uuid",
    "status": "cancelled",
    "updatedAt": "2025-01-01T04:00:00.000Z"
  },
  "bookings": {
    "count": 2
  }
}
```

---

## 📩 Bookings

### Create Booking (Passenger)

`POST /bookings/{rideId}`

```json
{
  "seats": 1
}
```

Response:

```json
{
  "id": "booking-uuid",
  "rideId": "ride-uuid",
  "passengerId": "passenger-uuid",
  "seatsBooked": 1,
  "status": "pending",
  "paymentStatus": "unpaid",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z",
  "passenger": {
    "id": "passenger-uuid",
    "name": "Passenger Name",
    "email": "passenger@example.com",
    "providerAvatarUrl": null
  },
  "ride": {
    "id": "ride-uuid",
    "fromCity": "Waterloo",
    "toCity": "Toronto",
    "startTime": "2025-12-20T08:00:00.000Z",
    "pricePerSeat": 22,
    "status": "open",
    "driver": {
      "id": "driver-uuid",
      "name": "Driver Name",
      "email": "driver@example.com",
      "providerAvatarUrl": null
    }
  }
}
```

---

### My Bookings (Passenger)

`GET /bookings/me/list`

Response:

```json
[
  {
    "id": "booking-uuid",
    "rideId": "ride-uuid",
    "passengerId": "passenger-uuid",
    "seatsBooked": 1,
    "status": "pending",
    "paymentStatus": "unpaid",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T00:00:00.000Z",
    "passenger": {
      "id": "passenger-uuid",
      "name": "Passenger Name",
      "email": "passenger@example.com",
      "providerAvatarUrl": null
    },
    "ride": {
      "id": "ride-uuid",
      "fromCity": "Waterloo",
      "toCity": "Toronto",
      "startTime": "2025-12-20T08:00:00.000Z",
      "pricePerSeat": 22,
      "status": "open",
      "driver": {
        "id": "driver-uuid",
        "name": "Driver Name",
        "email": "driver@example.com",
        "providerAvatarUrl": null
      }
    }
  }
]
```

---

### Driver Inbox (Bookings)

`GET /bookings/driver/me?status=pending&limit=50&cursor=...`

Response:

```json
{
  "bookings": [
    {
      "id": "booking-uuid",
      "seatsBooked": 1,
      "status": "pending",
      "paymentStatus": "unpaid",
      "createdAt": "2025-01-01T00:00:00.000Z",
      "passenger": {
        "id": "passenger-uuid",
        "name": "Passenger Name",
        "email": "passenger@example.com",
        "phone": "+1-226-000-0000",
        "providerAvatarUrl": null
      },
      "ride": {
        "id": "ride-uuid",
        "fromCity": "Waterloo",
        "toCity": "Toronto",
        "startTime": "2025-12-20T08:00:00.000Z",
        "pricePerSeat": 22,
        "status": "open",
        "driver": {
          "id": "driver-uuid",
          "name": "Driver Name",
          "email": "driver@example.com",
          "providerAvatarUrl": null
        }
      }
    }
  ],
  "nextCursor": "booking-uuid"
}
```

---

### Ride Bookings (Driver)

`GET /bookings/ride/{rideId}`

Response:

```json
[
  {
    "id": "booking-uuid",
    "rideId": "ride-uuid",
    "passengerId": "passenger-uuid",
    "seatsBooked": 1,
    "status": "pending",
    "paymentStatus": "unpaid",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T00:00:00.000Z",
    "passenger": {
      "id": "passenger-uuid",
      "name": "Passenger Name",
      "email": "passenger@example.com",
      "providerAvatarUrl": null
    },
    "ride": {
      "id": "ride-uuid",
      "fromCity": "Waterloo",
      "toCity": "Toronto",
      "startTime": "2025-12-20T08:00:00.000Z",
      "pricePerSeat": 22,
      "status": "open",
      "driver": {
        "id": "driver-uuid",
        "name": "Driver Name",
        "email": "driver@example.com",
        "providerAvatarUrl": null
      }
    }
  }
]
```

---

### Confirm Booking (Driver)

`PUT /bookings/{bookingId}/confirm`

Response:

```json
{
  "booking": {
    "id": "booking-uuid",
    "rideId": "ride-uuid",
    "passengerId": "passenger-uuid",
    "seatsBooked": 1,
    "status": "ACCEPTED",
    "paymentStatus": "unpaid",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T01:00:00.000Z",
    "passenger": {
      "id": "passenger-uuid",
      "name": "Passenger Name",
      "email": "passenger@example.com",
      "providerAvatarUrl": null
    },
    "ride": {
      "id": "ride-uuid",
      "fromCity": "Waterloo",
      "toCity": "Toronto",
      "startTime": "2025-12-20T08:00:00.000Z",
      "pricePerSeat": 22,
      "status": "open",
      "driver": {
        "id": "driver-uuid",
        "name": "Driver Name",
        "email": "driver@example.com",
        "providerAvatarUrl": null
      }
    }
  },
  "ride": {
    "id": "ride-uuid",
    "seatsAvailable": 0,
    "status": "open"
  }
}
```

---

### Reject Booking (Driver)

`PUT /bookings/{bookingId}/reject`

Response:

```json
{
  "id": "booking-uuid",
  "rideId": "ride-uuid",
  "passengerId": "passenger-uuid",
  "seatsBooked": 1,
  "status": "cancelled_by_driver",
  "paymentStatus": "unpaid",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T01:00:00.000Z",
  "passenger": {
    "id": "passenger-uuid",
    "name": "Passenger Name",
    "email": "passenger@example.com",
    "providerAvatarUrl": null
  },
  "ride": {
    "id": "ride-uuid",
    "fromCity": "Waterloo",
    "toCity": "Toronto",
    "startTime": "2025-12-20T08:00:00.000Z",
    "pricePerSeat": 22,
    "status": "open",
    "driver": {
      "id": "driver-uuid",
      "name": "Driver Name",
      "email": "driver@example.com",
      "providerAvatarUrl": null
    }
  }
}
```

---

### Cancel Booking (Passenger)

`POST /bookings/{bookingId}/cancel`

Response:

```json
{
  "booking": {
    "id": "booking-uuid",
    "rideId": "ride-uuid",
    "passengerId": "passenger-uuid",
    "seatsBooked": 1,
    "status": "cancelled_by_passenger",
    "paymentStatus": "unpaid",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T01:00:00.000Z",
    "passenger": {
      "id": "passenger-uuid",
      "name": "Passenger Name",
      "email": "passenger@example.com",
      "providerAvatarUrl": null
    },
    "ride": {
      "id": "ride-uuid",
      "fromCity": "Waterloo",
      "toCity": "Toronto",
      "startTime": "2025-12-20T08:00:00.000Z",
      "pricePerSeat": 22,
      "status": "open",
      "driver": {
        "id": "driver-uuid",
        "name": "Driver Name",
        "email": "driver@example.com",
        "providerAvatarUrl": null
      }
    }
  },
  "ride": {
    "id": "ride-uuid",
    "seatsAvailable": 1,
    "status": "open"
  }
}
```

---

### Cancel Booking (Driver)

`POST /bookings/{bookingId}/driver-cancel`

Response:

```json
{
  "booking": {
    "id": "booking-uuid",
    "rideId": "ride-uuid",
    "passengerId": "passenger-uuid",
    "seatsBooked": 1,
    "status": "cancelled_by_driver",
    "paymentStatus": "unpaid",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T01:00:00.000Z",
    "passenger": {
      "id": "passenger-uuid",
      "name": "Passenger Name",
      "email": "passenger@example.com",
      "providerAvatarUrl": null
    },
    "ride": {
      "id": "ride-uuid",
      "fromCity": "Waterloo",
      "toCity": "Toronto",
      "startTime": "2025-12-20T08:00:00.000Z",
      "pricePerSeat": 22,
      "status": "open",
      "driver": {
        "id": "driver-uuid",
        "name": "Driver Name",
        "email": "driver@example.com",
        "providerAvatarUrl": null
      }
    }
  },
  "ride": {
    "id": "ride-uuid",
    "seatsAvailable": 1,
    "status": "open"
  }
}
```

---

## 💳 Stripe Payments

Phase 1 uses platform-only collection:
- Passenger card payments go to the HelpRide Stripe account.
- Driver payouts are tracked internally and settled manually (e-Transfer/cash/off-platform).
- Stripe Connect onboarding is disabled.

### Create PaymentIntent (Passenger)

`POST /payments/intent`

```json
{
  "bookingId": "booking-uuid"
}
```

Response:

```json
{
  "clientSecret": "pi_..._secret_...",
  "paymentIntentId": "pi_...",
  "amount": 2200,
  "currency": "cad",
  "helpRideFeeCents": 330,
  "driverEarningsCents": 1870
}
```

Notes:
- Booking must be `ACCEPTED`.
- Amount is computed server-side (distance/seat-based pricing model) and never accepted from client input.
- If a booking already has a `stripePaymentIntentId`, the existing intent is reused (idempotency).
- Booking transitions to `PAYMENT_PENDING` after intent creation/reuse.
- Funds are collected into the HelpRide Stripe account (no direct transfer to driver).

---

### Get PaymentIntent (Debug / Status)

`GET /payments/intent/:id`

Response:

```json
{
  "paymentIntentId": "pi_...",
  "clientSecret": "pi_..._secret_...",
  "amount": 2200,
  "currency": "cad",
  "stripeStatus": "requires_payment_method",
  "localStatus": "pending",
  "helpRideFeeCents": 330,
  "driverEarningsCents": 1870,
  "bookingId": "booking-uuid",
  "bookingStatus": "PAYMENT_PENDING",
  "bookingPaymentStatus": "pending",
  "rideId": "ride-uuid"
}
```

---

### Stripe Webhook

`POST /webhooks/stripe`

Stripe dashboard configuration:
- Endpoint URL: `/api/webhooks/stripe`
- Events: `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`

Local forwarding:

```bash
stripe listen --forward-to localhost:4000/api/webhooks/stripe
```

Listen for:
- `payment_intent.succeeded` → booking `CONFIRMED` + payment status `paid`
- `payment_intent.payment_failed` → booking `ACCEPTED` + payment status `failed`
- `charge.refunded` → payment status `refunded`

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

Response:

```json
{
  "id": "driver-profile-uuid",
  "userId": "user-uuid",
  "carMake": "Toyota",
  "carModel": "Corolla",
  "carYear": "2020",
  "carColor": "White",
  "plateNumber": "ABC-123",
  "licenseNumber": "LIC-987654",
  "insuranceInfo": "Policy #123456",
  "isVerified": false,
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z",
  "user": {
    "id": "user-uuid",
    "name": "Driver Name",
    "email": "driver@example.com",
    "providerAvatarUrl": null
  }
}
```

---

### Get Driver Profile

`GET /drivers/{userId}`

Response:

```json
{
  "id": "driver-profile-uuid",
  "userId": "user-uuid",
  "carMake": "Toyota",
  "carModel": "Corolla",
  "carYear": "2020",
  "carColor": "White",
  "plateNumber": "ABC-123",
  "licenseNumber": "LIC-987654",
  "insuranceInfo": "Policy #123456",
  "isVerified": false,
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z",
  "user": {
    "id": "user-uuid",
    "name": "Driver Name",
    "email": "driver@example.com",
    "providerAvatarUrl": null
  }
}
```

---

### Update Driver Profile

`PUT /drivers/{userId}`

Response:

```json
{
  "id": "driver-profile-uuid",
  "userId": "user-uuid",
  "carMake": "Toyota",
  "carModel": "Corolla",
  "carYear": "2021",
  "carColor": "White",
  "plateNumber": "ABC-123",
  "licenseNumber": "LIC-987654",
  "insuranceInfo": "Policy #123456",
  "isVerified": false,
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T01:00:00.000Z",
  "user": {
    "id": "user-uuid",
    "name": "Driver Name",
    "email": "driver@example.com",
    "providerAvatarUrl": null
  }
}
```

---

### Driver Summary (Rides + Earnings)

`GET /drivers/me/summary`

Response:

```json
{
  "rides": {
    "total": 14,
    "completed": 11
  },
  "earnings": {
    "pending": {
      "paymentsCount": 2,
      "amountCents": 3800
    },
    "paid": {
      "paymentsCount": 9,
      "amountCents": 22450
    },
    "refunded": {
      "paymentsCount": 1,
      "amountCents": 2500
    },
    "failed": {
      "paymentsCount": 1,
      "amountCents": 0
    },
    "netCollectedCents": 19950
  }
}
```

---

### Driver Earnings Ledger (Paginated)

`GET /drivers/me/earnings?status=succeeded&limit=20&cursor=<paymentId>`

Response:

```json
{
  "payments": [
    {
      "id": "payment-uuid",
      "paymentIntentId": "pi_...",
      "amountCents": 2500,
      "platformFeeCents": 375,
      "driverEarningsCents": 2125,
      "currency": "cad",
      "status": "succeeded",
      "createdAt": "2026-02-02T00:00:00.000Z",
      "updatedAt": "2026-02-02T00:02:00.000Z",
      "booking": {
        "id": "booking-uuid",
        "status": "CONFIRMED",
        "paymentStatus": "paid",
        "seatsBooked": 1,
        "passenger": {
          "id": "passenger-uuid",
          "name": "Passenger Name",
          "email": "passenger@example.com"
        },
        "ride": {
          "id": "ride-uuid",
          "fromCity": "Waterloo",
          "toCity": "Toronto",
          "startTime": "2026-02-05T14:00:00.000Z",
          "status": "completed"
        }
      }
    }
  ],
  "nextCursor": "payment-uuid"
}
```

---

## 📌 Ride Requests

Passengers create ride requests; requests are dispatched to realtime matching and move to `OFFERING`.

Status values:
- RideRequest: `PENDING`, `OFFERING`, `ACCEPTED`, `CANCELLED`, `EXPIRED`
- RideRequestOffer: `SENT`, `ACCEPTED`, `REJECTED`, `EXPIRED`

### Create Ride Request

`POST /ride-requests`

Notes:
- Pickup coordinates are stored in `fromLat`/`fromLng` and are required.
- Coordinates must be within valid ranges (lat: -90..90, lng: -180..180).

```json
{
  "fromCity": "Waterloo",
  "fromLat": 43.46,
  "fromLng": -80.52,
  "toCity": "Toronto",
  "toLat": 43.65,
  "toLng": -79.38,
  "preferredDate": "2025-12-20T08:00:00.000Z",
  "seatsNeeded": 1,
  "rideType": "one-time",
  "tripType": "one-way"
}
```

Response:

```json
{
  "id": "ride-request-uuid",
  "passengerId": "passenger-uuid",
  "fromCity": "Waterloo",
  "fromLat": 43.46,
  "fromLng": -80.52,
  "toCity": "Toronto",
  "toLat": 43.65,
  "toLng": -79.38,
  "preferredDate": "2025-12-20T08:00:00.000Z",
  "preferredTime": null,
  "arrivalTime": null,
  "seatsNeeded": 1,
  "rideType": "one-time",
  "tripType": "one-way",
  "returnDate": null,
  "returnTime": null,
  "status": "OFFERING",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z",
  "passenger": {
    "id": "passenger-uuid",
    "name": "Passenger Name",
    "email": "passenger@example.com",
    "providerAvatarUrl": null
  }
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

Response:

```json
{
  "id": "fixed-route-uuid",
  "fromCity": "brampton",
  "toCity": "whitby",
  "pricePerSeat": 12,
  "isActive": true,
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z"
}
```

---

### List Fixed Route Prices

`GET /fixed-route-prices`

Response:

```json
[
  {
    "id": "fixed-route-uuid",
    "fromCity": "brampton",
    "toCity": "whitby",
    "pricePerSeat": 12,
    "isActive": true,
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T00:00:00.000Z"
  }
]
```

---

### Update Fixed Route Price

`PUT /fixed-route-prices/{id}`

```json
{
  "pricePerSeat": 15,
  "isActive": true
}
```

Response:

```json
{
  "id": "fixed-route-uuid",
  "fromCity": "brampton",
  "toCity": "whitby",
  "pricePerSeat": 15,
  "isActive": true,
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T01:00:00.000Z"
}
```

---

### Delete Fixed Route Price

`DELETE /fixed-route-prices/{id}`

Response:

```
204 No Content
```

---

### List Ride Requests (Public)

`GET /ride-requests?fromCity=Waterloo&toCity=Toronto`

Response:

```json
{
  "requests": [
    {
      "id": "ride-request-uuid",
      "passengerId": "passenger-uuid",
      "fromCity": "Waterloo",
      "toCity": "Toronto",
      "preferredDate": "2025-12-20T08:00:00.000Z",
      "seatsNeeded": 1,
      "status": "OFFERING",
      "passenger": {
        "id": "passenger-uuid",
        "name": "Passenger Name",
        "email": "passenger@example.com",
        "providerAvatarUrl": null
      }
    }
  ],
  "nextCursor": "ride-request-uuid"
}
```

---

### List Ride Requests (Pickup Nearby)

`GET /ride-requests?lat=43.4643&lng=-80.5204&radiusKm=25&limit=20`

Notes:
- `radiusKm` defaults to 25 and is capped at 100.
- `limit` defaults to 50 (max 100).
- Use `cursor` (rideRequestId) to fetch the next page.

Response:

```json
{
  "requests": [
    {
      "id": "ride-request-uuid",
      "passengerId": "passenger-uuid",
      "fromCity": "Waterloo",
      "toCity": "Toronto",
      "preferredDate": "2025-12-20T08:00:00.000Z",
      "seatsNeeded": 1,
      "status": "OFFERING",
      "passenger": {
        "id": "passenger-uuid",
        "name": "Passenger Name",
        "email": "passenger@example.com",
        "providerAvatarUrl": null
      }
    }
  ],
  "nextCursor": "ride-request-uuid"
}
```

---

### Get Ride Request by ID

`GET /ride-requests/{rideRequestId}`

Response:

```json
{
  "id": "ride-request-uuid",
  "passengerId": "passenger-uuid",
  "fromCity": "Waterloo",
  "toCity": "Toronto",
  "preferredDate": "2025-12-20T08:00:00.000Z",
  "seatsNeeded": 1,
  "status": "OFFERING",
  "passenger": {
    "id": "passenger-uuid",
    "name": "Passenger Name",
    "email": "passenger@example.com",
    "providerAvatarUrl": null
  }
}
```

---

### Update Ride Request (Passenger)

`PUT /ride-requests/{rideRequestId}`

```json
{
  "preferredTime": "09:30",
  "arrivalTime": "12:00",
  "seatsNeeded": 2
}
```

Response:

```json
{
  "id": "ride-request-uuid",
  "preferredTime": "09:30",
  "arrivalTime": "12:00",
  "seatsNeeded": 2,
  "status": "OFFERING",
  "updatedAt": "2025-01-01T01:00:00.000Z",
  "passenger": {
    "id": "passenger-uuid",
    "name": "Passenger Name",
    "email": "passenger@example.com",
    "providerAvatarUrl": null
  }
}
```

---

### My Ride Requests

`GET /ride-requests/me/list`

Response:

```json
[
  {
    "id": "ride-request-uuid",
    "passengerId": "passenger-uuid",
    "fromCity": "Waterloo",
    "toCity": "Toronto",
    "preferredDate": "2025-12-20T08:00:00.000Z",
    "seatsNeeded": 1,
    "status": "OFFERING",
    "passenger": {
      "id": "passenger-uuid",
      "name": "Passenger Name",
      "email": "passenger@example.com",
      "providerAvatarUrl": null
    }
  }
]
```

---

### Cancel Ride Request

`POST /ride-requests/{rideRequestId}/cancel`

Response:

```json
{
  "id": "ride-request-uuid",
  "status": "CANCELLED",
  "updatedAt": "2025-01-01T01:00:00.000Z"
}
```

---

### Realtime Accept Callback (Server-to-Server)

`POST /ride-requests/{rideRequestId}/accept`

Headers:
- `X-REALTIME-SECRET: <REALTIME_TO_API_SECRET>`

Body:

```json
{
  "driverId": "driver-uuid",
  "rideId": "ride-uuid",
  "seatsOffered": 1,
  "pricePerSeat": 22
}
```

Notes:
- This endpoint does **not** use JWT.
- It is idempotent (duplicate callbacks return success).
- First accepted callback wins.

---

### Delete Ride Request (Legacy Alias)

`DELETE /ride-requests/{rideRequestId}`

Response:

```json
{
  "id": "ride-request-uuid",
  "status": "CANCELLED",
  "updatedAt": "2025-01-01T01:00:00.000Z"
}
```

---

### Create Ride Request Offer (Driver)

`POST /ride-requests/{rideRequestId}/offers`

```json
{
  "rideId": "ride-id",
  "seatsOffered": 1
}
```

Response:

```json
{
  "id": "offer-uuid",
  "rideRequestId": "ride-request-uuid",
  "driverId": "driver-uuid",
  "rideId": "ride-uuid",
  "seatsOffered": 1,
  "pricePerSeat": 22,
  "status": "SENT",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z"
}
```

---

### List Ride Request Offers (Passenger/Driver)

`GET /ride-requests/{rideRequestId}/offers`

Response:

```json
[
  {
    "id": "offer-uuid",
    "rideRequestId": "ride-request-uuid",
    "driverId": "driver-uuid",
    "rideId": "ride-uuid",
    "seatsOffered": 1,
    "pricePerSeat": 22,
    "status": "SENT",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "ride": {
      "id": "ride-uuid",
      "fromCity": "Waterloo",
      "toCity": "Toronto",
      "startTime": "2025-12-20T08:00:00.000Z"
    },
    "driver": {
      "id": "driver-uuid",
      "name": "Driver Name",
      "email": "driver@example.com",
      "providerAvatarUrl": null
    }
  }
]
```

---

### My Ride Request Offers (Driver)

`GET /ride-requests/offers/me/list`

Response:

```json
[
  {
    "id": "offer-uuid",
    "rideRequestId": "ride-request-uuid",
    "driverId": "driver-uuid",
    "rideId": "ride-uuid",
    "seatsOffered": 1,
    "pricePerSeat": 22,
    "status": "SENT",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "rideRequest": {
      "id": "ride-request-uuid",
      "fromCity": "Waterloo",
      "toCity": "Toronto",
      "preferredDate": "2025-12-20T08:00:00.000Z",
      "seatsNeeded": 1,
      "passenger": {
        "id": "passenger-uuid",
        "name": "Passenger Name",
        "email": "passenger@example.com",
        "providerAvatarUrl": null
      }
    }
  }
]
```

---

### Accept Offer (Passenger)

`PUT /ride-requests/{rideRequestId}/offers/{offerId}/accept`

Accepting an offer accepts the ride and creates an accepted booking.

Response:

```json
{
  "offer": {
    "id": "offer-uuid",
    "status": "ACCEPTED"
  },
  "rideRequest": {
    "id": "ride-request-uuid",
    "status": "ACCEPTED"
  },
  "booking": {
    "id": "booking-uuid",
    "rideId": "ride-uuid",
    "passengerId": "passenger-uuid",
    "seatsBooked": 1,
    "status": "ACCEPTED",
    "passenger": {
      "id": "passenger-uuid",
      "name": "Passenger Name",
      "email": "passenger@example.com",
      "providerAvatarUrl": null
    },
    "ride": {
      "id": "ride-uuid",
      "fromCity": "Waterloo",
      "toCity": "Toronto",
      "startTime": "2025-12-20T08:00:00.000Z",
      "pricePerSeat": 22,
      "status": "open",
      "driver": {
        "id": "driver-uuid",
        "name": "Driver Name",
        "email": "driver@example.com",
        "providerAvatarUrl": null
      }
    }
  },
  "ride": {
    "id": "ride-uuid",
    "seatsAvailable": 0,
    "status": "open"
  }
}
```

---

### Reject Offer (Passenger)

`PUT /ride-requests/{rideRequestId}/offers/{offerId}/reject`

Response:

```json
{
  "id": "offer-uuid",
  "status": "REJECTED"
}
```

---

### Cancel Offer (Driver)

`PUT /ride-requests/{rideRequestId}/offers/{offerId}/cancel`

Response:

```json
{
  "id": "offer-uuid",
  "status": "EXPIRED"
}
```

---

## 💬 Chat

### Create / Get Conversation

`POST /chat/conversations`

```json
{
  "rideId": "ride-uuid",
  "passengerId": "passenger-uuid"
}
```

Response:

```json
{
  "id": "conversation-uuid",
  "rideId": "ride-uuid",
  "passengerId": "passenger-uuid",
  "driverId": "driver-uuid",
  "lastMessageAt": null,
  "lastMessagePreview": null,
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z",
  "passenger": {
    "id": "passenger-uuid",
    "name": "Passenger Name",
    "email": "passenger@example.com",
    "providerAvatarUrl": null
  },
  "driver": {
    "id": "driver-uuid",
    "name": "Driver Name",
    "email": "driver@example.com",
    "providerAvatarUrl": null
  }
}
```

---

### List My Conversations

`GET /chat/conversations`

Response:

```json
[
  {
    "id": "conversation-uuid",
    "rideId": "ride-uuid",
    "passengerId": "passenger-uuid",
    "driverId": "driver-uuid",
    "lastMessageAt": "2025-01-01T02:00:00.000Z",
    "lastMessagePreview": "See you soon",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T02:00:00.000Z",
    "passenger": {
      "id": "passenger-uuid",
      "name": "Passenger Name",
      "email": "passenger@example.com",
      "providerAvatarUrl": null
    },
    "driver": {
      "id": "driver-uuid",
      "name": "Driver Name",
      "email": "driver@example.com",
      "providerAvatarUrl": null
    }
  }
]
```

---

### List Messages

`GET /chat/conversations/{conversationId}/messages?limit=50&cursor=...`

Response:

```json
{
  "messages": [
    {
      "id": "message-uuid",
      "conversationId": "conversation-uuid",
      "senderId": "passenger-uuid",
      "body": "Hello!",
      "readAt": null,
      "createdAt": "2025-01-01T02:00:00.000Z",
      "sender": {
        "id": "passenger-uuid",
        "name": "Passenger Name",
        "providerAvatarUrl": null
      }
    }
  ],
  "nextCursor": "message-uuid"
}
```

---

### Mark Messages Read

`POST /chat/conversations/{conversationId}/read`

Response:

```json
{
  "conversationId": "conversation-uuid",
  "readCount": 2,
  "readAt": "2025-01-01T02:05:00.000Z",
  "messageIds": ["message-uuid-1", "message-uuid-2"]
}
```

---

### Send Message

`POST /chat/conversations/{conversationId}/messages`

```json
{
  "body": "Hello!"
}
```

Response:

```json
{
  "id": "message-uuid",
  "conversationId": "conversation-uuid",
  "senderId": "passenger-uuid",
  "body": "Hello!",
  "readAt": null,
  "createdAt": "2025-01-01T02:00:00.000Z",
  "sender": {
    "id": "passenger-uuid",
    "name": "Passenger Name",
    "providerAvatarUrl": null
  }
}
```

---

### Pusher Auth

`POST /chat/pusher/auth`

```json
{
  "socket_id": "1234.5678",
  "channel_name": "private-user-user-uuid"
}
```

Response:

```json
{
  "auth": "app-key:signature"
}
```

---

## 🔔 Notifications

### List Notifications (Paginated)

`GET /notifications?isRead=false&limit=50&cursor=...`

Response:

```json
{
  "notifications": [
    {
      "id": "notification-uuid",
      "userId": "user-uuid",
      "title": "Booking accepted",
      "body": "Waterloo → Toronto is accepted",
      "type": "ride_update",
      "isRead": false,
      "createdAt": "2025-01-01T00:00:00.000Z"
    }
  ],
  "nextCursor": "notification-uuid"
}
```

---

### Register Device Token (FCM)

`POST /notifications/tokens/register`

```json
{
  "token": "<fcm_device_token>",
  "platform": "android"
}
```

Response:

```json
{
  "id": "device-token-uuid",
  "userId": "user-uuid",
  "token": "<fcm_device_token>",
  "platform": "android",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z"
}
```

---

### Unregister Device Token (FCM)

`POST /notifications/tokens/unregister`

```json
{
  "token": "<fcm_device_token>"
}
```

Response:

```json
{
  "removed": 1
}
```

---

### Mark Notification Read

`POST /notifications/{notificationId}/read`

Response:

```json
{
  "id": "notification-uuid",
  "userId": "user-uuid",
  "title": "Booking accepted",
  "body": "Waterloo → Toronto is accepted",
  "type": "ride_update",
  "isRead": true,
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

---

### Mark All Notifications Read

`POST /notifications/read-all`

Response:

```json
{
  "count": 3
}
```

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

Response:

```json
{
  "id": "user-uuid",
  "name": "Updated Name",
  "email": "user@example.com",
  "phone": "+1-226-000-0000",
  "roleDefault": "passenger",
  "providerAvatarUrl": null,
  "emailVerified": true,
  "createdAt": "2025-01-01T00:00:00.000Z"
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

Response:

```json
{
  "uploadUrl": "https://s3.example.com/presigned-url",
  "document": {
    "id": "document-uuid",
    "type": "license",
    "status": "pending",
    "fileName": "license.jpg",
    "s3Key": "drivers/user-uuid/license/document-uuid-license.jpg"
  }
}
```

---

### List Documents

`GET /drivers/{userId}/documents`

Response:

```json
[
  {
    "id": "document-uuid",
    "type": "license",
    "status": "pending",
    "fileName": "license.jpg",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "downloadUrl": "https://s3.example.com/download-url"
  }
]
```

---

## 🩺 Health Check

`GET /health`

Response:

```json
{
  "status": "oksss",
  "ts": "2025-01-01T00:00:00.000Z"
}
```

---

## 🔐 Environment Variables

```env
DATABASE_URL=postgresql://...
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...
NODE_ENV=development
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY=...
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
PAYMENT_PLATFORM_FEE_PCT=0.15
# optional backward-compatible alias:
# STRIPE_PLATFORM_FEE_PCT=0.15
REALTIME_BASE_URL=https://your-realtime-app.fly.dev
REALTIME_TO_API_SECRET=rts_xxx
# JWT_ACCESS_SECRET must match your Fly.io realtime service
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
