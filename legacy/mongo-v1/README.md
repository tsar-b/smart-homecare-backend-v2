# Smart HomeCare Backend

TypeScript/Express backend for Smart HomeCare booking & user management.
Supports standard login, Kakao login, and Apple Sign-In token verification.
MongoDB (Mongoose) is used for persistence.

## Tech Stack
- Node.js + TypeScript
- Express
- MongoDB + Mongoose
- JWT authentication
- Kakao OAuth (access token based)
- Apple Sign-In (identity token verification via Apple JWKS)

## Design Decisions

- MongoDB was chosen due to flexible booking schemas and evolving service options given the scope of this project.
- JWT is used for stateless authentication to simplify horizontal scaling.
- Kakao and Apple Sign-In are handled server-side to avoid trusting client claims.
- Admin APIs are strictly separated under /api/admin with role-based authorization.

## Authentication Flow

- Standard login returns a JWT signed with JWT_SECRET.
- Kakao login verifies the access token with Kakao API, then issues a local JWT.
- Apple Sign-In verifies the identity token against Apple JWKS before issuing a JWT.
- JWT payload includes userId and isAdmin flag.

## Planned / In Progress
- Real-time notifications 
- File/image uploads

## Out of Scope
- Payment processing (handled externally)

## Requirements
- Node.js 18+ recommended
- MongoDB instance (local or hosted)

## Setup

### 1) Install
npm install

### 2) Configure environment variables

Create a .env file in the project root:

# Server
PORT=5000

# Database
MONGODB_URI=mongodb://localhost:27017/smart-homecare

# Auth
JWT_SECRET=replace_me_with_a_long_random_string

# Kakao
KAKAO_REST_API_KEY=your_kakao_rest_api_key
KAKAO_ADMIN_KEY=your_kakao_admin_key

# Apple
APPLE_SERVICE_ID=your_apple_service_id_or_bundle_id

### 3) Run (development)

npm run dev

### 4) Build & run (production)

npm run build
npm start

## API

### Base URL

Local: http://localhost:5000

Routes are mounted under /api and /api/admin

### Authentication

Endpoints marked (Auth) require a JWT: Authorization: Bearer <token>

Admin endpoints require (Admin) (JWT must have isAdmin: true).

## Public / User API (/api)

### Auth & User

POST /api/register — Register user/guest (creates user and returns token)

POST /api/login — Standard login (returns token)

GET /api/users/me (Auth) — Current user profile

PATCH /api/users/me (Auth) — Update current user

DELETE /api/users/me (Auth) — Delete current user

### Kakao

POST /api/kakao/login — Kakao login using accessToken

GET /api/kakao/address — Kakao address search

GET /api/kakao/expand-address — Expand road address

POST /api/kakao/delete (Auth) — Delete Kakao-linked account

DELETE /api/kakao/delete (Auth) — Same delete endpoint (both methods supported)

### Apple

POST /api/auth/apple — Login with Apple identity token

### Booking / Data

GET /api/booking/initialize — Booking init data (subtypes/options/pricing/assets/timeslots)

POST /api/booking (Auth) — Create booking

GET /api/timeslots — Available time slots

GET /api/servicetypes — Service types list

GET /api/options — Options list

GET /api/pricing — Pricing list

GET /api/history (Auth) — Booking history for current user

GET /api/historydetail/:id (Auth) — Booking detail

### Admin API (/api/admin)

All routes below require (Auth + Admin).

GET /api/admin/bookings — List all bookings

POST /api/admin/bookings/filter — Filter bookings

GET /api/admin/bookings/:id — Booking detail

PATCH /api/admin/bookings/:id/status — Update booking status

DELETE /api/admin/bookings/:id — Delete booking

GET /api/admin/users — List users (admin view)

PATCH /api/admin/users/:id/role — Set/unset admin role

DELETE /api/admin/users/:id — Delete user by id

## Example Requests
Register
curl -X POST http://localhost:5000/api/register \
  -H "Content-Type: application/json" \
  -d '{
    "name":"Test User",
    "phone":"01012345678",
    "password":"pass1234"
  }'

Login
curl -X POST http://localhost:5000/api/login \
  -H "Content-Type: application/json" \
  -d '{
    "phone":"01012345678",
    "password":"pass1234"
  }'

Get current user (Auth)
curl http://localhost:5000/api/users/me \
  -H "Authorization: Bearer YOUR_JWT_HERE"

Create booking (Auth)
curl -X POST http://localhost:5000/api/booking \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_HERE" \
  -d '{
    "serviceType":"<ObjectId>",
    "subtype":"<ObjectId>",
    "reservationDate":"2025-12-27",
    "reservationTime":"14:00",
    "options":[{"option":"<ObjectId>","choice":"some_choice"}],
    "memo":"",
    "symptom":"",
    "totalPrice":100000
  }'

## Project Structure
src/
  config/        # MongoDB connection
  controllers/   # Route handlers (API + admin + booking + oauth)
  middleware/    # JWT auth & request logging
  models/        # Mongoose schemas
  routes/        # Express routers (/api, /api/admin)
  services/      # Kakao & Apple auth helpers
  utils/         # helpers (date formatting, userId generator)

## Known Issues / Notes

src/index.ts defines PORT but currently starts the server with app.listen(5000, ...).
If you want PORT to work, change it to:

app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server running on :${PORT}`));


Some collections (ServiceType/Subtype/Option/Pricing/Asset/TimeSlot) must exist for booking initialization endpoints to return meaningful data.

## Ownership & Attribution

This repository is maintained and owned by Truss.

Original development and upstream engineering work were authored by the same entity
under a separate engineering account. All rights, maintenance responsibilities,
and licensing remain with Truss.

