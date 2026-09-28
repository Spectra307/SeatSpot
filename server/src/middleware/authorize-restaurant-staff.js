export function authorizeRestaurantStaff(request, response, next) {
  const tokenRestaurantId = String(request.auth?.restaurantId ?? '').toLowerCase();
  const routeRestaurantId = String(request.params.restaurantId ?? '').toLowerCase();

  if (request.auth?.role !== 'staff' || !tokenRestaurantId || tokenRestaurantId !== routeRestaurantId) {
    return response.status(403).json({ error: 'Staff access to this restaurant is required' });
  }

  next();
}