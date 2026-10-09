'use client';

import { useEffect } from 'react';

/**
 * Marks `<html data-hydrated>` once React has hydrated the page (T-39b). The
 * screens now arrive with their content in the server's HTML, so a control is
 * visible before its handler exists; a click in that window is lost. The
 * browser tests wait for this attribute before they interact
 * (`e2e/fixtures/hydration.ts`). Renders nothing.
 */
export function HydrationMark() {
  useEffect(() => {
    document.documentElement.setAttribute('data-hydrated', '');
  }, []);
  return null;
}
