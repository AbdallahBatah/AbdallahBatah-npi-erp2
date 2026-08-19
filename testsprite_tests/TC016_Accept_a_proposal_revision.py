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
        
        # -> Fill the 'البريد الإلكتروني' and 'كلمة المرور' fields with admin@npi.sa and Admin@123, then click the 'دخول' button to submit the login form.
        # email email field
        elem = page.get_by_label('البريد الإلكتروني', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("admin@npi.sa")
        
        # -> Fill the 'البريد الإلكتروني' and 'كلمة المرور' fields with admin@npi.sa and Admin@123, then click the 'دخول' button to submit the login form.
        # password password field
        elem = page.get_by_label('كلمة المرور', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Admin@123")
        
        # -> Fill the 'البريد الإلكتروني' and 'كلمة المرور' fields with admin@npi.sa and Admin@123, then click the 'دخول' button to submit the login form.
        # دخول button
        elem = page.get_by_role('button', name='دخول', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'العروض' (Proposals) workspace link in the sidebar to open the proposals list.
        # العروض link
        elem = page.get_by_role('link', name='العروض', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the 'التفاصيل' (Details) for the draft proposal with code PRP-00003 to view and edit the proposal.
        # التفاصيل link
        elem = page.locator('a[href="/proposals/cmsz8c0sw0016yyx1mmj8crgi"]')
        await elem.click(timeout=10000)
        
        # -> Set the 'سعر الوحدة' (Unit price) field to 900 and click the 'إضافة مراجعة' (Add revision) button to submit the new revision.
        # سعر الوحدة number field
        elem = page.get_by_label('سعر الوحدة', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("900")
        
        # -> Set the 'سعر الوحدة' (Unit price) field to 900 and click the 'إضافة مراجعة' (Add revision) button to submit the new revision.
        # إضافة مراجعة button
        elem = page.get_by_role('button', name='إضافة مراجعة', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'اعتماد المراجعة' button to accept the newly added revision.
        # اعتماد المراجعة button
        elem = page.get_by_role('button', name='اعتماد المراجعة', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'تأكيد' (Confirm) button in the 'قبول مراجعة العرض' dialog to accept the revision.
        # تأكيد button
        elem = page.get_by_role('button', name='تأكيد', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> The accepted revision's unit price is shown in the proposal item row as '‏900.00 ر.س.‏'.
        # Assert-outcome: passed
        # Assert: Unit price in the item row equals '‏900.00 ر.س.‏'.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[2]/div/table/tbody/tr/td[3]").nth(0)).to_have_text("\u200f900.00\u00a0\u0631.\u0633.\u200f", timeout=15000), "Unit price in the item row equals '\u200f900.00\u00a0\u0631.\u0633.\u200f'."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    