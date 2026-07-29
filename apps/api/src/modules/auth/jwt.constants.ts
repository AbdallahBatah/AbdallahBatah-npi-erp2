/**
 * Single source of truth for the JWT secret. Read lazily (as a function) so it
 * is resolved at DI time — after ConfigModule has populated process.env from
 * .env — keeping the signing secret and the validation secret identical.
 */
export const JWT_SECRET = (): string =>
  process.env.JWT_SECRET ?? 'change-me-in-production';
