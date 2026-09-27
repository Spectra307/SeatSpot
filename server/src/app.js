import express from 'express';
import { databaseStatus } from './config/database.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/health', (_request, response) => {
    const database = databaseStatus();
    response.status(database === 'connected' ? 200 : 503).json({
      status: database === 'connected' ? 'ok' : 'degraded',
      database
    });
  });

  return app;
}
