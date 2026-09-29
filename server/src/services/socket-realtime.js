import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

function createError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function availabilitySummary(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};

  const summary = {};
  for (const key of ['available', 'reserved', 'occupied', 'unavailable', 'total']) {
    if (Number.isInteger(payload[key]) && payload[key] >= 0) {
      summary[key] = payload[key];
    }
  }
  return summary;
}

export class SocketRealtimeService {
  constructor({ jwtSecret, restaurants, connectionLimitPerMinute = 5, eventLimitPerMinute = 20 }) {
    this.jwtSecret = jwtSecret;
    this.restaurants = restaurants;
    this.connectionLimitPerMinute = connectionLimitPerMinute;
    this.eventLimitPerMinute = eventLimitPerMinute;
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
        if (!decoded.sub || !decoded.role) {
          return next(createError('Authentication token is invalid or expired', 401));
        }

        const isStaff = decoded.role === 'staff';
        const restaurantId = isStaff ? String(decoded.restaurantId ?? '') : null;
        if (isStaff && !mongoose.isValidObjectId(restaurantId)) {
          return next(createError('Staff token must include a valid restaurantId', 401));
        }

        socket.data.user = decoded;
        socket.data.userId = String(decoded.sub);
        socket.data.role = decoded.role;
        socket.data.restaurantId = restaurantId;

        const principal = isStaff ? `staff:${restaurantId}` : `user:${socket.data.userId}`;
        const now = Date.now();
        const bucket = this.connectionBuckets.get(principal) ?? [];
        const recent = bucket.filter((timestamp) => now - timestamp < 60000);
        if (recent.length >= this.connectionLimitPerMinute) {
          return next(createError('Connection rate limit exceeded', 429));
        }
        recent.push(now);
        this.connectionBuckets.set(principal, recent);

        this.socketState.set(socket.id, {
          userId: socket.data.userId,
          role: socket.data.role,
          restaurantId,
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
      const state = this.socketState.get(socket.id);
      if (!state) {
        socket.disconnect(true);
        return;
      }

      if (state.role === 'staff') {
        socket.join(`staff:${state.restaurantId}`);
      } else {
        socket.join(`user:${state.userId}`);
      }

      socket.on('join-room', async (requestedRoom) => {
        if (typeof requestedRoom !== 'string') {
          this._rejectRoom(socket, requestedRoom);
          return;
        }

        if (state.role === 'staff') {
          const allowedRoom = `staff:${state.restaurantId}`;
          if (requestedRoom !== allowedRoom) {
            this._rejectRoom(socket, requestedRoom);
            return;
          }
          await socket.join(allowedRoom);
          socket.emit('room:joined', { room: allowedRoom });
          return;
        }

        const availabilityMatch = /^availability:([a-f\d]{24})$/i.exec(requestedRoom);
        if (!availabilityMatch || !this.restaurants) {
          this._rejectRoom(socket, requestedRoom);
          return;
        }

        const restaurantId = availabilityMatch[1];
        try {
          const restaurant = await this.restaurants.findOne({ restaurantId }).select('restaurantId').lean();
          if (!restaurant) {
            this._rejectRoom(socket, requestedRoom);
            return;
          }
          const validatedRestaurantId = restaurant.restaurantId.toString();
          await socket.join(`availability:${validatedRestaurantId}`);
          socket.emit('room:joined', { room: `availability:${validatedRestaurantId}` });
        } catch {
          this._rejectRoom(socket, requestedRoom);
        }
      });

      socket.on('availability:update', (payload) => {
        if (state.role !== 'staff') {
          this._rejectRoom(socket, 'availability:update');
          return;
        }
        if (!this._consumeEvent(socket, 'availability:update')) return;
        this.broadcastAvailability(state.restaurantId, payload);
      });

      socket.on('queue:update', (payload) => {
        if (state.role !== 'staff') {
          this._rejectRoom(socket, 'queue:update');
          return;
        }
        if (!this._consumeEvent(socket, 'queue:update')) return;
        this.broadcastQueueUpdate(state.restaurantId, payload);
      });

      socket.on('disconnect', () => {
        this.eventBuckets.delete(socket.id);
        this.socketState.delete(socket.id);
      });
    });

    return io;
  }

  _rejectRoom(socket, room) {
    socket.emit('room:error', { room, error: 'Room access is not authorized' });
  }

  _consumeEvent(socket, eventName) {
    const now = Date.now();
    const bucket = this.eventBuckets.get(socket.id) ?? [];
    const recent = bucket.filter((timestamp) => now - timestamp < 60000);

    if (recent.length >= this.eventLimitPerMinute) {
      socket.emit('rate-limit', { event: eventName, retryAfterMs: 60000 });
      socket.disconnect(true);
      return false;
    }

    recent.push(now);
    this.eventBuckets.set(socket.id, recent);
    return true;
  }

  broadcastAvailability(restaurantId, payload) {
    if (!this.io || !restaurantId) return;
    const event = {
      restaurantId: String(restaurantId),
      payload: availabilitySummary(payload)
    };
    this.io.to(`availability:${restaurantId}`).emit('availability:update', event);
    this.io.to(`staff:${restaurantId}`).emit('availability:update', event);
  }

  broadcastQueueUpdate(restaurantId, payload) {
    if (!this.io || !restaurantId) return;
    this.io.to(`staff:${restaurantId}`).emit('queue:update', { restaurantId: String(restaurantId), payload });
  }

  emitToUser(userId, eventName, payload) {
    if (!this.io || !userId || typeof eventName !== 'string') return;
    this.io.to(`user:${userId}`).emit(eventName, payload);
  }
}