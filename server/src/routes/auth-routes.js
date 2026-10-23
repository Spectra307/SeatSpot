import { Router } from 'express';

export function createAuthRouter(authService) {
  const router = Router();

  router.post('/signup', async (request, response, next) => {
    try {
      await authService.signup(request.body);
      response.status(201).json({
        message: 'Account created. Check your email for the verification code.'
      });
    } catch (error) { next(error); }
  });

  // Kept as /request-otp for backwards compatibility; also mounted as /resend-otp below.
  router.post('/request-otp', async (request, response, next) => {
    try {
      await authService.requestOtp(request.body ?? {});
      response.json({
        message: 'If the account can receive an OTP, a new code has been sent.'
      });
    } catch (error) { next(error); }
  });

  // Canonical resend endpoint with 60-second cooldown and hourly cap.
  router.post('/resend-otp', async (request, response, next) => {
    try {
      await authService.requestOtp(request.body ?? {});
      response.json({
        message: 'If the account can receive an OTP, a new code has been sent.'
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
