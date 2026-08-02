import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { isValidSaudiVat, SAUDI_VAT_OR_EMPTY_RE } from '@npi/shared';
import { CreateVendorDto } from './dto';

/**
 * D-02 from the 2026-08-01 UAT round: a vendor was created with a 14-digit
 * VAT number, which would have flowed into e-invoice QR codes and input-VAT
 * matching unchallenged. ZATCA TINs are 15 digits starting and ending with 3.
 */
describe('Saudi VAT number validation', () => {
  it('accepts a well-formed 15-digit TIN', () => {
    expect(isValidSaudiVat('312345678901233')).toBe(true);
  });

  it.each([
    ['31234567890123', '14 digits — the exact UAT repro'],
    ['3123456789012334', '16 digits'],
    ['212345678901233', 'does not start with 3'],
    ['312345678901234', 'does not end with 3'],
    ['3123456789O1233', 'letter smuggled in'],
    ['', 'empty is not a valid TIN'],
  ])('rejects %s (%s)', (value) => {
    expect(isValidSaudiVat(value)).toBe(false);
  });

  it('the DTO variant additionally allows empty, so forms can clear the field', () => {
    expect(SAUDI_VAT_OR_EMPTY_RE.test('')).toBe(true);
    expect(SAUDI_VAT_OR_EMPTY_RE.test('31234567890123')).toBe(false);
  });

  // The regex alone proves nothing if the decorator is missing — validate the
  // actual DTO the endpoint uses.
  async function vendorErrors(vatNumber?: string) {
    const dto = plainToInstance(CreateVendorDto, {
      nameAr: 'شركة الأفق للتوريدات',
      nameEn: 'Horizon Supplies',
      ...(vatNumber === undefined ? {} : { vatNumber }),
    });
    return validate(dto);
  }

  it('CreateVendorDto refuses the 14-digit number that got through in UAT', async () => {
    const errors = await vendorErrors('31234567890123');
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('vatNumber');
  });

  it('CreateVendorDto accepts a valid TIN, an omitted one, and an empty one', async () => {
    expect(await vendorErrors('312345678901233')).toHaveLength(0);
    expect(await vendorErrors(undefined)).toHaveLength(0);
    expect(await vendorErrors('')).toHaveLength(0);
  });
});
