/**
 * The authenticated principal attached to every request by JwtStrategy.
 * `organizationId` is the tenant scope applied to every query in every service.
 */
export interface AuthUser {
  userId: string;
  organizationId: string;
  email: string;
  /** The role's id — what the approval matrix routes on (roleKey is display). */
  roleId: string;
  roleKey: string;
  permissions: string[];
  locale: 'AR' | 'EN';
}
