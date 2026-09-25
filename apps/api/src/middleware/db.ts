import { createMiddleware } from 'hono/factory';
import { createDb } from '@halo/database';
import type { AppEnv } from '../types';

export const dbMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  c.set('db', createDb(c.env.HYPERDRIVE.connectionString));
  await next();
});
