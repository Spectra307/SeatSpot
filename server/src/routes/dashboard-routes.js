import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRestaurantStaff } from '../middleware/authorize-restaurant-staff.js';
import { resolveRestaurantId } from '../services/restaurant-resolver.js';

export function createDashboardRouter({ dashboardService, restaurants, jwtSecret }) {
  const router = Router();
  router.use(authenticate(jwtSecret));
  router.use('/:restaurantId/dashboard', authorizeRestaurantStaff);

  router.get('/:restaurantId/dashboard/tables', async (request, response, next) => {
    try {
      const restaurantId = await resolveRestaurantId(restaurants, request.params.restaurantId);
      response.json({ tables: await dashboardService.getTableGrid(restaurantId) });
    } catch (error) { next(error); }
  });

  router.get('/:restaurantId/dashboard/queue', async (request, response, next) => {
    try {
      const restaurantId = await resolveRestaurantId(restaurants, request.params.restaurantId);
      response.json(await dashboardService.getQueue(restaurantId));
    } catch (error) { next(error); }
  });

  router.post('/:restaurantId/dashboard/tables/:tableId/walk-in', async (request, response, next) => {
    try {
      const restaurantId = await resolveRestaurantId(restaurants, request.params.restaurantId);
      const booking = await dashboardService.seatWalkIn({
        restaurantId,
        tableId: request.params.tableId,
        userId: request.body?.userId,
        partySize: request.body?.partySize,
        startsAt: request.body?.startsAt
      });
      response.status(201).json(booking);
    } catch (error) { next(error); }
  });

  router.post('/:restaurantId/dashboard/queue/handoff', async (request, response, next) => {
    try {
      const restaurantId = await resolveRestaurantId(restaurants, request.params.restaurantId);
      const result = await dashboardService.handoffNextCustomer({
        restaurantId,
        staffId: request.auth.sub,
        tableId: request.body?.tableId,
        partySize: request.body?.partySize,
        startsAt: request.body?.startsAt
      });
      if (!result) {
        response.status(404).json({ error: 'Queue is empty' });
        return;
      }
      response.json(result);
    } catch (error) { next(error); }
  });

  router.patch('/:restaurantId/dashboard/tables/:tableId/status', async (request, response, next) => {
    try {
      const restaurantId = await resolveRestaurantId(restaurants, request.params.restaurantId);
      const table = await dashboardService.overrideTableStatus({
        restaurantId,
        tableId: request.params.tableId,
        status: request.body?.status
      });
      response.json(table);
    } catch (error) { next(error); }
  });

  return router;
}