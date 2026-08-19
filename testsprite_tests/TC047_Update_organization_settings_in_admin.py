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
        
        # -> Fill 'admin@npi.sa' into the 'البريد الإلكتروني' (Email) field and 'Admin@123' into the 'كلمة المرور' (Password) field, then click the 'دخول' (Login) button.
        # email email field
        elem = page.get_by_label('البريد الإلكتروني', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("admin@npi.sa")
        
        # -> Fill 'admin@npi.sa' into the 'البريد الإلكتروني' (Email) field and 'Admin@123' into the 'كلمة المرور' (Password) field, then click the 'دخول' (Login) button.
        # password password field
        elem = page.get_by_label('كلمة المرور', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Admin@123")
        
        # -> Fill 'admin@npi.sa' into the 'البريد الإلكتروني' (Email) field and 'Admin@123' into the 'كلمة المرور' (Password) field, then click the 'دخول' (Login) button.
        # دخول button
        elem = page.get_by_role('button', name='دخول', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the admin/profile menu by clicking the 'مدير النظام' label in the bottom-right of the page.
        # م
        elem = page.get_by_text('م', exact=True)
        await elem.click(timeout=10000)
        
        # -> Scroll the sidebar/page and search for the 'معلومات المؤسسة' (Organization Information) link so the Organization settings page can be opened.
        await page.mouse.wheel(0, 300)
        
        # -> Reveal the side navigation items by scrolling the dashboard and search the page for 'معلومات المؤسسة' or related organization settings labels.
        await page.mouse.wheel(0, 300)
        
        # -> Click the 'المستخدمون والأدوار' (Users & Roles) link in the sidebar to open the admin workspace and look for organization settings.
        # المستخدمون والأدوار link
        elem = page.get_by_role('link', name='المستخدمون والأدوار', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'المنشأة' (Organization) button to open the Organization settings page.
        # المنشأة button
        elem = page.get_by_role('button', name='المنشأة', exact=True)
        await elem.click(timeout=10000)
        
        # -> Fill 'الرقم الضريبي' (Tax number) with '300000000000099', set the Arabic address to 'الرياض، المملكة العربية السعودية' and the English address to 'Riyadh, Saudi Arabia', then click the 'حفظ' (Save) button.
        # text field
        elem = page.get_by_label('الرقم الضريبي', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("300000000000099")
        
        # -> Fill 'الرقم الضريبي' (Tax number) with '300000000000099', set the Arabic address to 'الرياض، المملكة العربية السعودية' and the English address to 'Riyadh, Saudi Arabia', then click the 'حفظ' (Save) button.
        # text field
        elem = page.get_by_label('العنوان (عربي)', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("\u0627\u0644\u0631\u064a\u0627\u0636\u060c \u0627\u0644\u0645\u0645\u0644\u0643\u0629 \u0627\u0644\u0639\u0631\u0628\u064a\u0629 \u0627\u0644\u0633\u0639\u0648\u062f\u064a\u0629")
        
        # -> Fill 'الرقم الضريبي' (Tax number) with '300000000000099', set the Arabic address to 'الرياض، المملكة العربية السعودية' and the English address to 'Riyadh, Saudi Arabia', then click the 'حفظ' (Save) button.
        # text field
        elem = page.get_by_label('العنوان (إنجليزي)', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Riyadh, Saudi Arabia")
        
        # -> Fill 'الرقم الضريبي' (Tax number) with '300000000000099', set the Arabic address to 'الرياض، المملكة العربية السعودية' and the English address to 'Riyadh, Saudi Arabia', then click the 'حفظ' (Save) button.
        # حفظ button
        elem = page.get_by_role('button', name='حفظ', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> Organization settings form shows the saved tax number and both address fields.
        # Assert-outcome: passed
        # Assert: Tax number field contains the saved value '300000000000099'.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[3]/form/div[3]/div[1]/input").nth(0)).to_have_value("300000000000099", timeout=15000), "Tax number field contains the saved value '300000000000099'."
        # Assert-outcome: passed
        # Assert: Arabic address field contains the saved Arabic address.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[3]/form/div[4]/div[1]/input").nth(0)).to_have_value("\u0627\u0644\u0631\u064a\u0627\u0636\u060c \u0627\u0644\u0645\u0645\u0644\u0643\u0629 \u0627\u0644\u0639\u0631\u0628\u064a\u0629 \u0627\u0644\u0633\u0639\u0648\u062f\u064a\u0629", timeout=15000), "Arabic address field contains the saved Arabic address."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    