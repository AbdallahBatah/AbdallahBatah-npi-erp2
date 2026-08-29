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
        
        # -> Click the 'دخول' button to submit the login form and sign in as admin.
        # email email field
        elem = page.get_by_label('البريد الإلكتروني', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("admin@npi.sa")
        
        # -> Click the 'دخول' button to submit the login form and sign in as admin.
        # password password field
        elem = page.get_by_label('كلمة المرور', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Admin@123")
        
        # -> Click the 'دخول' button to submit the login form and sign in as admin.
        # دخول button
        elem = page.get_by_role('button', name='دخول', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'الاعتمادات' link in the side menu to open the approvals inbox.
        # الاعتمادات link
        elem = page.get_by_role('link', name='الاعتمادات', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'رفض' (Reject) button for CO-00002 to open the rejection dialog.
        # رفض button
        elem = page.get_by_text('CO-00002أمر تغيير', exact=True).locator("xpath=ancestor-or-self::*[.//button][1]").get_by_role('button', name='رفض', exact=True)
        await elem.click(timeout=10000)
        
        # -> Enter a rejection reason into the 'سبب الرفض' textarea and click the 'رفض' (Reject) button to submit the rejection.
        # text area
        elem = page.get_by_label('سبب الرفض', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("\u0627\u0644\u0645\u0628\u0644\u063a \u063a\u064a\u0631 \u0645\u0628\u0631\u0631\u060c \u064a\u0631\u062c\u0649 \u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u0628\u0646\u0648\u062f \u0648\u062a\u0642\u062f\u064a\u0645 \u062a\u0648\u0636\u064a\u062d \u062a\u0641\u0635\u064a\u0644\u064a \u0642\u0628\u0644 \u0625\u0639\u0627\u062f\u0629 \u0627\u0644\u0625\u0631\u0633\u0627\u0644.")
        
        # -> Enter a rejection reason into the 'سبب الرفض' textarea and click the 'رفض' (Reject) button to submit the rejection.
        # رفض button
        elem = page.get_by_text('إلغاء', exact=True).locator("xpath=ancestor-or-self::*[.//button][1]").get_by_role('button', name='رفض', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the 'السجل' (History) tab to view the approval record and confirm the rejection and its comment are recorded.
        # السجل button
        elem = page.get_by_role('button', name='السجل', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> CO-00002 is recorded as rejected in the approvals table.
        # Assert-outcome: passed
        # Assert: CO-00002 row status equals 'مرفوض'.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[3]/table/tbody/tr[2]/td[4]").nth(0)).to_have_text("\u0645\u0631\u0641\u0648\u0636", timeout=15000), "CO-00002 row status equals '\u0645\u0631\u0641\u0648\u0636'."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    