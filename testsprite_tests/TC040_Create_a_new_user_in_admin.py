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
        
        # -> Submit the login form by clicking the 'دخول' (Login) button after entering admin credentials.
        # email email field
        elem = page.get_by_label('البريد الإلكتروني', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("admin@npi.sa")
        
        # -> Submit the login form by clicking the 'دخول' (Login) button after entering admin credentials.
        # password password field
        elem = page.get_by_label('كلمة المرور', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Admin@123")
        
        # -> Submit the login form by clicking the 'دخول' (Login) button after entering admin credentials.
        # دخول button
        elem = page.get_by_role('button', name='دخول', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'المستخدمون والأدوار' (Users & Roles) link in the sidebar to open user and role management.
        # المستخدمون والأدوار link
        elem = page.get_by_role('link', name='المستخدمون والأدوار', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'مستخدم جديد' (New User) button to open the form for creating a new user.
        # مستخدم جديد button
        elem = page.get_by_role('button', name='مستخدم جديد', exact=True)
        await elem.click(timeout=10000)
        
        # -> Fill the new user form (Arabic name, EN name, البريد الإلكتروني, كلمة المرور) and open the 'الدور' (Role) dropdown so its options appear.
        # text field
        elem = page.get_by_label('الاسم (عربي)', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("\u0627\u062e\u062a\u0628\u0627\u0631 \u0645\u0633\u062a\u062e\u062f\u0645")
        
        # -> Fill the new user form (Arabic name, EN name, البريد الإلكتروني, كلمة المرور) and open the 'الدور' (Role) dropdown so its options appear.
        # text field
        elem = page.get_by_label('الاسم (EN — اختياري)', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Test User")
        
        # -> Fill the new user form (Arabic name, EN name, البريد الإلكتروني, كلمة المرور) and open the 'الدور' (Role) dropdown so its options appear.
        # email field
        elem = page.get_by_label('البريد الإلكتروني', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("new.user.test@npi.sa")
        
        # -> Fill the new user form (Arabic name, EN name, البريد الإلكتروني, كلمة المرور) and open the 'الدور' (Role) dropdown so its options appear.
        # text field
        elem = page.get_by_label('كلمة المرور', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("TestPass123!")
        
        # -> Fill the new user form (Arabic name, EN name, البريد الإلكتروني, كلمة المرور) and open the 'الدور' (Role) dropdown so its options appear.
        # مدير النظام مندوب مبيعات محاسب مدير مشاريع مهندس... dropdown
        elem = page.get_by_label('الدور', exact=True)
        await elem.click(timeout=10000)
        
        # -> Select 'محاسب' from the 'الدور' dropdown in the New User form so the role is assigned.
        # مدير النظام مندوب مبيعات محاسب مدير مشاريع مهندس... dropdown
        elem = page.locator("xpath=/html/body/div/main/div/div/div[4]/div/form/div[4]/select").nth(0)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.select_option("")
        
        # -> Click the 'إنشاء' (Create) button to save the new user and then verify the new user appears in the users list.
        # إنشاء button
        elem = page.get_by_role('button', name='إنشاء', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> New user 'اختبار مستخدم' (new.user.test@npi.sa) with role 'محاسب' appears in the users list.
        # Assert-outcome: passed
        # Assert: User email cell equals 'new.user.test@npi.sa'.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[3]/table/tbody/tr[7]/td[2]").nth(0)).to_have_text("new.user.test@npi.sa", timeout=15000), "User email cell equals 'new.user.test@npi.sa'."
        # Assert-outcome: passed
        # Assert: User role cell equals 'محاسب'.
        await expect(page.locator("xpath=/html/body/div[1]/main/div/div/div[3]/table/tbody/tr[7]/td[3]").nth(0)).to_have_text("\u0645\u062d\u0627\u0633\u0628", timeout=15000), "User role cell equals '\u0645\u062d\u0627\u0633\u0628'."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    