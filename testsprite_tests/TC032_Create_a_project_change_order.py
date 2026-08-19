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
        
        # -> Fill the البريد الإلكتروني and كلمة المرور fields and click the 'دخول' button to submit the login form.
        # email email field
        elem = page.get_by_label('البريد الإلكتروني', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("admin@npi.sa")
        
        # -> Fill the البريد الإلكتروني and كلمة المرور fields and click the 'دخول' button to submit the login form.
        # password password field
        elem = page.get_by_label('كلمة المرور', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Admin@123")
        
        # -> Fill the البريد الإلكتروني and كلمة المرور fields and click the 'دخول' button to submit the login form.
        # دخول button
        elem = page.get_by_role('button', name='دخول', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'المشاريع' (Projects) link in the sidebar to open the Projects list page.
        # المشاريع link
        elem = page.get_by_role('link', name='المشاريع', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the project details by clicking the 'التفاصيل' (Details) link for project PRJ-00001.
        # التفاصيل link
        elem = page.get_by_role('link', name='التفاصيل', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'أوامر التغيير والمقاولون' (Change orders and contractors) tab to open the change orders section.
        # أوامر التغيير والمقاولون 2 button
        elem = page.get_by_role('button', name='أوامر التغيير والمقاولون 2', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'أمر تغيير' button to open the new change order form.
        # أمر تغيير button
        elem = page.get_by_role('button', name='أمر تغيير', exact=True)
        await elem.click(timeout=10000)
        
        # -> Fill the change order fields (Arabic description, English description, value, days) and open the 'عنصر WBS' dropdown.
        # text field
        elem = page.get_by_label('الوصف (ع)', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("\u0623\u0645\u0631 \u062a\u063a\u064a\u064a\u0631 \u0627\u062e\u062a\u0628\u0627\u0631\u064a - \u062a\u0648\u0633\u0639\u0629 \u0646\u0637\u0627\u0642 \u0627\u0644\u0623\u0639\u0645\u0627\u0644")
        
        # -> Fill the change order fields (Arabic description, English description, value, days) and open the 'عنصر WBS' dropdown.
        # text field
        elem = page.get_by_label('الوصف (EN — اختياري)', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Test change order - scope increase")
        
        # -> Fill the change order fields (Arabic description, English description, value, days) and open the 'عنصر WBS' dropdown.
        # number field
        elem = page.get_by_label('أثر القيمة (±)', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("1000")
        
        # -> Fill the change order fields (Arabic description, English description, value, days) and open the 'عنصر WBS' dropdown.
        # number field
        elem = page.get_by_label('أثر الجدول (يوم)', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("5")
        
        # -> Fill the change order fields (Arabic description, English description, value, days) and open the 'عنصر WBS' dropdown.
        # — INV · العواكس dropdown
        elem = page.get_by_label('عنصر WBS', exact=True)
        await elem.click(timeout=10000)
        
        # -> Select 'INV · العواكس' from the WBS dropdown in the change order form.
        # — INV · العواكس dropdown
        elem = page.locator("xpath=/html/body/div/main/div/div/div[7]/div/div[2]/div[5]/select").nth(0)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.select_option("")
        
        # -> Click the 'إنشاء' (Create) button in the change order dialog to submit the change order and then confirm the new change order appears in the project's change orders list.
        # إنشاء button
        elem = page.get_by_role('button', name='إنشاء', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> A new change order appears in the project's Change Orders list with the entered Arabic description and the entered value.
        # Assert-outcome: passed
        # Assert: The change order description matches the Arabic description entered in the form.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[5]/table/tbody/tr[1]/td[2]").nth(0)).to_have_text("\u0623\u0645\u0631 \u062a\u063a\u064a\u064a\u0631 \u0627\u062e\u062a\u0628\u0627\u0631\u064a - \u062a\u0648\u0633\u0639\u0629 \u0646\u0637\u0627\u0642 \u0627\u0644\u0623\u0639\u0645\u0627\u0644", timeout=15000), "The change order description matches the Arabic description entered in the form."
        # Assert-outcome: passed
        # Assert: The change order value displayed reflects the amount entered (1000).
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[5]/table/tbody/tr[1]/td[3]").nth(0)).to_contain_text("\u200f1,000.00", timeout=15000), "The change order value displayed reflects the amount entered (1000)."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    