import { Router } from 'express';

export function createAuthRouter(authService, { exposeOtp = false } = {}) {
  const router = Router();

  router.post('/signup', async (request, response, next) => {
    try {
      const { otp } = await authService.signup(request.body);
      response.status(201).json({
        message: 'Account created. Verify the OTP before signing in.',
        ...(exposeOtp ? { otp } : {})
      });
    } catch (error) { next(error); }
  });

  router.post('/request-otp', async (request, response, next) => {
    try {
      const { otp } = await authService.requestOtp(request.body ?? {});
      response.json({
        message: 'If the account can receive an OTP, a new code has been issued.',
        ...(exposeOtp && otp ? { otp } : {})
      });
    } catch (error) { next(error); }
  });

  router.post('/verify-otp', async (request, response, next) => {
    try { response.json({ token: await authService.verifyOtp(request.body) }); }
    catch (error) { next(error); }
  });

  router.post('/login', async (request, response, next) => {
    try { response.json({ token: await authService.login(request.body, request.ip) }); }
    catch (error) { next(error); }
  });
  return router;
}
