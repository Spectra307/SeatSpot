import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';

function createError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export class SocketRealtimeService {
  constructor({ jwtSecret, connectionLimitPerMinute = 5, eventLimitPerMinute = 20, maxEventHistory = 50 }) {
    this.jwtSecret = jwtSecret;
    this.connectionLimitPerMinute = connectionLimitPerMinute;
    this.eventLimitPerMinute = eventLimitPerMinute;
    this.maxEventHistory = maxEventHistory;
    this.io = null;
    this.connectionBuckets = new Map();
    this.socketState = new Map();
    this.eventBuckets = new Map();
  }

  attach(server, options = {}) {
    const io = new Server(server, {
      cors: { origin: options.corsOrigin ?? '*' },
      transports: ['websocket', 'polling']
    });

    this.io = io;

    io.use((socket, next) => {
      const authHeader = socket.handshake.headers?.authorization ?? socket.handshake.auth?.token;
      const token = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '') : authHeader;

      if (!token) {
        return next(createError('Authentication token is required', 401));
      }

      try {
        const decoded = jwt.verify(token, this.jwtSecret);
        socket.data.user = decoded;
        socket.data.restaurantId = decoded.restaurantId ?? decoded.sub;

        const now = Date.now();
        const bucket = this.connectionBuckets.get(socket.data.restaurantId) ?? [];
        const recent = bucket.filter((timestamp) => now - timestamp < 60000);
        if (recent.length >= this.connectionLimitPerMinute) {
          return next(createError('Connection rate limit exceeded', 429));
        }
        recent.push(now);
        this.connectionBuckets.set(socket.data.restaurantId, recent);

        this.socketState.set(socket.id, {
          restaurantId: socket.data.restaurantId,
          userId: decoded.sub,
          eventWindow: []
        });

        return next();
      } catch (error) {
        if (error?.name === 'TokenExpiredError' || error?.name === 'JsonWebTokenError' || error?.name === 'NotBeforeError') {
          return next(createError('Authentication token is invalid or expired', 401));
        }

        return next(createError(error.message || 'Authentication token is invalid or expired', 401));
      }
    });

    io.on('connection', (socket) => {
      const joinRestaurant = (restaurantId) => {
        const state = this.socketState.get(socket.id);
        const normalizedRestaurantId = restaurantId ?? socket.data.restaurantId ?? state?.restaurantId;

        if (!normalizedRestaurantId) return;

        if (state) {
          state.restaurantId = normalizedRestaurantId;
        } else {
          this.socketState.set(socket.id, {
            restaurantId: normalizedRestaurantId,
            userId: socket.data.user?.sub,
            eventWindow: []
          });
        }

        socket.join(normalizedRestaurantId);
        socket.emit('joined-restaurant', { restaurantId: normalizedRestaurantId });
      };

      if (socket.data.restaurantId) {
        joinRestaurant(socket.data.restaurantId);
      }

      socket.on('join-restaurant', joinRestaurant);

      socket.on('availability:update', (payload) => {
        const state = this.socketState.get(socket.id);
        if (!state) return;

        const now = Date.now();
        const key = `${state.restaurantId}:${socket.id}`;
        const bucket = this.eventBuckets.get(key) ?? [];
        const recent = bucket.filter((timestamp) => now - timestamp < 60000);

        if (recent.length >= this.eventLimitPerMinute) {
          socket.emit('rate-limit', { event: 'availability:update', retryAfterMs: 60000 });
          socket.disconnect(true);
          return;
        }

        recent.push(now);
        this.eventBuckets.set(key, recent);

        const event = {
          restaurantId: state.restaurantId,
          type: 'availability:update',
          payload: payload ?? {}
        };

        socket.to(state.restaurantId).emit('availability:update', event);
      });

      socket.on('queue:update', (payload) => {
        const state = this.socketState.get(socket.id);
        if (!state) return;

        const now = Date.now();
        const key = `${state.restaurantId}:${socket.id}`;
        const bucket = this.eventBuckets.get(key) ?? [];
        const recent = bucket.filter((timestamp) => now - timestamp < 60000);

        if (recent.length >= this.eventLimitPerMinute) {
          socket.emit('rate-limit', { event: 'queue:update', retryAfterMs: 60000 });
          socket.disconnect(true);
          return;
        }

        recent.push(now);
        this.eventBuckets.set(key, recent);

        const event = {
          restaurantId: state.restaurantId,
          type: 'queue:update',
          payload: payload ?? {}
        };

        socket.to(state.restaurantId).emit('queue:update', event);
      });

      socket.on('disconnect', (reason) => {
        const state = this.socketState.get(socket.id);
        if (!state) return;

        const key = `${state.restaurantId}:${socket.id}`;
        this.eventBuckets.delete(key);
        this.socketState.delete(socket.id);

        if (state.restaurantId) {
          socket.leave(state.restaurantId);
        }

        if (reason === 'client namespace disconnect') {
          socket.leave(state.restaurantId);
        }
      });
    });

    return io;
  }

  broadcastAvailability(restaurantId, payload) {
    const io = this.io;
    if (!io) return;
    if (!restaurantId) return;
    const room = io.of('/').adapter.rooms.get(restaurantId);
    if (!room || room.size === 0) return;
    io.to(restaurantId).emit('availability:update', { restaurantId, payload });
  }

  broadcastQueueUpdate(restaurantId, payload) {
    const io = this.io;
    if (!io) return;
    if (!restaurantId) return;
    const room = io.of('/').adapter.rooms.get(restaurantId);
    if (!room || room.size === 0) return;
    io.to(restaurantId).emit('queue:update', { restaurantId, payload });
  }
}
