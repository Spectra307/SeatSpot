import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { resolveRestaurantId } from '../services/restaurant-resolver.js';

export function createQueueRouter({ queueService, restaurants, jwtSecret }) {
  const router = Router();
  router.use(authenticate(jwtSecret));

  router.post('/:restaurantId/queue', async (request, response, next) => {
    try {
      const restaurantId = await resolveRestaurantId(restaurants, request.params.restaurantId);
      const result = await queueService.joinQueue({
        restaurantId: restaurantId.toString(),
        userId: request.auth.sub
      });
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:restaurantId/queue/position', async (request, response, next) => {
    try {
      const restaurantId = await resolveRestaurantId(restaurants, request.params.restaurantId);
      const position = await queueService.getQueuePosition({
        restaurantId: restaurantId.toString(),
        userId: request.auth.sub
      });
      response.json({ restaurantId: restaurantId.toString(), userId: request.auth.sub, position });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:restaurantId/queue', async (request, response, next) => {
    try {
      const restaurantId = await resolveRestaurantId(restaurants, request.params.restaurantId);
      const result = await queueService.leaveQueue({
        restaurantId: restaurantId.toString(),
        userId: request.auth.sub
      });
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}