import { NpiError } from '../src/npi/errors';
import { buildDictionary, clearDictionaryCache, type DictionaryNpi } from '../src/privacy/dictionary';
import { Pseudonymizer } from '../src/privacy/pseudonymizer';

const forbidden = () => new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Forbidden' });
const timeout = () => new NpiError({ status: 0, kind: 'timeout', npiMessage: null });

const CUSTOMERS = [{ id: 'c1', nameAr: 'شركة النخيل للمقاولات', nameEn: 'Al Nakheel' }];
const VENDORS = [{ id: 'v1', nameAr: 'الفجر للتوريدات', nameEn: 'Al Fajr Supplies' }];
const PROJECTS = [{ id: 'p1', nameAr: 'محطة الرياض الشمسية', nameEn: 'Riyadh plant' }];
const PEOPLE = [{ id: 'u9', nameAr: 'خالد العتيبي', nameEn: 'Khalid' }];

type Fake = { [K in keyof DictionaryNpi]: jest.Mock };

function npiFor(role: 'sales' | 'site_engineer' | 'admin' | 'nothing'): Fake {
  // One mock per method, so that calls can be counted per list.
  const refuse = () =>
    jest.fn(async () => {
      throw forbidden();
    });
  const allowed: Record<typeof role, string[]> = {
    sales: ['customer'],
    site_engineer: ['vendor', 'project'],
    admin: ['customer', 'vendor', 'project', 'employee'],
    nothing: [],
  };
  const can = allowed[role];
  return {
    listCustomers: can.includes('customer') ? jest.fn(async () => CUSTOMERS) : refuse(),
    listVendors: can.includes('vendor') ? jest.fn(async () => VENDORS) : refuse(),
    listProjects: can.includes('project') ? jest.fn(async () => PROJECTS) : refuse(),
    listDepartmentDirectory: can.includes('employee') ? jest.fn(async () => PEOPLE) : refuse(),
  };
}

const caller = (id: string, nameAr: string) => ({ npiOrgId: 'org-1', npiUserId: id, nameAr });
const kinds = (entries: { kind: string }[]) => [...new Set(entries.map((e) => e.kind))].sort();

beforeEach(() => clearDictionaryCache());

describe('buildDictionary', () => {
  it('reads what the caller may read and always knows the caller', async () => {
    const entries = await buildDictionary(npiFor('sales') as unknown as DictionaryNpi, caller('u1', 'سارة القحطاني'));
    expect(kinds(entries)).toEqual(['customer', 'employee']);
    expect(entries.find((e) => e.kind === 'employee')?.names).toEqual(['سارة القحطاني']);
  });

  it("a narrow caller arriving first does not fix the organization's dictionary", async () => {
    let clock = 1_000_000;
    const now = () => clock;

    // 09:00 a sales employee: customers only.
    await buildDictionary(npiFor('sales') as unknown as DictionaryNpi, caller('u1', 'سارة'), now);

    // 09:01 a site engineer: the vendor and project lists were never read, so
    // they are read now even though the customer list is still fresh.
    clock += 60_000;
    const engineer = npiFor('site_engineer');
    const entries = await buildDictionary(engineer as unknown as DictionaryNpi, caller('u2', 'ماجد'), now);

    expect(engineer.listVendors).toHaveBeenCalledTimes(1);
    expect(engineer.listProjects).toHaveBeenCalledTimes(1);
    expect(engineer.listCustomers).not.toHaveBeenCalled(); // still fresh, shared
    expect(kinds(entries)).toEqual(['customer', 'employee', 'project', 'vendor']);

    // The vendor's name has no legal-form word; only the dictionary catches it.
    const out = new Pseudonymizer(entries).redact('المورد الفجر للتوريدات تأخر في محطة الرياض الشمسية');
    expect(out).not.toContain('الفجر');
    expect(out).not.toContain('الرياض');
  });

  it('a refused read never replaces a list that is already known', async () => {
    let clock = 1_000_000;
    const now = () => clock;
    await buildDictionary(npiFor('admin') as unknown as DictionaryNpi, caller('u0', 'المدير'), now);

    // Everything expires; the next caller may read nothing at all.
    clock += 10 * 60_000;
    const entries = await buildDictionary(npiFor('nothing') as unknown as DictionaryNpi, caller('u3', 'نورة'), now);

    expect(kinds(entries)).toEqual(['customer', 'employee', 'project', 'vendor']);
    expect(entries.some((e) => e.names.includes('خالد العتيبي'))).toBe(true);
    expect(entries.some((e) => e.names.includes('نورة'))).toBe(true);
  });

  it('a timeout on one list keeps the last good list and does not fail the turn', async () => {
    let clock = 1_000_000;
    const now = () => clock;
    await buildDictionary(npiFor('admin') as unknown as DictionaryNpi, caller('u0', 'المدير'), now);

    clock += 10 * 60_000;
    const flaky = npiFor('admin');
    flaky.listVendors = jest.fn(async () => {
      throw timeout();
    });
    const entries = await buildDictionary(flaky as unknown as DictionaryNpi, caller('u0', 'المدير'), now);
    expect(entries.some((e) => e.kind === 'vendor' && e.names.includes('الفجر للتوريدات'))).toBe(true);
  });

  it('reads a list again once it is older than five minutes, and not before', async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const admin = npiFor('admin');
    await buildDictionary(admin as unknown as DictionaryNpi, caller('u0', 'المدير'), now);
    clock += 4 * 60_000;
    await buildDictionary(admin as unknown as DictionaryNpi, caller('u0', 'المدير'), now);
    expect(admin.listCustomers).toHaveBeenCalledTimes(1);
    clock += 2 * 60_000;
    await buildDictionary(admin as unknown as DictionaryNpi, caller('u0', 'المدير'), now);
    expect(admin.listCustomers).toHaveBeenCalledTimes(2);
  });

  it('keeps organizations apart', async () => {
    await buildDictionary(npiFor('admin') as unknown as DictionaryNpi, caller('u0', 'المدير'));
    const other = await buildDictionary(npiFor('nothing') as unknown as DictionaryNpi, {
      npiOrgId: 'org-2',
      npiUserId: 'x1',
      nameAr: 'هند',
    });
    expect(other).toEqual([{ kind: 'employee', npiId: 'x1', names: ['هند'] }]);
  });

  it('treats a malformed list as a failed read', async () => {
    const npi = npiFor('admin');
    npi.listCustomers = jest.fn(async () => ({ unexpected: true }));
    const entries = await buildDictionary(npi as unknown as DictionaryNpi, caller('u0', 'المدير'));
    expect(entries.some((e) => e.kind === 'customer')).toBe(false);
    expect(entries.some((e) => e.kind === 'vendor')).toBe(true);
  });

  it('lets a failure that is not from NPI surface', async () => {
    const npi = npiFor('admin');
    npi.listProjects = jest.fn(async () => {
      throw new Error('bug');
    });
    await expect(buildDictionary(npi as unknown as DictionaryNpi, caller('u0', 'المدير'))).rejects.toThrow('bug');
  });
});

