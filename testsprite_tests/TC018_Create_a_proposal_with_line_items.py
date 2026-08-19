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
        
        # -> Fill the email and password fields on the login form and click the 'دخول' (Login) button to sign in.
        # email email field
        elem = page.get_by_label('البريد الإلكتروني', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("admin@npi.sa")
        
        # -> Fill the email and password fields on the login form and click the 'دخول' (Login) button to sign in.
        # password password field
        elem = page.get_by_label('كلمة المرور', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Admin@123")
        
        # -> Fill the email and password fields on the login form and click the 'دخول' (Login) button to sign in.
        # دخول button
        elem = page.get_by_role('button', name='دخول', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'العروض' (Proposals) link in the sidebar to open the Proposals workspace.
        # العروض link
        elem = page.get_by_role('link', name='العروض', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'الفرص' (Opportunities) link in the sidebar to find an opportunity and create a proposal from it.
        # الفرص link
        elem = page.get_by_role('link', name='الفرص', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'إنشاء عرض' (Create Proposal) button on an opportunity row to start creating a proposal.
        # إنشاء عرض button
        elem = page.get_by_text('OPP-00002', exact=True).locator("xpath=ancestor-or-self::*[.//button][1]").get_by_role('button', name='إنشاء عرض', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the 'الصنف' dropdown in the 'قائمة المواد' (Items list) area so an item can be selected for the proposal line item.
        # — BOS-KIT · طقم مكونات مساعدة CAB-DC6 · كابل DC... dropdown
        elem = page.get_by_label('الصنف', exact=True)
        await elem.click(timeout=10000)
        
        # -> Select 'BOS-KIT · طقم مكونات مساعدة' from the 'الصنف' (Item) dropdown so dependent fields can update.
        # — BOS-KIT · طقم مكونات مساعدة CAB-DC6 · كابل DC... dropdown
        elem = page.locator("xpath=/html/body/div/main/div/div/form/div[2]/div/select").nth(0)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.select_option("")
        
        # -> Click the 'إضافة بند' button to add the selected line item, then click the 'إضافة مراجعة' button to save the proposal and open its detail page.
        # + إضافة بند button
        elem = page.get_by_role('button', name='+ إضافة بند', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'إضافة بند' button to add the selected line item, then click the 'إضافة مراجعة' button to save the proposal and open its detail page.
        # إضافة مراجعة button
        elem = page.get_by_role('button', name='إضافة مراجعة', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> The proposal detail page for the saved proposal is open.
        # Assert-outcome: passed
        # Assert: The URL contains '/proposals/' indicating the proposal detail page is open.
        await expect(page).to_have_url(re.compile("/proposals/"), timeout=15000), "The URL contains '/proposals/' indicating the proposal detail page is open."
        
        # --> The saved proposal shows the added line item 'BOS-KIT · طقم مكونات مساعدة' with quantity 1 and unit/row totals.
        # Assert-outcome: passed
        # Assert: The proposal's line item row shows the selected item, quantity 1, and the displayed totals.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[2]/div/table/tbody/tr").nth(0)).to_have_text("BOS-KIT\n \u00b7 \n\u0637\u0642\u0645 \u0645\u0643\u0648\u0646\u0627\u062a \u0645\u0633\u0627\u0639\u062f\u0629\n1\n\u200f900.00\u00a0\u0631.\u0633.\u200f\n\u200f900.00\u00a0\u0631.\u0633.\u200f", timeout=15000), "The proposal's line item row shows the selected item, quantity 1, and the displayed totals."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    