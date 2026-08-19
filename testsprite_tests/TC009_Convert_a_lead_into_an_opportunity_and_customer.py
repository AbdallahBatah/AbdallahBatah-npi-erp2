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
        
        # -> Fill the email field with 'admin@npi.sa', fill the password field with 'Admin@123', then click the 'دخول' (Login) button.
        # email email field
        elem = page.get_by_label('البريد الإلكتروني', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("admin@npi.sa")
        
        # -> Fill the email field with 'admin@npi.sa', fill the password field with 'Admin@123', then click the 'دخول' (Login) button.
        # password password field
        elem = page.get_by_label('كلمة المرور', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Admin@123")
        
        # -> Fill the email field with 'admin@npi.sa', fill the password field with 'Admin@123', then click the 'دخول' (Login) button.
        # دخول button
        elem = page.get_by_role('button', name='دخول', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'العملاء المحتملون' (Leads) link in the left navigation to open the Leads page
        # العملاء المحتملون link
        elem = page.get_by_role('link', name='العملاء المحتملون', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'عميل محتمل جديد' (New Lead) button to open the lead creation form.
        # عميل محتمل جديد button
        elem = page.get_by_role('button', name='عميل محتمل جديد', exact=True)
        await elem.click(timeout=10000)
        
        # -> Fill the form fields 'اسم جهة الاتصال', 'الشركة', 'الهاتف', and 'البريد' and click the 'إنشاء' (Create) button to create the new lead.
        # contactName text field
        elem = page.get_by_label('اسم جهة الاتصال', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Sale Test")
        
        # -> Fill the form fields 'اسم جهة الاتصال', 'الشركة', 'الهاتف', and 'البريد' and click the 'إنشاء' (Create) button to create the new lead.
        # companyName text field
        elem = page.get_by_label('الشركة', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("AutoTest Co")
        
        # -> Fill the form fields 'اسم جهة الاتصال', 'الشركة', 'الهاتف', and 'البريد' and click the 'إنشاء' (Create) button to create the new lead.
        # phone text field
        elem = page.get_by_label('الهاتف', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("0501234567")
        
        # -> Fill the form fields 'اسم جهة الاتصال', 'الشركة', 'الهاتف', and 'البريد' and click the 'إنشاء' (Create) button to create the new lead.
        # email email field
        elem = page.get_by_label('البريد', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("lead@example.com")
        
        # -> Fill the form fields 'اسم جهة الاتصال', 'الشركة', 'الهاتف', and 'البريد' and click the 'إنشاء' (Create) button to create the new lead.
        # إنشاء button
        elem = page.get_by_role('button', name='إنشاء', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the lead 'Sale Test' (LEAD-00004) from the Leads list to view its details.
        # Sale Test
        elem = page.get_by_text('Sale Test', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'تحويل إلى فرصة' (Convert to Opportunity) button for the lead 'Sale Test' to start the conversion flow.
        # تحويل إلى فرصة button
        elem = page.get_by_text('LEAD-00004', exact=True).locator("xpath=ancestor-or-self::*[.//button][1]").get_by_role('button', name='تحويل إلى فرصة', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'تأكيد' (Confirm) button in the 'تحويل إلى عميل وفرصة' dialog to perform the conversion.
        # تأكيد button
        elem = page.get_by_role('button', name='تأكيد', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'العملاء' (Customers) link in the left navigation to open the Customers page and inspect the customer list.
        # العملاء link
        elem = page.get_by_role('link', name='العملاء', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> Customer 'AutoTest Co' appears in the Customers list.
        # Assert-outcome: passed
        # Assert: The customers table contains the company name AutoTest Co in the first row.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[3]/table/tbody/tr[1]/td[2]").nth(0)).to_have_text("AutoTest Co", timeout=15000), "The customers table contains the company name AutoTest Co in the first row."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    