describe('Pseudonymizer.redactJson — fields known to be names', () => {
  it('masks a named field as a whole with an empty dictionary and no pattern to match', () => {
    const p = new Pseudonymizer([]);
    const out = p.redactJson(
      { found: true, vendorNameAr: 'الفجر للتوريدات', total: '115000.12', code: 'PO-00042' },
      { vendorNameAr: 'مورد' },
    );
    expect(JSON.parse(out)).toEqual({
      found: true,
      vendorNameAr: '⟦مورد_1⟧',
      total: '115000.12',
      code: 'PO-00042',
    });
    expect(p.rehydrate('⟦مورد_1⟧')).toBe('الفجر للتوريدات');
  });

  it('applies to every row of a list and reuses the placeholder of a repeated value', () => {
    const p = new Pseudonymizer([]);
    const out = JSON.parse(
      p.redactJson(
        {
          projects: [
            { code: 'PRJ-00012', nameAr: 'توسعة المستودع', customerNameAr: 'البيان' },
            { code: 'PRJ-00013', nameAr: 'مظلات المواقف', customerNameAr: 'البيان' },
          ],
        },
        { nameAr: 'مشروع', customerNameAr: 'عميل' },
      ),
    );
    expect(out.projects.map((r: { nameAr: string }) => r.nameAr)).toEqual(['⟦مشروع_1⟧', '⟦مشروع_2⟧']);
    expect(out.projects.map((r: { customerNameAr: string }) => r.customerNameAr)).toEqual(['⟦عميل_1⟧', '⟦عميل_1⟧']);
    expect(out.projects.map((r: { code: string }) => r.code)).toEqual(['PRJ-00012', 'PRJ-00013']);
  });

  it('masks a phone number that matches no pattern when the field is known', () => {
    const p = new Pseudonymizer([]);
    const out = JSON.parse(p.redactJson({ phone: '0138001234', email: null }, { phone: 'هاتف', email: 'بريد' }));
    expect(out).toEqual({ phone: '⟦هاتف_1⟧', email: null });
  });

  it('leaves other fields to the ordinary rules and keeps empty values', () => {
    const p = new Pseudonymizer([]);
    const out = JSON.parse(p.redactJson({ nameAr: '', note: 'التسليم يوم 2026-09-20' }, { nameAr: 'عميل' }));
    expect(out).toEqual({ nameAr: '', note: 'التسليم يوم 2026-09-20' });
  });
});
