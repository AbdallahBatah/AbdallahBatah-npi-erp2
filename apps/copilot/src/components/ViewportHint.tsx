'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * What the server believes about the viewport for the FIRST paint only
 * (T-39b, D-23). Since the screens render their content on the server, a
 * component that lays itself out by viewport width (`PreviewCard`'s line
 * table on desktop, stacked line cards on a phone) has to pick one layout
 * before any browser has said how wide it is; picking the phone layout for a
 * desktop meant five cards shrinking after hydration and everything under
 * them moving up by a viewport (a layout shift of 0.58 on `/copilot`).
 *
 * The hint is the request's `User-Agent` (`src/app/layout.tsx`): the `Mobile`
 * token every phone browser sends. It only chooses the first paint — the
 * component's own `matchMedia` subscription is the truth from hydration on,
 * so a wrong hint (a phone in landscape at 768 px and up, an unusual
 * browser) costs one re-layout, exactly what every desktop paid before.
 */
const ViewportHintContext = createContext<boolean>(false);

export function ViewportHintProvider({ isDesktop, children }: { isDesktop: boolean; children: ReactNode }) {
  return <ViewportHintContext.Provider value={isDesktop}>{children}</ViewportHintContext.Provider>;
}

/** The server's guess whether the viewport is at least 768 px wide. */
export function useServerDesktopHint(): boolean {
  return useContext(ViewportHintContext);
}
