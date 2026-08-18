'use client';

/**
 * Reusable attachments card — drop `<AttachmentsCard entityType="CONTRACT"
 * entityId={id} />` on any detail page. Upload, list, download, delete.
 * Hidden entirely when the role lacks platform.attachment.read.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiDownload, apiUpload } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { Btn } from '@/components/ui';
import { formatDate } from '@/lib/format';
import { useConfirm } from './ui';
import { Icon } from './icons';

interface AttachmentRow {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  uploadedBy?: { nameAr: string; nameEn: string } | null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentsCard({
  entityType,
  entityId,
}: {
  entityType: 'CONTRACT' | 'INVOICE' | 'PROJECT' | 'WORK_ORDER';
  entityId: string;
}) {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();
  const [rows, setRows] = useState<AttachmentRow[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api
      .get<AttachmentRow[]>(`/attachments/${entityType}/${entityId}`)
      .then(setRows)
      .catch(() => undefined); // a side card never blocks the page
  }, [entityType, entityId]);
  useEffect(load, [load]);

  if (!can('platform.attachment.read')) return null;
  const canWrite = can('platform.attachment.write');

  async function onPick(file: File | undefined | null) {
    if (!file) return;
    const ok = await act('upload', () => apiUpload(`/attachments/${entityType}/${entityId}`, file));
    if (fileRef.current) fileRef.current.value = '';
    if (ok) load();
  }

  async function onDelete(row: AttachmentRow) {
    if (
      !(await confirm({
        title: t('att.deleteTitle'),
        message: `${t('att.deleteMsg')} (${row.fileName})`,
        danger: true,
      }))
    )
      return;
    if (await act('deleteAtt', () => api.del(`/attachments/${row.id}`))) load();
  }

  return (
    <div className="no-print card overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
        <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800">
          <Icon name="paperclip" className="h-4 w-4 text-slate-400" />
          {t('att.title')}
          {rows.length > 0 && <span className="text-xs font-normal text-slate-600">({rows.length})</span>}
        </h3>
        {canWrite && (
          <>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.docx,.csv,.txt,.zip,.dwg"
              onChange={(e) => onPick(e.target.files?.[0])}
            />
            <Btn
              sm
              icon="paperclip"
              className="!px-2.5 !py-1 !text-[11px]"
              busy={busy('upload')}
              disabled={busy()}
              title={t('att.hint')}
              onClick={() => fileRef.current?.click()}
            >
              {busy('upload') ? t('att.uploading') : t('att.upload')}
            </Btn>
          </>
        )}
      </div>
      <div className="p-4">
        {rows.length === 0 ? (
          <p className="py-3 text-center text-xs text-slate-600">{t('att.empty')}</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs"
              >
                <button
                  className="flex min-w-0 flex-1 items-center gap-2 text-start hover:text-brand-700"
                  title={t('att.download')}
                  onClick={() =>
                    act('download', () => apiDownload(`/attachments/${row.id}/download`, row.fileName), {
                      success: false,
                    })
                  }
                >
                  <Icon name="download" className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-slate-700">{row.fileName}</span>
                    <span className="block text-[10px] text-slate-600">
                      {formatBytes(row.sizeBytes)}
                      {row.uploadedBy && (
                        <> · {locale === 'ar' ? row.uploadedBy.nameAr : row.uploadedBy.nameEn}</>
                      )}
                      {' · '}
                      {formatDate(row.createdAt, locale)}
                    </span>
                  </span>
                </button>
                {canWrite && (
                  <button
                    aria-label={t('att.delete')}
                    title={t('att.delete')}
                    disabled={busy()}
                    onClick={() => onDelete(row)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Icon name="trash" className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {confirmNode}
    </div>
  );
}
