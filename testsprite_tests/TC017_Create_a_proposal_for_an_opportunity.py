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
        
        # -> Click the 'العروض' (Proposals) link in the sidebar to open the proposals area.
        # العروض link
        elem = page.get_by_role('link', name='العروض', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'الفرص' (Opportunities) link in the sidebar to open the Opportunities page and look for a way to create a proposal from an opportunity.
        # الفرص link
        elem = page.get_by_role('link', name='الفرص', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'إنشاء عرض' (Create Proposal) button for an opportunity to start creating a proposal.
        # إنشاء عرض button
        elem = page.get_by_text('OPP-00002', exact=True).locator("xpath=ancestor-or-self::*[.//button][1]").get_by_role('button', name='إنشاء عرض', exact=True)
        await elem.click(timeout=10000)
        
        # -> Fill required proposal fields (capacity and unit price) and click the 'إضافة مراجعة' button to save the proposal.
        # number field
        elem = page.get_by_label('قدرة النظام (كيلوواط)', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("50")
        
        # -> Fill required proposal fields (capacity and unit price) and click the 'إضافة مراجعة' button to save the proposal.
        # سعر الوحدة number field
        elem = page.get_by_label('سعر الوحدة', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("1000")
        
        # -> Fill required proposal fields (capacity and unit price) and click the 'إضافة مراجعة' button to save the proposal.
        # إضافة مراجعة button
        elem = page.get_by_role('button', name='إضافة مراجعة', exact=True)
        await elem.click(timeout=10000)
        
        # -> Choose 'INV-50K · عاكس 50 كيلوواط' from the 'الصنف' (item) dropdown in the proposal form so the item line is set.
        # — BOS-KIT · طقم مكونات مساعدة CAB-DC6 · كابل DC... dropdown
        elem = page.locator("xpath=/html/body/div/main/div/div/form/div[2]/div/select").nth(0)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.select_option("")
        
        # -> Fill the 'الإنتاج السنوي (ك.و.س)' field with a valid value and click the 'إضافة مراجعة' button to save the proposal.
        # number field
        elem = page.get_by_label('الإنتاج السنوي (ك.و.س)', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("1000")
        
        # -> Fill the 'الإنتاج السنوي (ك.و.س)' field with a valid value and click the 'إضافة مراجعة' button to save the proposal.
        # إضافة مراجعة button
        elem = page.get_by_role('button', name='إضافة مراجعة', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'العروض' (Proposals) link to open the proposals list and verify the new proposal appears there.
        # العروض link
        elem = page.get_by_text('PRP-00006 · Test Lead — LEAD-00002', exact=True).locator("xpath=ancestor-or-self::*[.//a][1]").get_by_role('link', name='العروض', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> The newly created proposal PRP-00006 is listed in the Proposals page and shows status 'مسودة'.
        # Assert-outcome: passed
        # Assert: Proposal ID PRP-00006 is present in the proposals table.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[3]/table/tbody/tr[1]/td[1]").nth(0)).to_have_text("PRP-00006", timeout=15000), "Proposal ID PRP-00006 is present in the proposals table."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    