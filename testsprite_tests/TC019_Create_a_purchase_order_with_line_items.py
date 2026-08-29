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
        
        # -> Fill the 'البريد الإلكتروني' field with admin@npi.sa, fill the 'كلمة المرور' field with Admin@123, then click the 'دخول' button to sign in.
        # email email field
        elem = page.get_by_label('البريد الإلكتروني', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("admin@npi.sa")
        
        # -> Fill the 'البريد الإلكتروني' field with admin@npi.sa, fill the 'كلمة المرور' field with Admin@123, then click the 'دخول' button to sign in.
        # password password field
        elem = page.get_by_label('كلمة المرور', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Admin@123")
        
        # -> Fill the 'البريد الإلكتروني' field with admin@npi.sa, fill the 'كلمة المرور' field with Admin@123, then click the 'دخول' button to sign in.
        # دخول button
        elem = page.get_by_role('button', name='دخول', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'المشتريات' (Procurement) item in the side navigation to open the Procurement page.
        # المشتريات link
        elem = page.get_by_role('link', name='المشتريات', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'أمر شراء جديد' (New Purchase Order) button to open the purchase order creation form.
        # أمر شراء جديد button
        elem = page.get_by_role('button', name='أمر شراء جديد', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the 'المورد' (Vendor) dropdown in the New Purchase Order dialog so the vendor option list appears.
        # — VEN-00001 · شركة الخليج للألواح الشمسية dropdown
        elem = page.get_by_label('المورد', exact=True)
        await elem.click(timeout=10000)
        
        # -> Select the 'VEN-00001 · شركة الخليج للألواح الشمسية' option from the المورد (Vendor) dropdown in the New Purchase Order dialog.
        # — VEN-00001 · شركة الخليج للألواح الشمسية dropdown
        elem = page.locator("xpath=/html/body/div/main/div/div/div[5]/div/div[2]/div/div/select").nth(0)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.select_option("")
        
        # -> Select 'PRJ-00001 · مشروع الطاقة الشمس...' from the المشروع (Project) dropdown in the New Purchase Order dialog.
        # — PRJ-00001 · مشروع الطاقة الشمسية — الرياض dropdown
        elem = page.locator("xpath=/html/body/div/main/div/div/div[5]/div/div[2]/div/div[2]/select").nth(0)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.select_option("")
        
        # -> Select 'PRJ-00001 · مشروع الطاقة الشمسية — الرياض' from the 'المشروع' (Project) dropdown so the dialog shows the project selection.
        # — PRJ-00001 · مشروع الطاقة الشمسية — الرياض dropdown
        elem = page.locator("xpath=/html/body/div/main/div/div/div[5]/div/div[2]/div/div[2]/select").nth(0)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.select_option("")
        
        # -> Click the 'إنشاء' (Create) button to save the purchase order and open its detail view.
        # إنشاء button
        elem = page.get_by_role('button', name='إنشاء', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'التفاصيل' (Details) link for the purchase order PO-00001 to open its detail view and verify the detail page is displayed.
        # التفاصيل link
        elem = page.get_by_role('link', name='التفاصيل', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> The PO detail view shows the selected project PRJ-00001.
        # Assert-outcome: passed
        # Assert: Project link shows PRJ-00001.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[2]/div[1]/p[2]/a").nth(0)).to_have_text("PRJ-00001", timeout=15000), "Project link shows PRJ-00001."
        
        # --> The PO detail view lists the line item BOS-KIT in the items table.
        # Assert-outcome: passed
        # Assert: Items table contains the BOS-KIT line item.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[3]/table/tbody/tr/td[1]").nth(0)).to_contain_text("BOS-KIT", timeout=15000), "Items table contains the BOS-KIT line item."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    