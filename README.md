# SeatSpot

SeatSpot is a real-time restaurant table availability, booking, and queue-management platform.

## Milestone 0

The repository uses npm workspaces with a `client` boundary and an Express/MongoDB server.
Every MongoDB domain schema includes `restaurantId` and a `{ restaurantId, _id }` compound index to support the planned shard key. The sharding commands are provided in `server/scripts/shard-collections.js` for a MongoDB sharded deployment.

## Run

1. Copy `.env.example` to `.env` and set `MONGODB_URI` for a reachable MongoDB instance.
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
