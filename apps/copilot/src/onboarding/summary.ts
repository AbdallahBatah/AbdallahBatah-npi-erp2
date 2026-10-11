// The «هذا ما قرأته من NPI» screen's content (T-47a): one card per setup step,
// in Arabic, built from a discovered session's answers and the metadata
// discovery left next to them. Pure — the page only renders what is here.
import { formatNumber } from '../i18n/format';
import { t, type ArKey } from '../i18n/ar';
import { formatBand } from './gaps';
import type { DiscoveryMeta, SetupState } from './machine';
import { APPROVAL_DOCUMENT_LABEL_AR, type SetupSource } from './plan';
import type { ProfileKey, ProfilePack } from './profile.schema';

export interface SummaryCard {
  /** The setup step the card's «غيّر» opens. */
  step: 2 | 3 | 4 | 5 | 6;
  titleAr: string;
  source: SetupSource;
  lines: string[];
}

export interface SetupSummary {
  profile: {
    key: ProfileKey;
    titleAr: string;
    source: SetupSource;
    confidence: DiscoveryMeta['evidence']['confidence'];
    reasonsAr: string[];
  };
  cards: SummaryCard[];
  /** What the reading left out, in Arabic. */
  skippedAr: string[];
}

/**
 * Null unless the session is a discovered one that still waits for the
 * administrator's confirmation and stands on the summary (step 7).
 */
export function buildSummary(state: SetupState, pack: ProfilePack | null): SetupSummary | null {
  const discovery = state.discovery;
  if (discovery === undefined || !discovery.needsReview || state.step !== 7 || pack === null) return null;
  const a = state.answers;
  const roleNameAr = (key: string) => discovery.roleSets?.[key]?.nameAr ?? pack.rolePermissionSets[key]?.nameAr ?? key;
  const source = (step: 1 | 2 | 3 | 4 | 5 | 6): SetupSource => discovery.sources[String(step) as '1'] ?? 'pack-default';

  const holderCount = (a.holders ?? []).reduce((n, h) => n + h.npiUserIds.length, 0);
  const rules = a.approvalRules ?? [];
  const docKeys = new Set(a.acceptedDocTypeKeys ?? []);
  const terms = Object.values(a.terminology ?? {});

  const cards: SummaryCard[] = [
    {
      step: 2,
      titleAr: t('setup.step.2'),
      source: source(2),
      lines: [
        t('setup.summary.departments', { n: formatNumber((a.departments ?? []).length) }),
        t('setup.summary.positions', { n: formatNumber((a.positions ?? []).length) }),
        t('setup.summary.holders', { n: formatNumber(holderCount) }),
      ],
    },
    {
      step: 3,
      titleAr: t('setup.step.3'),
      source: source(3),
      lines:
        rules.length === 0
          ? [t('setup.summary.rules_none')]
          : [
              t('setup.summary.rules', { n: formatNumber(rules.length) }),
              ...rules.map(
                (r) =>
                  `${APPROVAL_DOCUMENT_LABEL_AR[r.docType]} ${formatBand(r.minAmount, r.maxAmount ?? null)} ← ${r.steps.map(roleNameAr).join(' ثم ')}`,
              ),
            ],
    },
    {
      step: 4,
      titleAr: t('setup.step.4'),
      source: source(4),
      lines: [
        t('setup.summary.doctypes', { n: formatNumber(docKeys.size) }),
        pack.acceptedDocTypes.filter((d) => docKeys.has(d.key)).map((d) => d.labelAr).join('، '),
      ],
    },
    {
      step: 5,
      titleAr: t('setup.step.5'),
      source: source(5),
      lines: [t('setup.summary.items')],
    },
    {
      step: 6,
      titleAr: t('setup.step.6'),
      source: source(6),
      lines: [terms.length === 0 ? t('setup.summary.terms_none') : t('setup.summary.terms', { n: formatNumber(terms.length) })],
    },
  ];

  return {
    profile: {
      key: pack.key,
      titleAr: t(`profile.${pack.key}` as ArKey),
      source: source(1),
      confidence: discovery.evidence.confidence,
      reasonsAr: discovery.evidence.reasonsAr,
    },
    cards,
    skippedAr: discovery.evidence.skippedAr,
  };
}
