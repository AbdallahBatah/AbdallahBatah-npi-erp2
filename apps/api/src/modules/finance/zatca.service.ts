import { Injectable, Logger } from '@nestjs/common';
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from 'crypto';

/**
 * ZATCA (Fatoora) Phase 2 e-invoicing.
 *
 * This service produces a *structurally authentic* e-invoice: a UBL 2.1 XML
 * document, a SHA-256 hash chained to the previous invoice (PIH), a ZATCA QR
 * TLV, and an ECDSA (secp256k1) cryptographic stamp over the hash.
 *
 * SIMULATION SEAM: the signing key here is generated locally, NOT a ZATCA-issued
 * CSID, and clearance is simulated (no call to the Fatoora portal). Everything
 * marked `isSimulated: true`. To go live, replace `getSigningKey()` with the
 * onboarded CSID from a KMS/HSB (spec §5.6) and `submit()` with the real
 * clearance/reporting API call. The hash chain, XML and QR structure stay.
 */

// ZATCA genesis PIH for the first invoice in a chain: base64 of SHA-256("0").
const GENESIS_PIH =
  'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';

export interface ZatcaSellerBuyer {
  sellerNameAr: string;
  sellerNameEn: string;
  sellerVat: string;
  buyerNameAr: string;
  buyerNameEn: string;
  buyerVat?: string | null;
}

export interface ZatcaInvoiceInput {
  invoiceCode: string;
  issuedAt: Date;
  currency: string;
  lines: Array<{ descriptionEn: string; qty: number; unitPrice: number; vatRate: number }>;
  subtotal: number;
  vatTotal: number;
  grandTotal: number; // subtotal + vat
  parties: ZatcaSellerBuyer;
  previousInvoiceHash: string | null;
  /** 388 tax invoice (default) or 381 credit note. */
  documentType?: 'INVOICE' | 'CREDIT_NOTE';
  /**
   * Required on a credit note: ZATCA will not accept 381 without a reference
   * to the invoice being corrected, plus the reason for the correction.
   */
  billingReference?: { invoiceCode: string; issueDate: Date; reason: string };
}

export interface ZatcaResult {
  uuid: string;
  xml: string;
  invoiceHash: string;
  previousInvoiceHash: string;
  qrTlv: string;
  cryptographicStamp: string;
  publicKey: string;
  submissionMode: 'CLEARANCE' | 'REPORTING';
  authorityStatus: 'CLEARED' | 'REPORTED' | 'REJECTED';
  authorityResponseRef: string;
  isSimulated: true;
}

@Injectable()
export class ZatcaService {
  private readonly logger = new Logger(ZatcaService.name);
  // One signing key per organization (placeholder for the ZATCA CSID).
  private readonly keys = new Map<string, { priv: KeyObject; pubDerB64: string }>();

  static readonly GENESIS_PIH = GENESIS_PIH;

  private getSigningKey(organizationId: string) {
    let k = this.keys.get(organizationId);
    if (!k) {
      const { privateKey, publicKey } = generateKeyPairSync('ec', {
        namedCurve: 'secp256k1',
      });
      const pubDerB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      k = { priv: privateKey, pubDerB64 };
      this.keys.set(organizationId, k);
      this.logger.warn(
        `Generated a LOCAL signing key for org ${organizationId} — replace with a ZATCA CSID before production.`,
      );
    }
    return k;
  }

