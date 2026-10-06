# SeatSpot

SeatSpot is a real-time restaurant table availability, booking, and queue-management platform. It lets customers see live seat availability at nearby restaurants, book a table or join a virtual queue in one tap, and lets restaurant staff manage tables and walk-ins from a live dashboard — with no two customers ever assigned the same table.

---

## 1. Project Overview

Finding a restaurant with immediate seating is a common everyday problem: customers travel to a location only to discover it's full, wasting time and creating a frustrating dining experience. On the restaurant side, staff manage tables and walk-in queues manually — paper lists, verbal estimates — which leads to human error and occasional double allocation of the same table to two different parties.

SeatSpot closes this gap with a MERN-stack platform (MongoDB, Express, React, Node.js) where:

- **Customers** search nearby restaurants, view live table availability, and either book a table or join a virtual queue directly from their device.
- **Restaurant staff** get a live dashboard to manage tables, seat walk-ins, and update availability instantly.
- **Real-time synchronization** is achieved through Socket.IO, secured with JWT-verified handshakes and dual-layer rate limiting.
- **Table allocation** is handled through an atomic MongoDB transaction, so no two customers can ever be assigned the same table — even under concurrent load.

### Core goals

| Goal | How it's achieved |
|---|---|
| Real-time availability | Live Socket.IO push to subscribed clients per restaurant |
| Instant booking & queue join | Single-request booking/queue endpoints, no multi-step flow |
| Zero double-booking | Atomic DB-level reservation, proven under concurrent load |
| Restaurant dashboard | Staff-only live table grid, walk-in seating, queue view |
| Secure & scalable | JWT auth, Redis-backed rate limiting, shard-ready data model |

---

## 2. System Architecture

```
                    ┌──────────────────────┐        ┌──────────────────────────┐
                    │  Customer (Web)       │        │  Restaurant Staff (Web)   │
                    │  search / view / book  │        │  dashboard / seat / queue │
                    └──────────┬────────────┘        └──────────┬───────────────┘
                               │ HTTPS (REST)                    │ HTTPS (REST)
                               └───────────────┬──────────────────┘
                                                ▼
                                   ┌─────────────────────────┐
                                   │     React Frontend        │
                                   │ Customer UI · Staff UI ·   │
                                   │ Auth · Realtime (Socket.IO)│
                                   └─────────────┬─────────────┘
                                                  │ REST + WebSocket
                                                  ▼
                                   ┌─────────────────────────┐
                                   │   Node / Express Server   │
                                   │      (Business Logic)      │
                                   └───┬─────┬─────┬─────┬─────┘
                       ┌───────────────┘     │     │     └───────────────┐
                       ▼                     ▼     ▼                     ▼
               ┌───────────────┐   ┌──────────────┐ ┌──────────────┐ ┌───────────────┐
               │ Auth Service   │   │ Restaurant    │ │ Booking       │ │ Queue Service │
               │ OTP + JWT       │   │ Service       │ │ Service       │ │ (Redis list)  │
               └───────┬────────┘   │ search/avail. │ │ atomic reserve│ └───────┬───────┘
                       │            └──────┬───────┘ └──────┬────────┘         │
                       │                   │                │                  │
                       ▼                   ▼                ▼                  ▼
               ┌────────────────────────────────────────────────────────────────┐
               │   Redis (OTP + TTL, rate limiting, queue lists, login lockout)   │
               ├────────────────────────────────────────────────────────────────┤
               │   MongoDB — replica set (required for multi-document ACID        │
               │   transactions); shard-ready by restaurantId. Collections:       │
               │   Users, Restaurants, Tables, Bookings, QueueEntry.              │
               └────────────────────────────────────────────────────────────────┘
```

Socket.IO connects directly to the Node/Express server alongside the REST API — there is no separate gateway layer. JWT is verified at the handshake; room membership (`staff:{restaurantId}`, `user:{userId}`, `availability:{restaurantId}`) is derived server-side from the verified token, never from client-supplied input.

**Deliberate architectural decisions:**

