'use client';

/**
 * P5-2: the approvals inbox links an overrun by its own id; the overrun lives
 * on its project's execution page, so resolve and go there.
 */
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { translateError } from '@/lib/errors';
import { LoadError, PageSkeleton } from '@/components/ui';

export default function OverrunRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { locale } = useI18n();
  const [err, setErr] = useState('');
  useEffect(() => {
    api
      .get<{ projectId: string }>(`/projects/overruns/${id}`)
      .then((o) => router.replace(`/projects/${o.projectId}/execution`))
      .catch((e) => setErr(translateError(e, locale)));
  }, [id, router, locale]);
  if (err) return <LoadError message={err} onRetry={() => window.location.reload()} />;
  return <PageSkeleton stats={0} />;
}
