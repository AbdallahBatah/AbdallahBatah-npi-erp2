/**
 * Single source of truth for the JWT secret. Read lazily (as a function) so it
 * is resolved at DI time — after ConfigModule has populated process.env from
 * .env — keeping the signing secret and the validation secret identical.
 *
 * There is deliberately NO fallback value: a missing or placeholder secret is
 * a boot failure in every environment, not just production.
 */
const PLACEHOLDER_PATTERN = /change-?me/i;
const MIN_LENGTH = 32;

export const JWT_SECRET = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < MIN_LENGTH || PLACEHOLDER_PATTERN.test(secret)) {
    throw new Error(
      `JWT_SECRET must be set to a random value of at least ${MIN_LENGTH} characters ` +
        '(generate one with: openssl rand -hex 32). Placeholder values are rejected.',
    );
  }
  return secret;
};

/** Boot-time guard called from main.ts — fails fast with a clear message. */
export const assertJwtSecret = (): void => {
  JWT_SECRET();
};
