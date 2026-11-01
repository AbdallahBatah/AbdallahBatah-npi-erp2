/**
 * Package 4 · P4-3 / Package 5 · P5-4 — moving stock between a store and a
 * project's site location, inside the caller's transaction, for an doc
 * voucher (store → site) or a material return (site → store). Re-checks the
 * source at the moment of moving, so nothing is half-moved.
 */
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@npi/db';
import type { AuthUser } from '../../common/auth-user';

type Tx = Prisma.TransactionClient;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

export async function moveBulk(
  tx: Tx,
  user: AuthUser,
  doc: { id: string; code: string; fromLocationId: string; toLocationId: string },
  l: { itemId: string; qty: Prisma.Decimal },
  sourceType: 'MaterialIssue' | 'MaterialReturn',
) {
  const level = await tx.stockLevel.findFirst({
    where: { organizationId: user.organizationId, itemId: l.itemId, locationId: doc.fromLocationId },
  });
  if (!level || D(level.qty).lt(l.qty)) {
    throw new ConflictException(`Not enough stock left at the source to move ${doc.code} — ask the warehouse`);
  }
  await tx.stockLevel.update({ where: { id: level.id }, data: { qty: { decrement: l.qty } } });
  await tx.stockLevel.upsert({
    where: {
      organizationId_itemId_locationId: {
        organizationId: user.organizationId,
        itemId: l.itemId,
        locationId: doc.toLocationId,
      },
    },
    update: { qty: { increment: l.qty } },
    create: { organizationId: user.organizationId, itemId: l.itemId, locationId: doc.toLocationId, qty: l.qty },
  });
  await tx.stockMovement.create({
    data: {
      organizationId: user.organizationId,
      itemId: l.itemId,
      fromLocationId: doc.fromLocationId,
      toLocationId: doc.toLocationId,
      qty: l.qty,
      movementType: 'TRANSFER',
      sourceType,
      sourceId: doc.id,
    },
  });
}

export async function moveSerials(
  tx: Tx,
  user: AuthUser,
  doc: { id: string; code: string; fromLocationId: string; toLocationId: string },
  l: { itemId: string; serialUnitIds: string[] },
  sourceType: 'MaterialIssue' | 'MaterialReturn',
) {
  const units = await tx.serialUnit.findMany({
    where: {
      id: { in: l.serialUnitIds },
      organizationId: user.organizationId,
      locationId: doc.fromLocationId,
      currentState: 'IN_STOCK',
    },
    select: { id: true },
  });
  if (units.length !== l.serialUnitIds.length) {
    throw new ConflictException(`A unit on ${doc.code} is no longer at the source location`);
  }
  const project = await tx.location.findUniqueOrThrow({ where: { id: doc.toLocationId }, select: { projectId: true } });
  await tx.serialUnit.updateMany({
    where: { id: { in: l.serialUnitIds } },
    data: { locationId: doc.toLocationId, ...(project.projectId ? { projectId: project.projectId } : {}) },
  });
  await tx.stockMovement.createMany({
    data: l.serialUnitIds.map((serialUnitId) => ({
      organizationId: user.organizationId,
      itemId: l.itemId,
      serialUnitId,
      fromLocationId: doc.fromLocationId,
      toLocationId: doc.toLocationId,
      qty: 1,
      movementType: 'TRANSFER',
      sourceType,
      sourceId: doc.id,
    })),
  });
}
