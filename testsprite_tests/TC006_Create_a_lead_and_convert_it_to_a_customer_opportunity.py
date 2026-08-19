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
        
        # -> Fill the 'البريد الإلكتروني' field with 'admin@npi.sa', fill the 'كلمة المرور' field with 'Admin@123', then click the 'دخول' button to submit the login form.
        # email email field
        elem = page.get_by_label('البريد الإلكتروني', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("admin@npi.sa")
        
        # -> Fill the 'البريد الإلكتروني' field with 'admin@npi.sa', fill the 'كلمة المرور' field with 'Admin@123', then click the 'دخول' button to submit the login form.
        # password password field
        elem = page.get_by_label('كلمة المرور', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Admin@123")
        
        # -> Fill the 'البريد الإلكتروني' field with 'admin@npi.sa', fill the 'كلمة المرور' field with 'Admin@123', then click the 'دخول' button to submit the login form.
        # دخول button
        elem = page.get_by_role('button', name='دخول', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the 'العملاء المحتملون' (Leads) page by clicking the 'العملاء المحتملون' link in the Sales menu.
        # العملاء المحتملون link
        elem = page.get_by_role('link', name='العملاء المحتملون', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'عميل محتمل جديد' (New Lead) button to open the create-lead form.
        # عميل محتمل جديد button
        elem = page.get_by_role('button', name='عميل محتمل جديد', exact=True)
        await elem.click(timeout=10000)
        
        # -> Fill the New Lead form (contact name, company, estimated capacity, phone, email) and click the 'إنشاء' (Create) button to create the lead.
        # contactName text field
        elem = page.get_by_label('اسم جهة الاتصال', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Test Contact AI")
        
        # -> Fill the New Lead form (contact name, company, estimated capacity, phone, email) and click the 'إنشاء' (Create) button to create the lead.
        # companyName text field
        elem = page.get_by_label('الشركة', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("ACME Solar")
        
        # -> Fill the New Lead form (contact name, company, estimated capacity, phone, email) and click the 'إنشاء' (Create) button to create the lead.
        # estimatedKwp number field
        elem = page.get_by_label('القدرة التقديرية (كيلوواط)', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("10")
        
        # -> Fill the New Lead form (contact name, company, estimated capacity, phone, email) and click the 'إنشاء' (Create) button to create the lead.
        # phone text field
        elem = page.get_by_label('الهاتف', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("0500000000")
        
        # -> Fill the New Lead form (contact name, company, estimated capacity, phone, email) and click the 'إنشاء' (Create) button to create the lead.
        # email email field
        elem = page.get_by_label('البريد', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("test.lead+ai@example.com")
        
        # -> Click the 'إنشاء' (Create) button in the New Lead dialog to submit the new lead form.
        # إنشاء button
        elem = page.get_by_role('button', name='إنشاء', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'تحويل إلى فرصة' (Convert to Opportunity) button for the 'Test Contact AI' lead and observe the conversion UI.
        # تحويل إلى فرصة button
        elem = page.get_by_role('button', name='تحويل إلى فرصة', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'تأكيد' (Confirm) button in the conversion dialog to convert the lead into a customer and opportunity.
        # تأكيد button
        elem = page.get_by_role('button', name='تأكيد', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'العملاء' (Customers) link in the sidebar to open the Customers page and verify that the new customer record exists.
        # العملاء link
        elem = page.get_by_role('link', name='العملاء', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'الفرص' (Opportunities) link in the sidebar to open the Opportunities page and verify that OPP-00003 is present.
        # الفرص link
        elem = page.get_by_role('link', name='الفرص', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'العملاء' (Customers) link in the sidebar to open the Customers page and verify that CUS-00003 (ACME Solar) exists.
        # العملاء link
        elem = page.get_by_role('link', name='العملاء', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'الفرص' (Opportunities) link in the sidebar and verify that the opportunity OPP-00003 — Test Contact AI appears in the opportunities list.
        # الفرص link
        elem = page.get_by_role('link', name='الفرص', exact=True)
        await elem.click(timeout=10000)
        
        # -> Verify that opportunity 'OPP-00003 — Test Contact AI' appears on the Opportunities page, then open the 'العملاء' (Customers) page to confirm CUS-00003 exists.
        # العملاء link
        elem = page.get_by_role('link', name='العملاء', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'الفرص' (Opportunities) link in the sidebar and verify that 'OPP-00003 — Test Contact AI' appears in the opportunities list.
        # الفرص link
        elem = page.get_by_role('link', name='الفرص', exact=True)
        await elem.click(timeout=10000)
        
        # -> Verify that 'OPP-00003 — Test Contact AI' appears in the opportunities list, then open the 'العملاء' (Customers) page to confirm the customer record.
        # العملاء link
        elem = page.get_by_role('link', name='العملاء', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'الفرص' (Opportunities) link in the sidebar to open the Opportunities page.
        # الفرص link
        elem = page.get_by_role('link', name='الفرص', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> The lead was converted: an opportunity row for the converted lead is visible and shows the customer/company 'ACME Solar' and opportunity name 'Test Contact AI — LEAD-00003'.
        await page.locator("xpath=/html/body/div[1]/main/div/div/div[3]/table/tbody/tr[2]").nth(0).scroll_into_view_if_needed()
        # Assert-outcome: passed
        # Assert: The opportunities table row for the converted lead is visible.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[3]/table/tbody/tr[2]").nth(0)).to_be_visible(timeout=15000), "The opportunities table row for the converted lead is visible."
        # Assert-outcome: passed
        # Assert: The opportunity's customer/company cell shows the company name 'ACME Solar'.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[3]/table/tbody/tr[2]/td[3]").nth(0)).to_have_text("ACME Solar", timeout=15000), "The opportunity's customer/company cell shows the company name 'ACME Solar'."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    