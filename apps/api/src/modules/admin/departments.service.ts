import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import type { AuthUser } from '../../common/auth-user';
import type {
  CreateDepartmentDto,
  SetDepartmentMembersDto,
  UpdateDepartmentDto,
} from './structure.dto';

/** What the pickers on both admin screens need — never the password hash. */
export const DIRECTORY_SELECT = {
  id: true,
  nameAr: true,
  nameEn: true,
  email: true,
  isActive: true,
  departmentId: true,
  role: { select: { id: true, key: true, nameAr: true, nameEn: true } },
} as const;

const DEPARTMENT_INCLUDE = {
  manager: { select: { id: true, nameAr: true, nameEn: true, isActive: true } },
  parent: { select: { id: true, code: true, nameAr: true, nameEn: true } },
  _count: { select: { members: true, approvalRules: true, children: true } },
} as const;

/**
 * Departments — the organisational unit M4 added so that "مدير القسم" in the
 * approval matrix means something. The schema shipped in M4 with no HTTP
 * surface at all, so a department could only be created by hand in SQL.
 *
 * Two guards carry the weight here:
 *
 *  1. **The hierarchy must stay a tree.** A parent cycle is not a validation
 *     nicety — anything that walks the chain (a future "manager of my manager"
 *     escalation, a rollup report) hangs forever on one, and the row that
 *     caused it looks perfectly ordinary in the table.
 *  2. **Deactivation is the only removal.** A department is referenced by
 *     approval rules, requisitions and the requests already signed under it;
 *     deleting one would erase the answer to "which unit approved this".
 *     There is deliberately no delete endpoint.
 */
