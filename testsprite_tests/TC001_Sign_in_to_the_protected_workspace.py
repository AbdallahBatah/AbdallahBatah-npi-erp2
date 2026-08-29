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
        
        # -> Fill the 'البريد الإلكتروني' field with admin@npi.sa, fill the 'كلمة المرور' field with Admin@123, then click the 'دخول' button.
        # email email field
        elem = page.get_by_label('البريد الإلكتروني', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("admin@npi.sa")
        
        # -> Fill the 'البريد الإلكتروني' field with admin@npi.sa, fill the 'كلمة المرور' field with Admin@123, then click the 'دخول' button.
        # password password field
        elem = page.get_by_label('كلمة المرور', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Admin@123")
        
        # -> Fill the 'البريد الإلكتروني' field with admin@npi.sa, fill the 'كلمة المرور' field with Admin@123, then click the 'دخول' button.
        # دخول button
        elem = page.get_by_role('button', name='دخول', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> The dashboard page title 'لوحة المعلومات' is visible.
        # Assert-outcome: passed
        # Assert: Verifies the dashboard title 'لوحة المعلومات' is visible.
        await expect(page.locator("xpath=/html/body/div[1]/aside/nav/div[1]/div/a[1]").nth(0)).to_have_text("\u0644\u0648\u062d\u0629 \u0627\u0644\u0645\u0639\u0644\u0648\u0645\u0627\u062a", timeout=15000), "Verifies the dashboard title '\u0644\u0648\u062d\u0629 \u0627\u0644\u0645\u0639\u0644\u0648\u0645\u0627\u062a' is visible."
        
        # --> KPI content is visible on the dashboard (example: 'عملاء محتملون مفتوحون').
        # Assert-outcome: passed
        # Assert: Verifies a KPI card labeled 'عملاء محتملون مفتوحون' is visible.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[3]/a[1]").nth(0)).to_contain_text("\u0639\u0645\u0644\u0627\u0621 \u0645\u062d\u062a\u0645\u0644\u0648\u0646 \u0645\u0641\u062a\u0648\u062d\u0648\u0646", timeout=15000), "Verifies a KPI card labeled '\u0639\u0645\u0644\u0627\u0621 \u0645\u062d\u062a\u0645\u0644\u0648\u0646 \u0645\u0641\u062a\u0648\u062d\u0648\u0646' is visible."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    