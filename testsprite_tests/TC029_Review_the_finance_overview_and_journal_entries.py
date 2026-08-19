import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

async def run_test():
    pw = None
    browser = None
    context = None

    try:
        # Start a Playwright session in asynchronous mode
        pw = await async_api.async_playwright().start()

        # Launch a Chromium browser in headless mode with custom arguments
        browser = await pw.chromium.launch(
            headless=True,
            args=[
                "--window-size=1280,720",
                "--disable-dev-shm-usage",
                "--ipc=host",
                "--single-process"
            ],
        )

        # Create a new browser context (like an incognito window)
        context = await browser.new_context()
        # Wider default timeout to match the agent's DOM-stability budget;
        # auto-waiting Playwright APIs (expect, locator.wait_for) inherit this.
        context.set_default_timeout(15000)

        # Open a new page in the browser context
        page = await context.new_page()

        # Interact with the page elements to simulate user flow
        # -> navigate
        await page.goto("http://localhost:3000/")
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
        
        # -> Fill the email field with admin@npi.sa, fill the password field with Admin@123, then click the 'دخول' (Login) button to sign in.
        # email email field
        elem = page.get_by_label('البريد الإلكتروني', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("admin@npi.sa")
        
        # -> Fill the email field with admin@npi.sa, fill the password field with Admin@123, then click the 'دخول' (Login) button to sign in.
        # password password field
        elem = page.get_by_label('كلمة المرور', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Admin@123")
        
        # -> Fill the email field with admin@npi.sa, fill the password field with Admin@123, then click the 'دخول' (Login) button to sign in.
        # دخول button
        elem = page.get_by_role('button', name='دخول', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'دفتر الأستاذ' (Ledger) link in the Finance menu to open the finance/ledger workspace.
        # دفتر الأستاذ link
        elem = page.get_by_role('link', name='دفتر الأستاذ', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> Finance overview (Ledger) page is open.
        # Assert-outcome: passed
        # Assert: Page URL contains '/ledger'.
        await expect(page).to_have_url(re.compile("/ledger"), timeout=15000), "Page URL contains '/ledger'."
        
        # --> Ledger journal table is present and shows no entries.
        # Assert-outcome: passed
        # Assert: Ledger table displays 'لا توجد بيانات'.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[2]/table/tbody/tr/td").nth(0)).to_have_text("\u0644\u0627 \u062a\u0648\u062c\u062f \u0628\u064a\u0627\u0646\u0627\u062a", timeout=15000), "Ledger table displays '\u0644\u0627 \u062a\u0648\u062c\u062f \u0628\u064a\u0627\u0646\u0627\u062a'."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    