  private xmlEscape(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** A UBL 2.1 subset carrying the fields ZATCA validates. */
  private buildXml(input: ZatcaInvoiceInput, uuid: string, pih: string, isStandard: boolean): string {
    const p = input.parties;
    const lines = input.lines
      .map(
        (l, i) => `    <cac:InvoiceLine>
      <cbc:ID>${i + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="PCE">${l.qty}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${input.currency}">${(l.qty * l.unitPrice).toFixed(2)}</cbc:LineExtensionAmount>
      <cac:Item><cbc:Name>${this.xmlEscape(l.descriptionEn)}</cbc:Name>
        <cac:ClassifiedTaxCategory><cbc:Percent>${l.vatRate.toFixed(2)}</cbc:Percent></cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price><cbc:PriceAmount currencyID="${input.currency}">${l.unitPrice.toFixed(2)}</cbc:PriceAmount></cac:Price>
    </cac:InvoiceLine>`,
      )
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${this.xmlEscape(input.invoiceCode)}</cbc:ID>
  <cbc:UUID>${uuid}</cbc:UUID>
  <cbc:IssueDate>${input.issuedAt.toISOString().slice(0, 10)}</cbc:IssueDate>
  <cbc:IssueTime>${input.issuedAt.toISOString().slice(11, 19)}Z</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${isStandard ? '0100000' : '0200000'}">${input.documentType === 'CREDIT_NOTE' ? '381' : '388'}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${input.currency}</cbc:DocumentCurrencyCode>
${
  input.billingReference
    ? `  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${this.xmlEscape(input.billingReference.invoiceCode)}</cbc:ID>
      <cbc:IssueDate>${input.billingReference.issueDate.toISOString().slice(0, 10)}</cbc:IssueDate>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>1</cbc:PaymentMeansCode>
    <cbc:InstructionNote>${this.xmlEscape(input.billingReference.reason)}</cbc:InstructionNote>
  </cac:PaymentMeans>
`
    : ''
}  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${pih}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyTaxScheme><cbc:CompanyID>${this.xmlEscape(p.sellerVat)}</cbc:CompanyID></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>${this.xmlEscape(p.sellerNameEn)}</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    ${p.buyerVat ? `<cac:PartyTaxScheme><cbc:CompanyID>${this.xmlEscape(p.buyerVat)}</cbc:CompanyID></cac:PartyTaxScheme>` : ''}
    <cac:PartyLegalEntity><cbc:RegistrationName>${this.xmlEscape(p.buyerNameEn)}</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="${input.currency}">${input.vatTotal.toFixed(2)}</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${input.currency}">${input.subtotal.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${input.currency}">${input.subtotal.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${input.currency}">${input.grandTotal.toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${input.currency}">${input.grandTotal.toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${lines}
</Invoice>`;
  }

  /** TLV: [tag][length][value...], concatenated and base64-encoded (ZATCA QR). */
  private buildQrTlv(tags: Array<{ tag: number; value: string }>): string {
    const chunks: Buffer[] = [];
    for (const { tag, value } of tags) {
      const v = Buffer.from(value, 'utf8');
      chunks.push(Buffer.from([tag, v.length]), v);
    }
    return Buffer.concat(chunks).toString('base64');
  }

  generate(organizationId: string, input: ZatcaInvoiceInput): ZatcaResult {
    const uuid = randomUUID();
    const pih = input.previousInvoiceHash ?? GENESIS_PIH;
    // Standard (B2B) invoices go through clearance; simplified (B2C) are reported.
    const isStandard = !!input.parties.buyerVat;
    const xml = this.buildXml(input, uuid, pih, isStandard);

    const invoiceHash = createHash('sha256').update(xml, 'utf8').digest('base64');

    const key = this.getSigningKey(organizationId);
    const signer = createSign('SHA256');
    signer.update(invoiceHash);
    signer.end();
    const stamp = signer.sign(key.priv).toString('base64');
    const qrTlv = this.buildQrTlv([
      { tag: 1, value: input.parties.sellerNameAr || input.parties.sellerNameEn },
      { tag: 2, value: input.parties.sellerVat },
      { tag: 3, value: input.issuedAt.toISOString() },
      { tag: 4, value: input.grandTotal.toFixed(2) },
      { tag: 5, value: input.vatTotal.toFixed(2) },
      { tag: 6, value: invoiceHash },
      { tag: 7, value: stamp },
      { tag: 8, value: key.pubDerB64 },
    ]);

    return {
      uuid,
      xml,
      invoiceHash,
      previousInvoiceHash: pih,
      qrTlv,
      cryptographicStamp: stamp,
      publicKey: key.pubDerB64,
      submissionMode: isStandard ? 'CLEARANCE' : 'REPORTING',
      authorityStatus: isStandard ? 'CLEARED' : 'REPORTED',
      authorityResponseRef: `SIMULATED-${uuid.slice(0, 8).toUpperCase()}`,
      isSimulated: true,
    };
  }
}