- **Shard-ready by `restaurantId`** — nearly every query is restaurant-scoped, so every domain collection carries `restaurantId` and a compound `{ restaurantId, _id }` index, and `server/scripts/shard-collections.js` provides the `shardCollection` commands for a sharded cluster. This keeps a restaurant's tables, bookings, and queue data co-located for low-latency reads/writes and keeps per-tenant write load independent. Local development runs a single replica set (needed for transactions), not a sharded cluster.
- **Redis** backs anything that needs to be fast and short-lived: OTP codes (TTL-keyed), rate-limit counters, login-lockout counters, and the queue list itself — Redis *is* the source of truth for live queue state, not a cache in front of Mongo. A `QueueEntry` collection exists in MongoDB for durable queue history, but live ordering lives in Redis.
- **Socket.IO** authenticates and rate-limits at the handshake and event level itself, since a persistent connection doesn't fit a stateless per-request model.
- **Table reservation uses MongoDB multi-document transactions**, not a single atomic update. An earlier design used a single `findOneAndUpdate` with no transaction wrapping the follow-up booking-record write; that left a documented gap where a booking-record failure after a successful reservation could strand a table in `RESERVED` with no corresponding booking. The transactional version wraps the reservation and the booking creation in one `session.withTransaction`, so any failure rolls back the table status automatically.

---

## 3. Core Algorithms & Underlying Concepts

### 3.1 Atomic table reservation (race-condition prevention)

Booking uses a **conditional atomic update** rather than a read-then-write pattern:

```js
Tables.findOneAndUpdate(
  { _id: tableId, restaurantId, status: 'available' },
  { $set: { status: 'reserved' } },
  { new: true, session }
)
```

This is a single, indivisible database operation: MongoDB guarantees that if two requests race for the same document, exactly one `findOneAndUpdate` succeeds (returns the updated document) and the other returns `null` (the filter no longer matches once the first write lands). This removes the "check-then-act" race condition inherent to `read → compare → write` logic under concurrency, without needing an application-level lock.

The update runs inside a MongoDB **multi-document ACID transaction** (`session.withTransaction`) together with a pre-check that the user has no active booking and the insert of the booking record. The transaction provides atomicity across the writes: either both the table-status flip and the booking record commit, or neither does. A partial unique index on `{ restaurantId, userId }` for `status: 'confirmed'` bookings is a second line of defence — even if two requests slipped past the check, the duplicate-key error maps to the same `409`. Transactions require MongoDB to run as a replica set, since they are not supported on a standalone instance.

**Correctness property proven under test:** with *N* concurrent requests against one table, exactly 1 succeeds and *N−1* receive a 409 conflict — verified with a 20-way concurrent request test (and a two-way concurrent HTTP request test).

### 3.2 Queue as an ordered structure

The queue is modeled conceptually as a FIFO (first-in-first-out) ordered list per restaurant, persisted as a **Redis list**. Redis list operations (`RPUSH`/`LPOS`/`LLEN`/`LREM`) give O(1) push-to-back and position lookup, which is acceptable since per-restaurant queue lengths are small in practice. Joining is done in a **single Lua script** (`LPOS` then `RPUSH`) so the "already in queue?" check and the append cannot interleave. Using Redis instead of Mongo for this structure avoids document-rewrite overhead on every position change and matches the actual access pattern (frequent short-lived reads/writes, not durable long-term storage).

**Queue-to-table handoff** (seating the front-of-queue customer) cannot be a single atomic operation, because it spans two different data stores (Redis + MongoDB), which cannot share a transaction. A short-lived distributed lock (`SET NX PX`) serializes handoffs per restaurant, and the ordering rule enforced is:

1. Peek (not pop) the front of the Redis queue.
2. Skip and clean out queued users who already hold an active booking (covers the case where a previous attempt committed a booking but failed to remove the user).
3. Run the MongoDB transaction: reserve the table + create the booking.
4. Only after the transaction commits, remove that user from Redis (idempotent removal).

This is a variant of the **saga pattern** for maintaining consistency across two independent data stores without a shared transaction: do the durable, harder-to-reverse operation first (the Mongo transaction), then the easily-retryable cleanup (Redis removal) — so a crash between steps 3 and 4 leaves the system in a safely recoverable state rather than a corrupted one.

### 3.3 Rate limiting (fixed-window counters)

OTP verification attempts, OTP resend requests, login attempts, and API traffic all use the same pattern: a **Redis counter with a TTL**, implementing a fixed-window rate limiter.

