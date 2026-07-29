/**
 * The authenticated principal attached to every request by JwtStrategy.
 * `organizationId` is the tenant scope applied to every query in every service.
 */
export interface AuthUser {
  userId: string;
  organizationId: string;
  email: string;
  roleKey: string;
  permissions: string[];
  locale: 'AR' | 'EN';
}
