import { Skeleton } from '@/components/ui/States';
import { SummaryTile } from '@/components/SummaryTile';
import { loadHomeTiles, type HomeNpi, type TileKey } from '@/queries/home';
import type { ArKey } from '@/i18n/ar';

const TILE_ORDER: ReadonlyArray<{ key: TileKey; titleKey: ArKey; npiPath: string }> = [
  { key: 'inbox', titleKey: 'home.tile.inbox', npiPath: '/inbox' },
  { key: 'contracts_draft', titleKey: 'home.tile.contracts_draft', npiPath: '/contracts' },
  { key: 'pr_pending', titleKey: 'home.tile.pr_pending', npiPath: '/requisitions' },
  { key: 'bills_unmatched', titleKey: 'home.tile.bills_unmatched', npiPath: '/payables' },
];

/** Four skeleton tiles — the `<Suspense>` fallback while `HomeTilesGrid`
 *  reads NPI, so the rest of the page (the chat) is usable immediately. */
export function HomeTilesSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {TILE_ORDER.map(({ key }) => (
        <div key={key} className="rounded-xl bg-white p-4 shadow-card">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-2 h-7 w-12" />
        </div>
      ))}
    </div>
  );
}

/** Async server component: reads the four tiles (in parallel, each isolated —
 *  see `src/queries/home.ts`) and renders them. Meant to sit inside a
 *  `<Suspense fallback={<HomeTilesSkeleton />}>` boundary. */
export async function HomeTilesGrid({ npi }: { npi: HomeNpi }) {
  const tiles = await loadHomeTiles(npi);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {TILE_ORDER.map(({ key, titleKey, npiPath }) => (
        <SummaryTile key={key} titleKey={titleKey} npiPath={npiPath} state={tiles[key]} />
      ))}
    </div>
  );
}
