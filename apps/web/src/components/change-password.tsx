'use client';

/** Self-service password change — the key button in the sidebar user card. */
import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { useToast } from '@/components/toast';
import { Field, Modal } from '@/components/ui';
import { Icon } from '@/components/icons';
import { Btn } from '@/components/ui';

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

  const mismatch = confirm.length > 0 && next !== confirm;

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

      <Modal
        open={open}
        title={t('pw.change')}
        onClose={() => { reset(); setOpen(false); }}
        dirty={!!current || !!next || !!confirm}
      >
        <form
          className="grid gap-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            void submit();
          }}
        >
          <Field label={t('pw.current')}>
            <input
              type="password"
              className="input"
              required
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label={t('pw.new')}>
            <input
              type="password"
              className="input"
              required
              minLength={8}
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          {/* The mismatch belongs next to the field that is wrong, not in a
              toast that appears after you press Save. */}
          <Field label={t('pw.confirm')} error={mismatch ? t('pw.mismatch') : undefined}>
            <input
              type="password"
              className="input"
              required
              minLength={8}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => { reset(); setOpen(false); }}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('changePw')} disabled={busy()}>
              {t('pw.change')}
            </Btn>
          </div>
        </form>
      </Modal>
    </>
  );
}