@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(user: AuthUser) {
    return this.prisma.department.findMany({
      where: { organizationId: user.organizationId },
      include: DEPARTMENT_INCLUDE,
      orderBy: [{ isActive: 'desc' }, { code: 'asc' }],
    });
  }

  /**
   * The people picker for the manager field and the membership dialog. Scoped
   * to the caller's own organization and gated by the same permission as the
   * screen it feeds — the user list under /admin/users needs admin.user.manage,
   * which a department administrator does not necessarily hold.
   */
  directory(user: AuthUser) {
    return this.prisma.user.findMany({
      where: { organizationId: user.organizationId },
      select: DIRECTORY_SELECT,
      orderBy: [{ isActive: 'desc' }, { nameAr: 'asc' }],
    });
  }

  async create(user: AuthUser, dto: CreateDepartmentDto) {
    const code = dto.code.trim().toUpperCase();
    const clash = await this.prisma.department.findUnique({
      where: { organizationId_code: { organizationId: user.organizationId, code } },
    });
    if (clash) throw new BadRequestException('Department code already in use');

    if (dto.parentId) await this.getOwned(user, dto.parentId);
    if (dto.managerId) await this.assertOwnedUser(user, dto.managerId);

    const nameAr = dto.nameAr.trim();
    const nameEn = (dto.nameEn ?? '').trim() || nameAr;

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.department.create({
        data: {
          organizationId: user.organizationId,
          code,
          nameAr,
          nameEn,
          parentId: dto.parentId ?? null,
          managerId: dto.managerId ?? null,
          isActive: dto.isActive ?? true,
        },
        include: DEPARTMENT_INCLUDE,
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Department',
          entityId: created.id,
          action: 'CREATE',
          after: {
            code,
            nameAr,
            nameEn,
            parentId: created.parentId,
            managerId: created.managerId,
            isActive: created.isActive,
          },
        },
        tx,
      );
      return created;
    });
  }

  async update(user: AuthUser, id: string, dto: UpdateDepartmentDto) {
    const dept = await this.getOwned(user, id);

    if (dto.parentId !== undefined && dto.parentId !== null) {
      if (dto.parentId === id) {
        throw new BadRequestException('A department cannot be its own parent');
      }
      await this.getOwned(user, dto.parentId);
      await this.assertNoCycle(user.organizationId, id, dto.parentId);
    }
    if (dto.managerId) await this.assertOwnedUser(user, dto.managerId);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.department.update({
        where: { id },
        data: {
          nameAr: dto.nameAr?.trim() || undefined,
          nameEn: dto.nameEn?.trim() || undefined,
          parentId: dto.parentId,
          managerId: dto.managerId,
          isActive: dto.isActive,
        },
        include: DEPARTMENT_INCLUDE,
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Department',
          entityId: id,
          action: 'UPDATE',
          before: {
            nameAr: dept.nameAr,
            nameEn: dept.nameEn,
            parentId: dept.parentId,
            managerId: dept.managerId,
            isActive: dept.isActive,
          },
          after: {
            nameAr: updated.nameAr,
            nameEn: updated.nameEn,
            parentId: updated.parentId,
            managerId: updated.managerId,
            isActive: updated.isActive,
          },
        },
        tx,
      );
      return updated;
    });
  }

  /**
   * Set the department's membership to exactly `userIds`. Anyone currently in
   * it and absent from the list is detached (departmentId → null) rather than
   * moved somewhere arbitrary; anyone in the list who sat in another
   * department is moved here, which is what "assign to this department" means.
   */
  async setMembers(user: AuthUser, id: string, dto: SetDepartmentMembersDto) {
    await this.getOwned(user, id);
    const ids = [...new Set(dto.userIds)];

    if (ids.length) {
      const owned = await this.prisma.user.count({
        where: { id: { in: ids }, organizationId: user.organizationId },
      });
      if (owned !== ids.length) throw new NotFoundException('User not found');
    }

    const before = await this.prisma.user.findMany({
      where: { organizationId: user.organizationId, departmentId: id },
      select: { id: true },
    });
    const beforeIds = before.map((u) => u.id);

    return this.prisma.$transaction(async (tx) => {
      // Scoped by organizationId on both writes: the id list is client-supplied
      // and must never be able to reach a row belonging to another tenant.
      await tx.user.updateMany({
        where: {
          organizationId: user.organizationId,
          departmentId: id,
          ...(ids.length ? { id: { notIn: ids } } : {}),
        },
        data: { departmentId: null },
      });
      if (ids.length) {
        await tx.user.updateMany({
          where: { organizationId: user.organizationId, id: { in: ids } },
          data: { departmentId: id },
        });
      }
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Department',
          entityId: id,
          action: 'SET_MEMBERS',
          before: { userIds: beforeIds },
          after: { userIds: ids },
        },
        tx,
      );
      return { ok: true, count: ids.length };
    });
  }

  // ── guards ────────────────────────────────────────────────────────────────

  private async getOwned(user: AuthUser, id: string) {
    const dept = await this.prisma.department.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!dept) throw new NotFoundException('Department not found');
    return dept;
  }

  private async assertOwnedUser(user: AuthUser, userId: string) {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: user.organizationId },
      select: { id: true, isActive: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (!target.isActive) {
      throw new BadRequestException('A deactivated user cannot manage a department');
    }
    return target;
  }

  /**
   * Walk up from the proposed parent: if `id` appears anywhere on the way to
   * the root, attaching it would close a loop. Bounded by the department count
   * so a pre-existing bad row cannot turn this guard itself into the hang.
   */
  private async assertNoCycle(organizationId: string, id: string, parentId: string) {
    const total = await this.prisma.department.count({ where: { organizationId } });
    let cursor: string | null = parentId;
    for (let hops = 0; cursor && hops <= total; hops++) {
      if (cursor === id) {
        throw new BadRequestException(
          'That parent is below this department — the hierarchy would form a cycle',
        );
      }
      const row: { parentId: string | null } | null = await this.prisma.department.findFirst({
        where: { id: cursor, organizationId },
        select: { parentId: true },
      });
      cursor = row?.parentId ?? null;
    }
  }
}