- `INCR` a counter keyed by identity (email or IP) within a time window.
- If the counter exceeds a threshold before the TTL expires, reject with a lockout.
- The counter and the protected resource (e.g. the OTP itself) share the same TTL, so a stale counter can never outlive what it's protecting.

Concrete limits in the current implementation:

| Protection | Limit |
|---|---|
| OTP requests per email | 3 per 15 minutes (429) |
| OTP verification attempts per code | 5, then the code is invalidated |
| OTP lifetime | 300 seconds (configurable via `OTP_TTL_SECONDS`) |
| Login failures per email and per IP | 5 per 15 minutes → 60-second lockout |
| API requests per IP | 100 per minute |
| Socket connections per client | 5 per minute |
| Socket events per connection | 20 per minute, then disconnect |

**Why this matters mathematically:** a 6-digit OTP has a keyspace of 10⁶ (1,000,000) possible values. Without an attempt limit, an attacker has unbounded guesses within the OTP's validity window, making brute force trivial. Capping failed attempts at 5 reduces the success probability of a brute-force attack within one OTP lifetime to at most 5 / 1,000,000 = 0.0005%, assuming a uniformly random OTP.

### 3.4 Authorization as server-derived state, not client input

A recurring principle throughout the implementation: **never trust a client-supplied identifier for anything that grants access.** Concretely:

- Socket room membership (`staff:{restaurantId}`, `user:{userId}`) is computed from the verified JWT claims, never from a client-requested room name. Availability rooms are validated against the database before a join is allowed.
- HTTP route handlers read `userId` only from the token's `sub` claim; any `userId` present in the request body or query string is ignored.
- Staff actions are authorized by comparing the restaurant ID in the route against the restaurant ID in the staff member's token — a mismatch is rejected regardless of what the request claims.

This is the standard **authorization vs. authentication** distinction: authentication (JWT verification) proves *who* the caller is; authorization is a separate, explicit check of *what that caller may access*, and the two must never be conflated by assuming a verified token implies permission for whatever room/resource the token happens to mention in client-supplied data.

### 3.5 Sharding strategy

Collections are keyed with a compound `{ restaurantId, _id }` index to support **hash- or range-based sharding by `restaurantId`** in a MongoDB sharded cluster. Because nearly all application queries are already scoped to a single restaurant, this shard key keeps queries targeted at a single shard (avoiding scatter-gather queries across the cluster) and keeps a restaurant's full working set — its tables, bookings, and queue history — co-located for low-latency access. The `sh.shardCollection` commands are generated by `server/scripts/shard-collections.js`; enabling sharding is a deployment step, not required for local development.

---

## 4. Testing

The project uses Node's built-in test runner (`node --test`) with integration tests run against real MongoDB (replica set) and Redis instances via Docker Compose, rather than mocks, for anything involving transactions, concurrency, or Redis-specific behavior.

| Test file | Covers |
|---|---|
| `auth-service.test.js` | Signup, OTP verification, login, token issuance |
| `booking-service.test.js` | Reservation contract: 201/409/400 cases, transaction rollback on failure, over-capacity rejection, 20-way concurrency |
| `booking-queue-routes.test.js` | Full HTTP layer: auth binding (identity from token, not request body), tenant authorization, rate-limit integration |
| `booking-cancel.test.js` | Cancel-booking contract: owner 200, non-owner 404, wrong-state 409, concurrent-cancel 409, rollback on table-update failure, queue promotion |
| `queue-service.test.js` / `queue-service.integration.test.js` | Queue join/leave/position against real Redis; duplicate-join and empty-queue edge cases |
| `queue-handoff.integration.test.js` | Queue-to-table handoff: rollback on failure, concurrent handoff for the same user, no double-seating on retry |
| `socket-realtime.test.js` | JWT handshake verification, room authorization (cross-tenant join rejection), rate limiting, private-event isolation |
| `restaurant-routes.test.js` / `restaurant-service.nearby.test.js` | CRUD authorization, geo search, availability counts, distance/sort/filter logic |
| `http-rate-limit.test.js` | API-wide IP rate limiting (429 responses) |
| `end-to-end.test.js` | Full real-server flow: signup → search → book → live socket update; and queue-join → staff frees table → handoff → promotion event → persisted booking |
| `health.test.js` | Startup / readiness check |

