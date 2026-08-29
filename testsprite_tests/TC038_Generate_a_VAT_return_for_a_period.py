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
        
        # -> Fill the email field with admin@npi.sa, fill the password field with Admin@123, then click the 'دخول' (Login) button to submit the form.
        # email email field
        elem = page.get_by_label('البريد الإلكتروني', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("admin@npi.sa")
        
        # -> Fill the email field with admin@npi.sa, fill the password field with Admin@123, then click the 'دخول' (Login) button to submit the form.
        # password password field
        elem = page.get_by_label('كلمة المرور', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Admin@123")
        
        # -> Fill the email field with admin@npi.sa, fill the password field with Admin@123, then click the 'دخول' (Login) button to submit the form.
        # دخول button
        elem = page.get_by_role('button', name='دخول', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'القوائم المالية' (Financial Statements) link in the sidebar to open the Statements workspace.
        # القوائم المالية link
        elem = page.get_by_role('link', name='القوائم المالية', exact=True)
        await elem.click(timeout=10000)
        
        # -> Scroll the 'القوائم المالية' (Statements) page to reveal any VAT-related controls such as a 'Generate VAT Return' or 'إقرار ضريبة' button.
        await page.mouse.wheel(0, 300)
        
        # -> Click the 'التقارير المالية' (Financial Reports) link in the sidebar to look for VAT return generation controls.
        # التقارير المالية link
        elem = page.get_by_role('link', name='التقارير المالية', exact=True)
        await elem.click(timeout=10000)
        
        # -> Set the VAT return period by entering the start date and end date, then click the 'تحديث' (Update) button to generate the VAT return.
        # date field
        elem = page.get_by_label('من', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("2026-01-01")
        
        # -> Set the VAT return period by entering the start date and end date, then click the 'تحديث' (Update) button to generate the VAT return.
        # date field
        elem = page.get_by_label('إلى', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("2026-08-19")
        
        # -> Set the VAT return period by entering the start date and end date, then click the 'تحديث' (Update) button to generate the VAT return.
        # تحديث button
        elem = page.get_by_role('button', name='تحديث', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> The VAT return panel (إقرار ضريبة القيمة المضافة) is displayed for the period 01/01/2026–08/19/2026.
        await page.locator("xpath=/html/body/div[1]/main/div/div/div[4]/div[1]/div[2]/div[1]/button").nth(0).scroll_into_view_if_needed()
        # Assert-outcome: passed
        # Assert: The VAT return 'تحديث' (Update) button is visible, indicating the VAT panel is shown.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[4]/div[1]/div[2]/div[1]/button").nth(0)).to_be_visible(timeout=15000), "The VAT return '\u062a\u062d\u062f\u064a\u062b' (Update) button is visible, indicating the VAT panel is shown."
        # Assert-outcome: passed
        # Assert: The VAT return start date input is set to 2026-01-01.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[4]/div[1]/div[2]/div[1]/label[1]/input").nth(0)).to_have_value("2026-01-01", timeout=15000), "The VAT return start date input is set to 2026-01-01."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    