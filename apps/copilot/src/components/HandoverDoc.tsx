'use client';

import type { ReactNode } from 'react';
import { t, type ArKey } from '@/i18n/ar';
import { formatDate, formatNumber } from '@/i18n/format';
import { npiWebUrl } from '@/npi/web-url';
import { APPROVAL_DOCUMENT_LABEL_AR } from '@/onboarding/plan';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PredecessorChats } from '@/components/handover/PredecessorChats';
import type { HandoverFact, HandoverTask, HandoverView } from '@/positions/handover-types';

export interface HandoverDocProps {
  view: HandoverView;
  isAdmin: boolean;
  /** Rewrites the narrative from the stored body («أعد كتابة الملخص»). */
  onNarrate: () => void;
  /** A narrate call is in flight. */
  narrating?: boolean;
}

function documentLabel(documentType: string): string {
  return (APPROVAL_DOCUMENT_LABEL_AR as Record<string, string | undefined>)[documentType] ?? documentType;
}

function Section({ testId, title, children }: { testId: string; title: string; children: ReactNode }) {
  return (
    <section data-testid={testId}>
      <Card title={title}>{children}</Card>
    </section>
  );
}

function SourceBadge({ sourceType }: { sourceType: HandoverFact['sourceType'] }) {
  return sourceType === 'npi' ? (
    <Badge tone="info">{t('handover.source.npi')}</Badge>
  ) : (
    <Badge tone="neutral">{t('handover.source.chat')}</Badge>
  );
}

