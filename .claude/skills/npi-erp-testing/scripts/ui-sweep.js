/**
 * NPI Solar ERP — browser screen sweep.
 *
 * Paste into mcp__Claude_Browser__javascript_tool with the app already open
 * and authenticated (see SKILL.md §3 for the localStorage token step).
 *
 * Walks every sidebar link the current role can see and reports per screen.
 * Navigates by CLICKING the sidebar anchor: `history.pushState` plus a
 * `popstate` event does not move the Next App Router, and a sweep built on it
 * silently reports the same page N times, which reads as a clean pass.
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu;
  const LOAD_ERROR = /تعذّر تحميل|Failed to load/;

  const links = [...document.querySelectorAll('aside a[href^="/"]')].map((a) => a.getAttribute('href'));
  const visible = [...new Set(links)];

  /**
   * Wait for the route to actually land, then for its data to settle.
   *
   * A fixed sleep is wrong here: on a cold `.next` the dev server compiles each
   * route on first visit, which can take many seconds. The click registers but
   * `location.pathname` changes later, so a fixed wait samples the PREVIOUS
   * screen and reports its heading — every route looks like it failed to
   * navigate, and you go hunting for a routing bug that does not exist.
   */
  async function goto(href, budgetMs = 20000) {
    const a = [...document.querySelectorAll('aside a')].find((x) => x.getAttribute('href') === href);
    if (!a) return false;
    a.click();
    const deadline = Date.now() + budgetMs;
    while (location.pathname !== href && Date.now() < deadline) await sleep(150);
    if (location.pathname !== href) return false;
    // Arrived. Now let the page's own fetches resolve — the skeleton is gone
    // once a heading exists and no placeholder bars remain.
    const settleBy = Date.now() + 8000;
    while (Date.now() < settleBy) {
      const hasHeading = !!document.querySelector('h1');
      const stillLoading = document.querySelectorAll('.skeleton').length > 0;
      if (hasHeading && !stillLoading) break;
      await sleep(150);
    }
    return true;
  }

  const screens = [];
  for (const href of visible) {
    const arrived = await goto(href);
    if (!arrived) {
      screens.push({ href, arrived: false, heading: null, note: 'never navigated within budget' });
      continue;
    }

    const text = document.body.innerText;
    const namelessButtons = [...document.querySelectorAll('button')]
      .filter((b) => !b.innerText.trim() && !b.getAttribute('aria-label') && !b.getAttribute('title'))
      .map((b) => b.className.slice(0, 50));

    screens.push({
      href,
      arrived: true,
      heading: (document.querySelector('h1') || {}).innerText || null,
      icons: document.querySelectorAll('svg').length,
      emoji: (text.match(EMOJI) || []).join(''),
      loadErrorCard: LOAD_ERROR.test(text),
      hOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      namelessButtons,
    });
  }

  const problems = screens.filter(
    (s) => !s.arrived || !s.heading || s.emoji || s.loadErrorCard || s.hOverflow || s.namelessButtons.length,
  );

  return {
    role: (() => { try { return JSON.parse(atob(localStorage.getItem('npi_token').split('.')[1])).email; } catch { return 'unknown'; } })(),
    dir: document.documentElement.dir,
    screensVisited: screens.length,
    clean: problems.length === 0,
    problems,
    screens,
  };
})()
