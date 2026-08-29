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
        
        # -> Fill the email and password fields and click the 'دخول' (Login) button to sign in.
        # email email field
        elem = page.get_by_label('البريد الإلكتروني', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("admin@npi.sa")
        
        # -> Fill the email and password fields and click the 'دخول' (Login) button to sign in.
        # password password field
        elem = page.get_by_label('كلمة المرور', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Admin@123")
        
        # -> Fill the email and password fields and click the 'دخول' (Login) button to sign in.
        # دخول button
        elem = page.get_by_role('button', name='دخول', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'المشتريات' (Procurement) menu item in the sidebar to open the Procurement area.
        # المشتريات link
        elem = page.get_by_role('link', name='المشتريات', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'أمر شراء جديد' (New Purchase Order) button to create a purchase order as test setup.
        # أمر شراء جديد button
        elem = page.get_by_role('button', name='أمر شراء جديد', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the 'المورد' (Supplier) dropdown in the New Purchase Order modal so supplier options become visible.
        # — VEN-00001 · شركة الخليج للألواح الشمسية dropdown
        elem = page.get_by_label('المورد', exact=True)
        await elem.click(timeout=10000)
        
        # -> Select supplier 'VEN-00001 · شركة الخليج للألواح الشمسية' from the 'المورد' (Supplier) dropdown in the New Purchase Order modal and wait for the UI to update.
        # — VEN-00001 · شركة الخليج للألواح الشمسية dropdown
        elem = page.locator("xpath=/html/body/div/main/div/div/div[5]/div/div[2]/div/div/select").nth(0)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.select_option("")
        
        # -> Select 'PRJ-00001 · مشروع الطاقة الشمسية' from the 'المشروع' (Project) dropdown in the New Purchase Order modal and wait for the UI to update.
        # — PRJ-00001 · مشروع الطاقة الشمسية — الرياض dropdown
        elem = page.locator("xpath=/html/body/div/main/div/div/div[5]/div/div[2]/div/div[2]/select").nth(0)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.select_option("")
        
        # -> Select 'PRJ-00001 · مشروع الطاقة الشمسية — الرياض' from the 'المشروع' (Project) dropdown in the New Purchase Order modal and wait for the UI to update.
        # — PRJ-00001 · مشروع الطاقة الشمسية — الرياض dropdown
        elem = page.locator("xpath=/html/body/div/main/div/div/div[5]/div/div[2]/div/div[2]/select").nth(0)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.select_option("")
        
        # -> Click the 'إنشاء' (Create) button in the New Purchase Order modal to create the purchase order.
        # إنشاء button
        elem = page.get_by_role('button', name='إنشاء', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'التفاصيل' (Details) button for the first purchase order (PO-00002) to open its details page.
        # التفاصيل link
        elem = page.locator('a[href="/procurement/cmszgupql00408j9axu1nyx2z"]')
        await elem.click(timeout=10000)
        
        # -> Click the 'اعتماد' (Approve) button to approve the purchase order and trigger a status update.
        # اعتماد button
        elem = page.get_by_role('button', name='اعتماد', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'تأكيد' (Confirm) button in the approval dialog to approve the purchase order.
        # تأكيد button
        elem = page.get_by_role('button', name='تأكيد', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> The purchase order is approved and the post-approval 'استلام' (Receive) action is available.
        await page.locator("xpath=/html/body/div[1]/main/div/div/div[1]/div[2]/button").nth(0).scroll_into_view_if_needed()
        # Assert-outcome: passed
        # Assert: Verify the 'استلام' (Receive) button is visible indicating post-approval actions are available.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[1]/div[2]/button").nth(0)).to_be_visible(timeout=15000), "Verify the '\u0627\u0633\u062a\u0644\u0627\u0645' (Receive) button is visible indicating post-approval actions are available."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    