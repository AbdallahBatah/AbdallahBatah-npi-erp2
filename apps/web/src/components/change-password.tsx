'use client';

/** Self-service password change — the key button in the sidebar user card. */
import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { useToast } from '@/components/toast';
import { Modal } from '@/components/ui';
import { Icon } from '@/components/icons';

export function ChangePasswordButton() {
  const { t } = useI18n();
  const { act, busy } = useAct();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  function reset() {
    setCurrent('');
    setNext('');
    setConfirm('');
  }

  async function submit() {
    if (next !== confirm) {
      toast.error(t('pw.mismatch'));
      return;
    }
    const ok = await act(
      'changePw',
      () => api.post('/auth/change-password', { currentPassword: current, newPassword: next }),
      { success: t('pw.changed') },
    );
    if (ok) {
      reset();
      setOpen(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={t('pw.change')}
        aria-label={t('pw.change')}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-white/[0.06] hover:text-slate-200"
      >
        <Icon name="key" className="h-4 w-4" />
      </button>

      <Modal open={open} title={t('pw.change')} onClose={() => { reset(); setOpen(false); }}>
        <form
          className="grid gap-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            submit();
          }}
        >
          <label className="block">
            <span className="mb-1 block text-sm text-slate-600">{t('pw.current')}</span>
            <input
              type="password"
              className="input"
              required
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-slate-600">{t('pw.new')}</span>
            <input
              type="password"
              className="input"
              required
              minLength={8}
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-slate-600">{t('pw.confirm')}</span>
            <input
              type="password"
              className="input"
              required
              minLength={8}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => { reset(); setOpen(false); }}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn-primary" disabled={busy()}>
              {busy('changePw') ? t('common.loading') : t('pw.change')}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
