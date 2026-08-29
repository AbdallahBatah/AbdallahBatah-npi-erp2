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
        
        # -> Fill the 'البريد الإلكتروني' field with admin@npi.sa, fill the 'كلمة المرور' field with Admin@123, then click the 'دخول' button to submit the login form.
        # email email field
        elem = page.get_by_label('البريد الإلكتروني', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("admin@npi.sa")
        
        # -> Fill the 'البريد الإلكتروني' field with admin@npi.sa, fill the 'كلمة المرور' field with Admin@123, then click the 'دخول' button to submit the login form.
        # password password field
        elem = page.get_by_label('كلمة المرور', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Admin@123")
        
        # -> Fill the 'البريد الإلكتروني' field with admin@npi.sa, fill the 'كلمة المرور' field with Admin@123, then click the 'دخول' button to submit the login form.
        # دخول button
        elem = page.get_by_role('button', name='دخول', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'القوائم المالية' (Financial Statements) link in the sidebar to open the Statements workspace.
        # القوائم المالية link
        elem = page.get_by_role('link', name='القوائم المالية', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the Income Statement panel's 'تصدير CSV' button to exercise/open the Income Statement report.
        # Download: تصدير CSV button
        elem = page.get_by_text('قائمة الدخل1 يناير 2026 — 19 أغسطس 2026', exact=True).locator("xpath=ancestor-or-self::*[.//button][1]").get_by_role('button', name='تصدير CSV', exact=True)
        async with page.expect_download(timeout=30000) as dl_info:
            await elem.click(timeout=10000)
        download = await dl_info.value
        assert download.suggested_filename  # verify file was downloaded
        await download.save_as(f"./downloads/{download.suggested_filename}")
        
        # -> Click the Income Statement panel's 'تصدير CSV' button to exercise/open the Income Statement report.
        # Download: تصدير CSV button
        elem = page.get_by_text('قائمة المركز المالي', exact=True).locator("xpath=ancestor-or-self::*[.//button][1]").get_by_role('button', name='تصدير CSV', exact=True)
        async with page.expect_download(timeout=30000) as dl_info:
            await elem.click(timeout=10000)
        download = await dl_info.value
        assert download.suggested_filename  # verify file was downloaded
        await download.save_as(f"./downloads/{download.suggested_filename}")
        
        # -> Click the 'تصدير CSV' button in the Balance Sheet (القائمة المركز المالي) panel to open/export the Balance Sheet report.
        # Download: تصدير CSV button
        elem = page.get_by_text('قائمة المركز المالي', exact=True).locator("xpath=ancestor-or-self::*[.//button][1]").get_by_role('button', name='تصدير CSV', exact=True)
        async with page.expect_download(timeout=30000) as dl_info:
            await elem.click(timeout=10000)
        download = await dl_info.value
        assert download.suggested_filename  # verify file was downloaded
        await download.save_as(f"./downloads/{download.suggested_filename}")
        
        # --> Assertions to verify final state
        
        # --> Income Statement panel is visible and shows the 'إيرادات المشاريع' row.
        # Assert-outcome: passed
        # Assert: Verifies the Income Statement includes an 'إيرادات المشاريع' row.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[3]/div[1]/table/tbody/tr[2]/td[1]").nth(0)).to_contain_text("\u0625\u064a\u0631\u0627\u062f\u0627\u062a \u0627\u0644\u0645\u0634\u0627\u0631\u064a\u0639", timeout=15000), "Verifies the Income Statement includes an '\u0625\u064a\u0631\u0627\u062f\u0627\u062a \u0627\u0644\u0645\u0634\u0627\u0631\u064a\u0639' row."
        
        # --> Balance Sheet panel is visible and shows 'القائمة متوازنة'.
        # Assert-outcome: passed
        # Assert: Verifies the Balance Sheet displays the 'القائمة متوازنة' text.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[3]/div[2]/table/tbody/tr[10]/td").nth(0)).to_have_text("\u0627\u0644\u0642\u0627\u0626\u0645\u0629 \u0645\u062a\u0648\u0627\u0632\u0646\u0629", timeout=15000), "Verifies the Balance Sheet displays the '\u0627\u0644\u0642\u0627\u0626\u0645\u0629 \u0645\u062a\u0648\u0627\u0632\u0646\u0629' text."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    