**Key properties proven by tests, not just assumed:**
- Under 20 concurrent booking requests for one table, exactly 1 succeeds and 19 receive a 409.
- A forced failure after a table's status flips to `reserved` rolls back to `available` (proving transactional rollback, not just asserting the intended design).
- A socket authenticated for one restaurant cannot join another restaurant's private room.
- Spoofed `userId` values in a request body or query string never override the token-derived identity.
- A failing or hanging notification provider never blocks or fails the underlying booking/queue operation.

---

## 5. Deployment / Running Locally

### Prerequisites

- Node.js (v20+ recommended) and npm
- Docker (for the MongoDB replica set and Redis)

### Setup

1. Copy `.env.example` to `.env` in the repository root and set `JWT_SECRET` and `REDIS_PASSWORD`. The example `MONGO_URI` already points at the replica set started below.
2. Start MongoDB (as a replica set, required for transactions) and Redis:
   ```
   docker compose up -d
   ```
3. Install dependencies:
   ```
   npm.cmd install
   ```
4. Start the API:
   ```
   npm.cmd run dev
   ```
5. Run the test suite:
   ```
   npm.cmd test
   ```

Stop local infrastructure with `docker compose down`. MongoDB and Redis data persist in named Docker volumes across restarts.

The server waits for MongoDB and Redis to be reachable before listening. A healthy readiness check returns:

```json
{ "status": "ok", "database": "connected" }
```

### Seeding data

- **Demo data** (for local testing/review): set `DEMO_STAFF_PASSWORD` in `.env`, then run:
  ```
  npm.cmd run seed:demo --workspace=@seatspot/server
  ```
  This creates two restaurants with varied-capacity tables and one staff account per restaurant (`staff.harbor@seatspot.local`, `staff.garden@seatspot.local`).
- **Catalogue only** (no staff accounts): run `npm.cmd run seed --workspace=@seatspot/server`.
- **Staff provisioning** (controlled, non-public path): set `STAFF_NAME`, `STAFF_EMAIL`, `STAFF_PASSWORD`, and an existing `STAFF_RESTAURANT_ID`, then run:
  ```
  npm.cmd run seed:staff --workspace=@seatspot/server
  ```
  Public signup always creates a customer account regardless of any role or restaurant ID supplied in the request — staff accounts can only be created through this seed path, since no admin UI exists yet.

### Running the web client

1. Install workspace dependencies (if not already done): `npm.cmd install`
2. Start the API: `npm.cmd run dev`
3. In a second terminal, start the client: `npm.cmd run dev --workspace=@seatspot/client`
4. Open the URL Vite prints (typically `http://localhost:5173`). The dev server proxies `/api` and `/socket.io` to the API on port 4000.

The restaurant directory offers a search radius, closest-first or most-tables-open sorting, and an open-tables-only filter. It subscribes to the `availability:{restaurantId}` socket rooms for the listed restaurants, so table counts and the header indicator update without a refresh.

### API surface summary

- `POST /api/auth/signup`, `/request-otp`, `/verify-otp`, `/login` — account creation and authentication
- `GET /api/restaurants/nearby` — geo discovery with `radiusMeters`, `sort`, `openOnly`, `limit`
- `GET /api/restaurants/:restaurantId`, `/availability`, `/tables` — discovery (authenticated)
- `PATCH /api/restaurants/:restaurantId` — staff-only, same-restaurant only
- `POST /api/restaurants/:restaurantId/bookings` — book a table
- `PATCH /api/bookings/:id/cancel` — customer cancels a confirmed booking; releases the table in the same transaction and promotes the queue head
- `POST | GET /position | DELETE /api/restaurants/:restaurantId/queue` — join, check position, leave
- `GET|POST|PATCH /api/restaurants/:restaurantId/dashboard/...` — staff table grid, queue view, walk-in seating, queue handoff, table-status override (staff-only, same-restaurant only)
- Socket.IO rooms — `availability:{restaurantId}` (validated public), `staff:{restaurantId}` and `user:{userId}` (private, server-assigned)

### Known scope limitations

Restaurant creation/deletion and a general admin role are intentionally disabled, since no admin provisioning workflow exists yet. Notifications currently log rather than send real email (the interface is in place; a provider can be plugged in without changing calling code). These are documented limitations, not oversights.
