// The CSV export of the metrics screen (T-35, 07 G-M4-4, 02 §8): one header
// and exactly six rows, one per assumption. Pure — the route handler only
// wraps the string in a response.
import { METRICS_CSV_HEADER, type MetricCardView, type MetricsView } from './types';

/** UTF-8 byte order mark: Excel needs it to read the Arabic labels. */
const BOM = '﻿';
const EOL = '\r\n';

/** One RFC 4180 cell: `null` is empty, a number is its decimal form, a string
 *  is quoted (inner quotes doubled) only when it holds a comma, a double
 *  quote, CR or LF. */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** The machine figure of a card: a share or ratio with 4 decimals, minutes
 *  with 1, USD micro as an integer; empty when there is none. */
function valueCell(card: MetricCardView): string {
  const raw = card.rawValue;
  if (raw === null) return '';
  switch (card.unit) {
    case 'percent':
    case 'ratio':
      return raw.toFixed(4);
    case 'minutes':
      return raw.toFixed(1);
    case 'usd':
      return String(Math.round(raw));
  }
}

export function metricsToCsv(view: MetricsView): string {
  const lines = view.cards.map((card) =>
    [
      csvCell(card.assumption),
      csvCell(card.labelAr),
      csvCell(valueCell(card)),
      csvCell(card.target),
      csvCell(card.measuredAt ?? ''),
      csvCell(card.details),
    ].join(','),
  );
  return BOM + [METRICS_CSV_HEADER, ...lines].join(EOL) + EOL;
}
