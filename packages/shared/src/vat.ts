/**
 * Saudi VAT registration number: exactly 15 digits, first and last are 3
 * (ZATCA TIN structure). A malformed number silently poisons everything
 * downstream — e-invoice QR codes, input-VAT matching, vendor statements —
 * so the format is refused at the door, in one place both apps read.
 */
export const SAUDI_VAT_RE = /^3\d{13}3$/;

/**
 * DTO/form variant: also accepts the empty string, because optional form
 * fields submit '' to clear a previously saved value.
 */
export const SAUDI_VAT_OR_EMPTY_RE = /^(3\d{13}3)?$/;

export function isValidSaudiVat(value: string): boolean {
  return SAUDI_VAT_RE.test(value);
}
