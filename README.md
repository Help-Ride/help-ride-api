# HelpRide API — Backend Service

A production-ready, modular, scalable backend powering the **HelpRide** mobile application — a ride-sharing platform for drivers and passengers built with Flutter.

This service handles:

- Authentication (Google / Apple OAuth)
- User profiles
- Ride creation, updates, deletion
- Ride search and detail pages
- Passenger booking system
- Seat availability + transactional safety
- Notifications, payments, and SOS (upcoming)

Built for Vercel serverless deployment using Express + Prisma + PostgreSQL.

---

## Tech Stack

| Layer         | Technology                                          |
| ------------- | --------------------------------------------------- |
| Runtime       | Node.js                                             |
| API Framework | Express.js                                          |
| Database ORM  | Prisma                                              |
| Database      | PostgreSQL (Neon)                                   |
| Auth          | JWT (access + refresh tokens), OAuth (Google/Apple) |
| Deployment    | Vercel (serverless functions wrapper)               |
| Testing       | VSCode REST Client (.http files)                    |

---

## Project Structure

```
help-ride-api/
│
├── src/
│   ├── app.ts
│   ├── server.ts
│   │
│   ├── lib/
│   │   ├── prisma.ts
│   │   └── jwt.ts
│   │
│   ├── middleware/
│   │   └── auth.ts
│   │
│   ├── controllers/
│   │   ├── auth.controller.ts
│   │   ├── ride.controller.ts
│   │   └── booking.controller.ts
│   │
│   ├── routes/
│   │   ├── auth.routes.ts
│   │   ├── ride.routes.ts
│   │   ├── booking.routes.ts
│   │   └── index.ts
│
├── prisma/
│   └── schema.prisma
│
├── api/
│   └── index.js                # Vercel serverless wrapper
│
├── dist/
├── package.json
├── tsconfig.json
└── README.md
```

---

## API Testing (VS Code REST Client)

The file `docs/help-ride-api.http` contains ready-to-run examples for all endpoints.

1. Install the “REST Client” extension in VS Code.
2. Open `docs/help-ride-api.http`.
3. Set `@baseUrl` to the desired environment:
   - Local: `http://localhost:4000/api`
   - Staging: `https://help-ride-api-git-feature-r-....vercel.app/api`
   - Prod: `https://help-ride-api.vercel.app/api`
4. Click **Send Request** above any block.

---

## Prisma Schema

See full schema inside `prisma/schema.prisma`.

---

## Authentication

### OAuth Login

`POST /api/auth/oauth`

### Get Authenticated User

`GET /api/auth/me`
Requires `Authorization: Bearer <accessToken>`

---

## Rides API

- `POST /api/rides` — create ride
- `GET /api/rides` — search rides
- `GET /api/rides/:id` — ride details
- `PATCH /api/rides/:id` — update ride
- `DELETE /api/rides/:id` — cancel/delete ride

---

## Booking API

- `POST /api/bookings/:rideId` — passenger books seats
- `GET /api/bookings/me/list` — passenger bookings
- `GET /api/bookings/ride/:rideId` — driver sees bookings

---

## Environment Variables

```
DATABASE_URL=postgresql://...
JWT_ACCESS_SECRET=your_secret
JWT_REFRESH_SECRET=your_secret
NODE_ENV=development
```

---

## Development

```
npm install
npm run dev
npx prisma generate
npx prisma migrate dev
```

---

## Deployment (Vercel)

- Runs `npm run build`
- Wraps Express using serverless-http
- Exposes all routes under `/api/*`

---

## Testing (VSCode REST Client)

Create a `.http` file:

```
@baseUrl = https://help-ride-api.vercel.app/api
GET {{baseUrl}}/health
```

---

## Roadmap

- Stripe payments
- Driver approvals
- Live location
- Ratings & reviews
- SOS workflow
- Admin dashboard

---
