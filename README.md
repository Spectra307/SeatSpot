# SeatSpot

SeatSpot is a real-time restaurant table availability, booking, and queue-management platform.

## Milestone 0

The repository uses npm workspaces with a `client` boundary and an Express/MongoDB server.
Every MongoDB domain schema includes `restaurantId` and a `{ restaurantId, _id }` compound index to support the planned shard key. The sharding commands are provided in `server/scripts/shard-collections.js` for a MongoDB sharded deployment.

## Run

1. Copy `.env.example` to `.env` in the repository root and set `MONGODB_URI` for a reachable MongoDB instance. The server workspace reads this root file.
2. Install dependencies with `npm.cmd install`.
3. Start the API with `npm.cmd run dev`.
4. Request `GET http://localhost:4000/health`.

The server waits for MongoDB and Redis before it listens. A successful health response is:

```json
{ "status": "ok", "database": "connected" }
```

## Auth API

`POST /api/auth/signup` accepts `name`, `email`, and an 8-character minimum `password`.
It stores a six-digit OTP in Redis under `otp:<email>` with the configured TTL. In development the signup response includes the OTP for local testing; production responses never expose it. Submit it to `POST /api/auth/verify-otp` to receive a JWT. `POST /api/auth/login` issues a JWT for verified accounts.

## Restaurant API

Run `npm.cmd run seed --workspace=@seatspot/server` to add the local catalogue. All restaurant endpoints require `Authorization: Bearer <JWT>`. The API supports CRUD at `/api/restaurants`, live table counts at `GET /api/restaurants/:restaurantId/availability`, and nearby search at `GET /api/restaurants/nearby?latitude=12.9255&longitude=80.2201&radiusMeters=5000`. When `GOOGLE_MAPS_API_KEY` is configured, a search with no local matches queries Google Places Nearby Search.
