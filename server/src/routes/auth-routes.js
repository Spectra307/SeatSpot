import { Router } from 'express';

export function createAuthRouter(authService) {
  const router = Router();

  router.post('/signup', async (request, response, next) => {
    try {
      const result = await authService.signup(request.body) ?? {};
      if (result.emailDispatched === false) {
        response.status(201).json({
          emailDispatched: false,
          message: 'Account created but we could not send the verification email. Check server logs or try resending after cooldown.'
        });
      } else {
        response.status(201).json({
          emailDispatched: true,
          message: 'Account created. Check your email for the verification code.'
        });
      }
    } catch (error) { next(error); }
  });

  // Kept as /request-otp for backwards compatibility; also mounted as /resend-otp below.
  router.post('/request-otp', async (request, response, next) => {
    try {
      await authService.requestOtp(request.body ?? {});
      response.json({
        message: 'If the account can receive an OTP, a new code has been sent.'
      });
    } catch (error) {
      if (error?.status === 429) {
        const retryAfterSeconds = error.retryAfterSeconds ?? 60;
        if (error.headers?.['Retry-After']) {
          response.set('Retry-After', error.headers['Retry-After']);
        } else {
          response.set('Retry-After', String(retryAfterSeconds));
        }
        return response.status(429).json({
          error: error.message,
          code: error.code,
          retryAfterSeconds
        });
      }
      return next(error);
    }
  });

  // Canonical resend endpoint with 60-second cooldown and hourly cap.
  router.post('/resend-otp', async (request, response, next) => {
    try {
      await authService.requestOtp(request.body ?? {});
      response.json({
        message: 'If the account can receive an OTP, a new code has been sent.'
      });
    } catch (error) {
      if (error?.status === 429) {
        const retryAfterSeconds = error.retryAfterSeconds ?? 60;
        if (error.headers?.['Retry-After']) {
          response.set('Retry-After', error.headers['Retry-After']);
        } else {
          response.set('Retry-After', String(retryAfterSeconds));
        }
        return response.status(429).json({
          error: error.message,
          code: error.code,
          retryAfterSeconds
        });
      }
      return next(error);
    }
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
