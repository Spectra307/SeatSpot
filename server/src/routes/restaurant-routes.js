import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';

export function createRestaurantRouter(restaurantService, jwtSecret) {
  const router = Router();
  router.use(authenticate(jwtSecret));

  router.get('/nearby', async (request, response, next) => {
    try { response.json({ restaurants: await restaurantService.nearby(request.query) }); }
    catch (error) { next(error); }
  });
  router.post('/', async (request, response, next) => {
    try { response.status(201).json(await restaurantService.create(request.body)); }
    catch (error) { next(error); }
  });
  router.get('/:restaurantId/availability', async (request, response, next) => {
    try { response.json(await restaurantService.availability(request.params.restaurantId)); }
    catch (error) { next(error); }
  });
  router.get('/:restaurantId', async (request, response, next) => {
    try { response.json(await restaurantService.get(request.params.restaurantId)); }
    catch (error) { next(error); }
  });
  router.patch('/:restaurantId', async (request, response, next) => {
    try { response.json(await restaurantService.update(request.params.restaurantId, request.body)); }
    catch (error) { next(error); }
  });
  router.delete('/:restaurantId', async (request, response, next) => {
    try { await restaurantService.remove(request.params.restaurantId); response.status(204).end(); }
    catch (error) { next(error); }
  });
  return router;
}
