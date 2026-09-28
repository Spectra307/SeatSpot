# SeatSpot

SeatSpot is a real-time restaurant table availability, booking, and queue-management platform.

## Milestone 0

The repository uses npm workspaces with a `client` boundary and an Express/MongoDB server.
Every MongoDB domain schema includes `restaurantId` and a `{ restaurantId, _id }` compound index to support the planned shard key. The sharding commands are provided in `server/scripts/shard-collections.js` for a MongoDB sharded deployment.

## Run

1. Copy `.env.example` to `.env` in the repository root and set `JWT_SECRET` and `REDIS_PASSWORD`.
2. Start MongoDB replica set and Redis with `docker compose up -d`.
3. Install dependencies with `npm.cmd install`.
4. Start the API with `npm.cmd run dev`.
5. Run the test suite with `npm.cmd test`.

Stop the local infrastructure with `docker compose down`. Persistent MongoDB and Redis data is stored in named Docker volumes and remains after stopping the services.

The server waits for MongoDB and Redis before it listens. A successful health response is:

```json
{ "status": "ok", "database": "connected" }
```

## Auth API

`POST /api/auth/signup` accepts `name`, `email`, and an 8-character minimum `password`.
It stores a six-digit OTP in Redis under `otp:<email>` with the configured TTL. In development the signup response includes the OTP for local testing; production responses never expose it. Submit it to `POST /api/auth/verify-otp` to receive a JWT. `POST /api/auth/login` issues a JWT for verified accounts.

## Restaurant API

Run `npm.cmd run seed --workspace=@seatspot/server` to add the local catalogue. All restaurant endpoints require `Authorization: Bearer <JWT>`. The API supports CRUD at `/api/restaurants`, live table counts at `GET /api/restaurants/:restaurantId/availability`, and nearby search at `GET /api/restaurants/nearby?latitude=12.9255&longitude=80.2201&radiusMeters=5000`. When `GOOGLE_MAPS_API_KEY` is configured, a search with no local matches queries Google Places Nearby Search.

Restaurant search, get, and availability reads are available to authenticated users. Restaurant updates require staff credentials for that same restaurant. Restaurant creation and deletion are disabled until an admin provisioning workflow is added.

Public signup always creates a customer in the configured consumer partition; it ignores requested roles and restaurant IDs. To provision staff, set `STAFF_NAME`, `STAFF_EMAIL`, `STAFF_PASSWORD`, and an existing `STAFF_RESTAURANT_ID` in the operator environment, then run `npm.cmd run seed:staff --workspace=@seatspot/server`. Staff login includes that restaurant ID in the login request; the issued role and restaurant ID come from the stored staff account, not the request.

For a local demo, set `DEMO_STAFF_PASSWORD` in `.env` and run `npm.cmd run seed:demo --workspace=@seatspot/server`. This creates two restaurants, varied-capacity tables, and one staff account per restaurant (`staff.harbor@seatspot.local` and `staff.garden@seatspot.local`).
