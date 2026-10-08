// T-35 (07 G-M4-4): the CSV of the metrics screen - cell quoting, the BOM, the
// fixed header, six rows, value formats per unit, CRLF line ends. Pure; the
// route that serves it is tested elsewhere.
import { csvCell, metricsToCsv } from '../src/metrics/csv';
import { t } from '../src/i18n/ar';
import {
  METRICS_CSV_HEADER,
  type AssumptionId,
  type MetricCardView,
  type MetricsView,
} from '../src/metrics/types';

const BOM = '﻿';

function card(assumption: AssumptionId, overrides: Partial<MetricCardView> = {}): MetricCardView {
  return {
    assumption,
    labelAr: t(`metrics.${assumption}` as const),
    value: '50%',
    rawValue: 0.5,
    unit: 'percent',
    targetAr: '≥ 70%',
    target: '>=0.70',
    verdict: 'not_met',
    measuredAt: '2026-10-08T09:00:00.000Z',
    secondary: null,
    detailsAr: [],
    details: 'a=1;b=2',
    ...overrides,
  };
}

function view(cards: MetricCardView[]): MetricsView {
  return { generatedAt: '2026-10-08T09:00:00.000Z', npiOrgId: 'org_npi_root', cards };
}

/** A tiny RFC 4180 splitter: records on CRLF, fields on commas, quotes doubled. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i += 1;
    } else {
      field += ch;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

const SIX: MetricCardView[] = [
  card('a1', { rawValue: 0.7143, details: 'window_days=14;working_days=10;active_users=3' }),
  card('a2', { rawValue: 0.96, target: '>=0.85' }),
  card('a3', { rawValue: 159657, unit: 'usd', target: 'measured', verdict: 'measured', details: 'headline=per_document' }),
  card('a4', { value: null, rawValue: null, verdict: 'no_data', measuredAt: null, target: '>=0.90;>=0.95', details: 'run=none' }),
  card('a5', { rawValue: 0.9871, details: 'note=has, a comma;and "quotes"' }),
  card('a6', { rawValue: 12.5, unit: 'minutes', target: '<=30' }),
];

describe('csvCell', () => {
  it('leaves a plain string as is', () => {
    expect(csvCell('plain text')).toBe('plain text');
    expect(csvCell('')).toBe('');
    expect(csvCell('العودة اليومية')).toBe('العودة اليومية');
  });

  it('quotes a string with a comma', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
  });

  it('quotes a string with a double quote and doubles the inner quotes', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes a string with CR or LF', () => {
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell('a\r\nb')).toBe('"a\r\nb"');
    expect(csvCell('a\rb')).toBe('"a\rb"');
  });

  it('renders null as empty and a number as its decimal form', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(0.7143)).toBe('0.7143');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(0)).toBe('0');
  });
});

describe('metricsToCsv', () => {
  const csv = metricsToCsv(view(SIX));

  it('starts with the BOM and the fixed header', () => {
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.slice(BOM.length).split('\r\n')[0]).toBe(METRICS_CSV_HEADER);
    expect(METRICS_CSV_HEADER).toBe('assumption,metric,value,target,measured_at,details');
  });

  it('ends with CRLF and uses CRLF between all lines', () => {
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.replace(/\r\n/g, '').includes('\n')).toBe(false);
    expect(csv.replace(/\r\n/g, '').includes('\r')).toBe(false);
  });

  it('has exactly 6 data lines after the header', () => {
    const records = parseCsv(csv.slice(BOM.length));
    expect(records).toHaveLength(7);
    expect(records[0]).toEqual(METRICS_CSV_HEADER.split(','));
    for (const record of records) expect(record).toHaveLength(6);
    expect(records.slice(1).map((r) => r[0])).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  });

  it('parses the fields back, label and target as given', () => {
    const records = parseCsv(csv.slice(BOM.length));
    expect(records[1]).toEqual([
      'a1',
      t('metrics.a1'),
      '0.7143',
      '>=0.70',
      '2026-10-08T09:00:00.000Z',
      'window_days=14;working_days=10;active_users=3',
    ]);
    expect(records[2][1]).toBe(t('metrics.a2'));
    expect(records[2][3]).toBe('>=0.85');
  });

  it('formats the value per unit: 4 dp, 1 dp, integer micro-USD, empty for null', () => {
    const values = parseCsv(csv.slice(BOM.length))
      .slice(1)
      .map((r) => r[2]);
    expect(values).toEqual(['0.7143', '0.9600', '159657', '', '0.9871', '12.5']);
  });

  it('pads a float artifact and rounds micro-USD', () => {
    const rows = parseCsv(
      metricsToCsv(
        view([
          card('a1', { rawValue: 0.7143000001 }),
          card('a2', { rawValue: 1, unit: 'ratio' }),
          card('a3', { rawValue: 31931.4, unit: 'usd' }),
          card('a4', { rawValue: 0.3333, unit: 'ratio' }),
          card('a5', { rawValue: 0 }),
          card('a6', { rawValue: 30, unit: 'minutes' }),
        ]),
      ).slice(BOM.length),
    );
    expect(rows.slice(1).map((r) => r[2])).toEqual(['0.7143', '1.0000', '31931', '0.3333', '0.0000', '30.0']);
  });

  it('writes an empty measured_at for a card without one', () => {
    const record = parseCsv(csv.slice(BOM.length))[4];
    expect(record[4]).toBe('');
    expect(record[5]).toBe('run=none');
  });

  it('quotes a details cell holding a comma or quotes and parses it back', () => {
    expect(csv).toContain('"note=has, a comma;and ""quotes"""');
    const record = parseCsv(csv.slice(BOM.length))[5];
    expect(record).toHaveLength(6);
    expect(record[5]).toBe('note=has, a comma;and "quotes"');
  });

  it('does not quote a cell that needs none', () => {
    const line = csv.slice(BOM.length).split('\r\n')[1];
    expect(line).toBe(`a1,${t('metrics.a1')},0.7143,>=0.70,2026-10-08T09:00:00.000Z,window_days=14;working_days=10;active_users=3`);
  });
});
