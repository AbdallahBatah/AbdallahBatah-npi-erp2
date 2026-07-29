import { BadRequestException, HttpStatus } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@npi/db';
import { GlobalExceptionFilter } from './global-exception.filter';

const capture = () => {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ArgumentsHost;
  return { res, host };
};

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('internal detail: constraint xyz', {
    code,
    clientVersion: 'test',
  });

describe('GlobalExceptionFilter', () => {
  const filter = new GlobalExceptionFilter();

  it('passes HttpExceptions through untouched (message strings are a client contract)', () => {
    const { res, host } = capture();
    filter.catch(new BadRequestException('Milestone must be VERIFIED before invoicing'), host);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Milestone must be VERIFIED');
  });

  it('maps P2002 (unique violation) to 409 without leaking constraint internals', () => {
    const { res, host } = capture();
    filter.catch(prismaError('P2002'), host);
    expect(res.statusCode).toBe(HttpStatus.CONFLICT);
    expect(JSON.stringify(res.body)).not.toContain('constraint xyz');
    expect((res.body as { code: string }).code).toBe('DUPLICATE');
  });

  it('maps P2025 (not found) to 404', () => {
    const { res, host } = capture();
    filter.catch(prismaError('P2025'), host);
    expect(res.statusCode).toBe(HttpStatus.NOT_FOUND);
  });

  it('maps P2003 (FK violation) to 409', () => {
    const { res, host } = capture();
    filter.catch(prismaError('P2003'), host);
    expect(res.statusCode).toBe(HttpStatus.CONFLICT);
  });

  it('unknown errors become an opaque 500 (no stack, no message leak)', () => {
    const { res, host } = capture();
    filter.catch(new Error('secret internal state'), host);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret internal state');
  });
});
