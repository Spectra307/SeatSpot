export class NotificationService {
  constructor({ provider, logger = console, timeoutMs = 250 } = {}) {
    this.provider = provider;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
  }

  async notifySafely(notification) {
    let timeout;
    const delivery = Promise.resolve().then(() => {
      if (this.provider) return this.provider.send(notification);
      this.logger.info('SeatSpot notification', {
        type: notification.type,
        userId: notification.userId,
        restaurantId: notification.restaurantId
      });
    });

    try {
      await Promise.race([
        delivery,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Notification delivery timed out')), this.timeoutMs);
        })
      ]);
    } catch (error) {
      try {
        this.logger.warn('SeatSpot notification delivery failed', error.message);
      } catch {
        return;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
