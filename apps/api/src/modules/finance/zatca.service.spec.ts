import { createHash, createVerify, createPublicKey } from 'crypto';
import { ZatcaService, ZatcaInvoiceInput } from './zatca.service';

const input = (over: Partial<ZatcaInvoiceInput> = {}): ZatcaInvoiceInput => ({
  invoiceCode: 'INV-00001',
  issuedAt: new Date('2026-01-15T10:00:00Z'),
  currency: 'SAR',
  lines: [{ descriptionEn: 'Solar modules', qty: 10, unitPrice: 100, vatRate: 15 }],
  subtotal: 1000,
  vatTotal: 150,
  grandTotal: 1150,
  parties: {
    sellerNameAr: 'شركة NPI للطاقة الشمسية',
    sellerNameEn: 'NPI Solar',
    sellerVat: '300000000000003',
    buyerNameAr: 'مستشفى الشفاء',
    buyerNameEn: 'Alshifa Hospital',
    buyerVat: '300000000000010',
  },
  previousInvoiceHash: null,
  ...over,
});

/** Decode the base64 TLV back into tag → value. */
const decodeTlv = (b64: string): Map<number, string> => {
  const buf = Buffer.from(b64, 'base64');
  const out = new Map<number, string>();
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i];
    const len = buf[i + 1];
    out.set(tag, buf.subarray(i + 2, i + 2 + len).toString('utf8'));
    i += 2 + len;
  }
  return out;
};

describe('ZatcaService.generate', () => {
  let svc: ZatcaService;
  beforeEach(() => {
    svc = new ZatcaService();
  });

  it('uses the genesis PIH for the first invoice in a chain', () => {
    const r = svc.generate('org1', input());
    expect(r.previousInvoiceHash).toBe(ZatcaService.GENESIS_PIH);
  });

  it('invoiceHash is SHA-256(xml) in base64', () => {
    const r = svc.generate('org1', input());
    const expected = createHash('sha256').update(r.xml, 'utf8').digest('base64');
    expect(r.invoiceHash).toBe(expected);
  });

  it('chains: invoice 2 carries invoice 1 hash as its PIH', () => {
    const r1 = svc.generate('org1', input());
    const r2 = svc.generate(
      'org1',
      input({ invoiceCode: 'INV-00002', previousInvoiceHash: r1.invoiceHash }),
    );
    expect(r2.previousInvoiceHash).toBe(r1.invoiceHash);
    expect(r2.invoiceHash).not.toBe(r1.invoiceHash);
  });

  it('QR TLV carries the 8 mandatory tags with correct values', () => {
    const r = svc.generate('org1', input());
    const tags = decodeTlv(r.qrTlv);
    expect(tags.size).toBe(8);
    expect(tags.get(1)).toBe('شركة NPI للطاقة الشمسية');
    expect(tags.get(2)).toBe('300000000000003');
    expect(tags.get(3)).toBe('2026-01-15T10:00:00.000Z');
    expect(tags.get(4)).toBe('1150.00');
    expect(tags.get(5)).toBe('150.00');
    expect(tags.get(6)).toBe(r.invoiceHash);
    expect(tags.get(7)).toBe(r.cryptographicStamp);
    expect(tags.get(8)).toBe(r.publicKey);
  });

  it('cryptographic stamp verifies against the returned public key', () => {
    const r = svc.generate('org1', input());
    const pub = createPublicKey({
      key: Buffer.from(r.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const verifier = createVerify('SHA256');
    verifier.update(r.invoiceHash);
    verifier.end();
    expect(verifier.verify(pub, Buffer.from(r.cryptographicStamp, 'base64'))).toBe(true);
  });

  it('B2B (buyer VAT present) => CLEARANCE; B2C => REPORTING', () => {
    expect(svc.generate('org1', input()).submissionMode).toBe('CLEARANCE');
    expect(
      svc.generate('org1', input({ parties: { ...input().parties, buyerVat: null } }))
        .submissionMode,
    ).toBe('REPORTING');
  });

  it('signing key is stable per org and distinct across orgs', () => {
    const a1 = svc.generate('orgA', input());
    const a2 = svc.generate('orgA', input({ invoiceCode: 'INV-00002' }));
    const b = svc.generate('orgB', input());
    expect(a1.publicKey).toBe(a2.publicKey);
    expect(a1.publicKey).not.toBe(b.publicKey);
  });

  it('is always flagged as simulated (no real CSID yet)', () => {
    expect(svc.generate('org1', input()).isSimulated).toBe(true);
  });

  describe('credit notes', () => {
    const note = () =>
      svc.generate(
        'org1',
        input({
          invoiceCode: 'CN-00001',
          documentType: 'CREDIT_NOTE',
          billingReference: {
            invoiceCode: 'INV-00001',
            issueDate: new Date('2026-01-15T10:00:00Z'),
            reason: 'Scope reduced by change order',
          },
        }),
      );

    it('carries InvoiceTypeCode 381, not 388', () => {
      expect(note().xml).toContain('>381</cbc:InvoiceTypeCode>');
      expect(svc.generate('org1', input()).xml).toContain('>388</cbc:InvoiceTypeCode>');
    });

    it('references the corrected invoice and the reason', () => {
      // ZATCA rejects a 381 that does not say what it corrects and why.
      const xml = note().xml;
      expect(xml).toContain('<cac:BillingReference>');
      expect(xml).toContain('<cbc:ID>INV-00001</cbc:ID>');
      expect(xml).toContain('<cbc:IssueDate>2026-01-15</cbc:IssueDate>');
      expect(xml).toContain('Scope reduced by change order');
    });

    it('joins the same hash chain as ordinary invoices', () => {
      const inv = svc.generate('org1', input());
      const cn = svc.generate(
        'org1',
        input({
          invoiceCode: 'CN-00001',
          documentType: 'CREDIT_NOTE',
          previousInvoiceHash: inv.invoiceHash,
          billingReference: {
            invoiceCode: 'INV-00001',
            issueDate: new Date('2026-01-15T10:00:00Z'),
            reason: 'Cancelled',
          },
        }),
      );
      expect(cn.previousInvoiceHash).toBe(inv.invoiceHash);
      expect(cn.invoiceHash).toBe(createHash('sha256').update(cn.xml, 'utf8').digest('base64'));
    });

    it('an ordinary invoice carries no billing reference', () => {
      expect(svc.generate('org1', input()).xml).not.toContain('<cac:BillingReference>');
    });
  });
});
