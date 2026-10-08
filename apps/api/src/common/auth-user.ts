/**
 * The authenticated principal attached to every request by JwtStrategy.
 * `organizationId` is the tenant scope applied to every query in every service.
 */
export interface AuthUser {
  userId: string;
  organizationId: string;
  email: string;
  /** The PRIMARY role's id (roleKey is display). Kept for display and for
   *  `assigneeRoleId` stamps — authorization uses `roleIds` / `permissions`. */
  roleId: string;
  roleKey: string;
  /** Every role the user holds: the primary first, then the extra roles. This
   *  is what the approval matrix routes on. */
  roleIds: string[];
  /** Union of the permissions of ALL the user's roles — sorted, no duplicates. */
  permissions: string[];
  locale: 'AR' | 'EN';
}
