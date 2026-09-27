import { t } from '@/i18n/ar';

export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="text-3xl font-bold text-slate-800">{t('app.name')}</h1>
    </main>
  );
}