function FactList({ facts }: { facts: HandoverFact[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {facts.map((fact) => (
        <li key={fact.factId} className="flex flex-col items-start gap-1 text-sm text-slate-800">
          <span className="leading-6">{fact.factAr}</span>
          <SourceBadge sourceType={fact.sourceType} />
        </li>
      ))}
    </ul>
  );
}

function TaskItem({ task }: { task: HandoverTask }) {
  return (
    <li data-testid="handover-task" className="flex flex-col gap-1.5 rounded-lg border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-bold text-slate-900">
          {documentLabel(task.documentType)} {task.documentCode}
        </p>
        {task.escalated ? <Badge tone="danger">{t('handover.task.escalated')}</Badge> : null}
      </div>
      <p className="text-sm text-slate-700">{t('handover.task.amount', { amount: formatNumber(task.amount) })}</p>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
        <span>{t('handover.task.step', { n: formatNumber(task.currentStep), total: formatNumber(task.stepCount) })}</span>
        <span>{t('handover.task.waiting', { date: formatDate(task.waitingSince) })}</span>
        {task.raisedByNameAr ? <span>{t('handover.task.raised_by', { name: task.raisedByNameAr })}</span> : null}
      </div>
      <a
        href={npiWebUrl('/approvals')}
        target="_blank"
        rel="noopener"
        className="w-fit text-sm font-semibold text-brand-600 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        {t('handover.task.open_in_npi')}
      </a>
    </li>
  );
}

/**
 * The handover document of a position (T-30, F-13, spec/madar/03 `HandoverDoc`):
 * a header (who handed over to whom, when), then the narrative the advanced
 * tier wrote, the chains NPI's approval matrix waits on from the role, the
 * vendors and routines the firm's memory holds, the company facts a newcomer
 * reads first and — for an administrator only (BR-07) — the predecessor's
 * conversations. Pure presentation: every number and date goes through
 * `formatNumber`/`formatDate`, every word through `t()`.
 */
export function HandoverDoc({ view, isAdmin, onNarrate, narrating = false }: HandoverDocProps) {
  const { body } = view;
  const narrative = body.narrative;

  return (
    <article data-testid="handover-doc" className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-col gap-1.5">
          <p className="text-base font-bold text-slate-900">{t('handover.reassign.position', { title: body.position.titleAr })}</p>
          {body.predecessor ? (
            <p className="flex flex-wrap gap-x-2 text-sm text-slate-700">
              <span>{t('handover.from', { name: body.predecessor.nameAr ?? t('handover.unknown_user') })}</span>
              <span className="text-slate-500">{t('handover.since', { date: formatDate(body.predecessor.since) })}</span>
            </p>
          ) : (
            <p className="text-sm text-slate-500">{t('handover.no_predecessor')}</p>
          )}
          <p className="text-sm text-slate-700">{t('handover.to', { name: body.successor.nameAr ?? t('handover.unknown_user') })}</p>
          <p className="text-xs text-slate-500">{t('handover.generated_at', { date: formatDate(body.generatedAt) })}</p>
        </div>
      </Card>

      {narrative.status !== 'skipped' ? (
        <Section testId="handover-narrative" title={t('handover.section.narrative')}>
          {narrative.status === 'written' ? (
            <div className="flex flex-col gap-3">
              <p className="whitespace-pre-wrap text-sm leading-7 text-slate-800">{narrative.summaryAr}</p>
              {narrative.firstWeekAr.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <h4 className="text-sm font-bold text-slate-900">{t('handover.narrative.first_week')}</h4>
                  <ul className="list-disc ps-5 text-sm leading-7 text-slate-800">
                    {narrative.firstWeekAr.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {narrative.cautionsAr.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <h4 className="text-sm font-bold text-slate-900">{t('handover.narrative.cautions')}</h4>
                  <ul className="list-disc ps-5 text-sm leading-7 text-slate-800">
                    {narrative.cautionsAr.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <p className="text-xs text-slate-500">{t('handover.narrative.model', { date: formatDate(narrative.writtenAt) })}</p>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p role="status" className="text-sm text-warning-700">
                {t('handover.narrative.failed', { reason: narrative.reason })}
              </p>
              {isAdmin ? (
                <Button type="button" variant="secondary" size="sm" loading={narrating} onClick={onNarrate}>
                  {narrating ? t('handover.narrative.retrying') : t('handover.narrative.retry')}
                </Button>
              ) : null}
            </div>
          )}
        </Section>
      ) : null}

      <Section testId="handover-tasks" title={t('handover.section.tasks')}>
        {body.tasks.status === 'skipped' ? (
          <p className="text-sm text-warning-700">{t(`handover.tasks.skipped.${body.tasks.reason}` as ArKey)}</p>
        ) : body.tasks.items.length === 0 ? (
          <p className="text-sm text-slate-500">{t('handover.tasks.empty')}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col gap-2">
              {body.tasks.items.map((task) => (
                <TaskItem key={task.id} task={task} />
              ))}
            </ul>
            <p className="text-xs text-slate-500">{t('handover.tasks.note')}</p>
          </div>
        )}
      </Section>

      <Section testId="handover-vendors" title={t('handover.section.vendors')}>
        {body.vendors.length === 0 ? (
          <p className="text-sm text-slate-500">{t('handover.vendors.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {body.vendors.map((vendor, i) => (
              <li
                key={vendor.npiVendorId ?? `${i}-${vendor.factsAr[0] ?? ''}`}
                data-testid="handover-vendor"
                className="flex flex-col gap-1.5 rounded-lg border border-slate-200 p-3"
              >
                <p className="text-sm font-bold text-slate-900">
                  {vendor.nameAr ?? vendor.factsAr[0] ?? ''}
                  {vendor.code ? <span className="ms-2 text-xs font-normal text-slate-500">{vendor.code}</span> : null}
                </p>
                <ul className="flex flex-col gap-1">
                  {(vendor.nameAr !== null ? vendor.factsAr : vendor.factsAr.slice(1)).map((fact, j) => (
                    <li key={j} className="text-sm leading-6 text-slate-700">
                      {fact}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section testId="handover-routines" title={t('handover.section.routines')}>
        {body.routines.length === 0 ? (
          <p className="text-sm text-slate-500">{t('handover.routines.empty')}</p>
        ) : (
          <FactList facts={body.routines} />
        )}
      </Section>

      {body.companyFacts.length > 0 ? (
        <Section testId="handover-company" title={t('handover.section.company')}>
          <FactList facts={body.companyFacts} />
        </Section>
      ) : null}

      {view.predecessorConversations !== undefined ? (
        <Section testId="handover-chats" title={t('handover.section.chats')}>
          <PredecessorChats conversations={view.predecessorConversations} />
        </Section>
      ) : null}
    </article>
  );
}
