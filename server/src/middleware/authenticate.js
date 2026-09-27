import jwt from 'jsonwebtoken';

export function authenticate(jwtSecret) {
  return (request, response, next) => {
    const token = request.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return response.status(401).json({ error: 'Authentication is required' });
    try {
      request.auth = jwt.verify(token, jwtSecret);
      next();
    } catch {
      response.status(401).json({ error: 'Authentication token is invalid or expired' });
    }
  };
}
