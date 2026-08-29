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
        
        # -> Fill the 'البريد الإلكتروني' field with admin@npi.sa and the 'كلمة المرور' field with Admin@123, then click the 'دخول' button to sign in.
        # email email field
        elem = page.get_by_label('البريد الإلكتروني', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("admin@npi.sa")
        
        # -> Fill the 'البريد الإلكتروني' field with admin@npi.sa and the 'كلمة المرور' field with Admin@123, then click the 'دخول' button to sign in.
        # password password field
        elem = page.get_by_label('كلمة المرور', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Admin@123")
        
        # -> Fill the 'البريد الإلكتروني' field with admin@npi.sa and the 'كلمة المرور' field with Admin@123, then click the 'دخول' button to sign in.
        # دخول button
        elem = page.get_by_role('button', name='دخول', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'المشتريات' link in the sidebar to open the procurement section.
        # المشتريات link
        elem = page.get_by_role('link', name='المشتريات', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the 'التفاصيل' (Details) for the approved purchase order PO-00002.
        # التفاصيل link
        elem = page.locator('a[href="/procurement/cmszgupql00408j9axu1nyx2z"]')
        await elem.click(timeout=10000)
        
        # -> Click the 'استلام' (Receive) button to start recording a goods receipt for PO-00002.
        # استلام button
        elem = page.get_by_role('button', name='استلام', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'استلام' button in the GRN dialog to confirm the goods receipt.
        # استلام button
        elem = page.get_by_text('إلغاء', exact=True).locator("xpath=ancestor-or-self::*[.//button][1]").get_by_role('button', name='استلام', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the receipt entry labeled 'GRN-00001' in the 'الاستلامات' section to inspect receipt and stock details.
        # GRN-00001
        elem = page.get_by_text('GRN-00001', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> A goods receipt 'GRN-00001' is listed (dated 19 أغسطس 2026) and the PO shows received quantity 1.
        # Assert-outcome: passed
        # Assert: Receipt entry 'GRN-00001' is visible in the receipts table.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[4]/table/tbody/tr/td[1]").nth(0)).to_have_text("GRN-00001", timeout=15000), "Receipt entry 'GRN-00001' is visible in the receipts table."
        # Assert-outcome: passed
        # Assert: The PO item's 'المستلم' (received) column shows '1'.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[3]/table/tbody/tr/td[4]").nth(0)).to_have_text("1", timeout=15000), "The PO item's '\u0627\u0644\u0645\u0633\u062a\u0644\u0645' (received) column shows '1'."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    