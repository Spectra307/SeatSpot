import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRestaurantStaff } from '../middleware/authorize-restaurant-staff.js';

export function createRestaurantRouter(restaurantService, jwtSecret) {
  const router = Router();
  router.use(authenticate(jwtSecret));

  router.get('/nearby', async (request, response, next) => {
    try { response.json({ restaurants: await restaurantService.nearby(request.query) }); }
    catch (error) { next(error); }
  });
  router.post('/', (_request, response) => {
    response.status(403).json({ error: 'Restaurant creation is disabled until an admin provisioning path is configured' });
  });
  router.get('/:restaurantId/availability', async (request, response, next) => {
    try { response.json(await restaurantService.availability(request.params.restaurantId)); }
    catch (error) { next(error); }
  });
  router.get('/:restaurantId', async (request, response, next) => {
    try { response.json(await restaurantService.get(request.params.restaurantId)); }
    catch (error) { next(error); }
  });
  router.patch('/:restaurantId', authorizeRestaurantStaff, async (request, response, next) => {
    try { response.json(await restaurantService.update(request.params.restaurantId, request.body)); }
    catch (error) { next(error); }
  });
  router.delete('/:restaurantId', authorizeRestaurantStaff, (_request, response) => {
    response.status(403).json({ error: 'Restaurant deletion is disabled until an admin provisioning path is configured' });
  });
  return router;
}
