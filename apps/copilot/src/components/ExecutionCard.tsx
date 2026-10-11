import { t, type ArKey } from '@/i18n/ar';
import { Card } from '@/components/ui/Card';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { keyedLines } from '@/components/ui/keys';
import { npiWebUrl } from '@/npi/web-url';
import type { ExecutionLog, ExecutionStep, ExecutionStepState, FlowType } from '@/intake/types';

export interface ExecutionCardProps {
  log: ExecutionLog;
  flowLabelAr: string;
  flow: FlowType;
}

const STATE_TONE: Record<ExecutionStepState, BadgeTone> = {
  pending: 'neutral',
  running: 'info',
  done: 'success',
  failed: 'danger',
  manual: 'neutral',
};

const STATE_LABEL_KEY: Record<ExecutionStepState, ArKey> = {
  pending: 'exec.step.pending',
  running: 'exec.step.running',
  done: 'exec.step.done',
  failed: 'exec.step.failed',
  manual: 'exec.step.manual',
};

/** Flows whose record enters NPI's approval matrix after the execution. */
const MATRIX_FLOWS: ReadonlySet<FlowType> = new Set<FlowType>(['pr', 'po']);

function entityLabel(step: ExecutionStep): string | null {
  if (!step.entity) return null;
  return t('exec.done', { entity: step.entity.kindAr, code: step.entity.code ?? step.entity.id });
}

function createdSoFar(steps: ExecutionStep[]): string {
  const created = steps
    .filter((s) => s.entity !== undefined)
    .map((s) => `${s.entity!.kindAr} ${s.entity!.code ?? s.entity!.id}`);
  return created.length > 0 ? created.join('، ') : t('preview.empty_value');
}

function StatusLines({ log, flow }: { log: ExecutionLog; flow: FlowType }) {
  if (log.status === 'pending') return <p className="text-sm text-slate-700">{t('exec.pending')}</p>;
  if (log.status === 'running') {
    return (
      <output className="block text-sm text-slate-700">
        {t('exec.running')}
      </output>
    );
  }
  if (log.status === 'done') {
    const lines = log.steps.map(entityLabel).filter((line): line is string => line !== null);
    const hasManual = log.steps.some((s) => s.state === 'manual');
    return (
      <div className="flex flex-col gap-1">
        <output className="block text-sm font-semibold text-success-700">
          {t('exec.done_all')}
        </output>
        {keyedLines(lines).map(({ key, line }) => (
          <p key={key} className="break-words text-sm font-semibold text-success-700">
            {line}
          </p>
        ))}
        {MATRIX_FLOWS.has(flow) ? <p className="text-sm text-slate-700">{t('exec.after_matrix')}</p> : null}
        {hasManual ? <p className="text-sm text-slate-600">{t('exec.manual_hint')}</p> : null}
      </div>
    );
  }
  const failedIndex = log.failedAt !== undefined ? log.failedAt - 1 : log.steps.findIndex((s) => s.state === 'failed');
  const failedStep = failedIndex >= 0 ? log.steps[failedIndex] : undefined;
  return (
    <p role="alert" className="break-words text-sm font-semibold text-danger-700">
      {t('exec.failed', {
        n: failedIndex >= 0 ? failedIndex + 1 : log.failedAt ?? 0,
        reason: failedStep?.errorAr ?? '',
        created: createdSoFar(log.steps),
      })}
    </p>
  );
}

/**
 * What happened in NPI after approval (spec/madar/03 §2 `ExecutionCard`):
 * the overall status, then each step with its state, the NPI record it
 * created and a link to it. Gold edge like the preview card above it. T-27's
 * executor produces every state: `manual` marks a step the copilot never
 * performs (it is completed on NPI's own screen).
 */
export function ExecutionCard({ log, flowLabelAr, flow }: ExecutionCardProps) {
  return (
    <div data-testid="execution-card" className="min-w-0">
      <Card edge="gold" title={t('exec.title')}>
        <div className="flex min-w-0 flex-col gap-3">
          <div>
            <Badge tone="brand">{flowLabelAr}</Badge>
          </div>
          <StatusLines log={log} flow={flow} />
          <ol className="flex flex-col gap-2">
            {log.steps.map((step) => (
              <li
                key={step.n}
                data-testid="execution-step"
                data-state={step.state}
                className="flex min-w-0 flex-col gap-1 rounded-lg border border-slate-200 p-2.5"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge tone={STATE_TONE[step.state]}>{t(STATE_LABEL_KEY[step.state])}</Badge>
                  <span className="min-w-0 break-words text-sm text-slate-800">{step.labelAr}</span>
                </div>
                {step.state === 'failed' && step.errorAr ? (
                  <p className="break-words text-sm text-danger-700">{step.errorAr}</p>
                ) : null}
                {step.entity ? (
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-slate-700">
                    <span className="break-words">
                      {step.entity.kindAr} <bdi>{step.entity.code ?? step.entity.id}</bdi>
                    </span>
                    {step.entity.npiPath && step.entity.npiPath.startsWith('/') ? (
                      <a
                        href={npiWebUrl(step.entity.npiPath)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-h-11 items-center font-semibold text-brand-600 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 md:min-h-0"
                      >
                        {t('exec.open_in_npi')}
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      </Card>
    </div>
  );
}
