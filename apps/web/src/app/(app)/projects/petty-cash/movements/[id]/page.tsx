'use client';

/** The approvals inbox links this document by its own id; resolve it and go to its page. */
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { translateError } from '@/lib/errors';
import { LoadError, PageSkeleton } from '@/components/ui';

export default function Redirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { locale } = useI18n();
  const [err, setErr] = useState('');
  useEffect(() => {
    api
      .get<Record<string, string>>(`/petty-cash/movements/${id}`)
      .then((r) => router.replace(`/projects/petty-cash/${r.custodyId}`))
      .catch((e) => setErr(translateError(e, locale)));
  }, [id, router, locale]);
  if (err) return <LoadError message={err} onRetry={() => window.location.reload()} />;
  return <PageSkeleton stats={0} />;
}
