import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const shop = JSON.parse(readFileSync(new URL('../.state/shop.json', import.meta.url), 'utf8')) as {
  slug: string;
  username: string;
  password: string;
};

async function signIn(page: Page, username: string, password: string) {
  await page.getByRole('textbox', { name: 'رمز المحل', exact: true }).fill(shop.slug);
  await page.getByRole('textbox', { name: 'اسم المستخدم', exact: true }).fill(username);
  await page.getByRole('textbox', { name: 'كلمة المرور', exact: true }).fill(password);
  await page.getByRole('button', { name: 'دخول' }).click();
}

test('owner sets up a cashier, who sees only what a cashier may see', async ({ page }) => {
  // Arabic, right-to-left, sign-in page for anonymous visitors.
  await page.goto('/users');
  await expect(page.getByRole('heading', { name: 'تسجيل الدخول' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  // A wrong password gets the translated, non-revealing error.
  await signIn(page, shop.username, 'not the password');
  await expect(page.getByRole('alert')).toContainText(
    'رمز المحل أو اسم المستخدم أو كلمة المرور غير صحيح',
  );

  // The owner signs in and lands on the page they asked for.
  await signIn(page, shop.username, shop.password);
  await expect(page.getByRole('heading', { name: 'المستخدمون' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'مالك المتجر' })).toBeVisible();

  // Create a cashier and grant the cashier role.
  await page.getByRole('button', { name: 'مستخدم جديد' }).click();
  const create = page.getByRole('dialog');
  await create.getByRole('textbox', { name: 'اسم المستخدم', exact: true }).fill('cash1');
  await create.getByRole('textbox', { name: 'الاسم الظاهر', exact: true }).fill('كاشير أول');
  await create
    .getByRole('textbox', { name: 'كلمة المرور', exact: true })
    .fill('cashier passphrase 1');
  await create.getByRole('button', { name: 'حفظ' }).click();
  const row = page.getByRole('row', { name: /cash1/ });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'الأدوار' }).click();
  await page.getByRole('dialog').getByRole('checkbox', { name: 'الكاشير' }).check();
  await expect(row.getByText('الكاشير')).toBeVisible();
  await page.keyboard.press('Escape');

  // The change is in the audit log.
  await page.getByRole('link', { name: 'سجل التدقيق' }).click();
  await expect(page.getByRole('cell', { name: 'منح دور' }).first()).toBeVisible();

  // Sign out; the cashier signs in (shop code is remembered).
  await page.getByRole('button', { name: 'خروج' }).click();
  await expect(page.getByRole('textbox', { name: 'رمز المحل', exact: true })).toHaveValue(
    shop.slug,
  );
  await page.getByRole('textbox', { name: 'اسم المستخدم', exact: true }).fill('cash1');
  await page
    .getByRole('textbox', { name: 'كلمة المرور', exact: true })
    .fill('cashier passphrase 1');
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page.getByRole('heading', { name: 'أهلاً كاشير أول' })).toBeVisible();

  const nav = page.getByRole('navigation', { name: 'القائمة' });
  // Catalog pages are readable by everyone; import and admin pages are not offered. A
  // cashier sees stock in every location (without cost), takes part in counts, and sees
  // the locations and exchange rates (product owner, 2026-10-06).
  await expect(nav.getByRole('link')).toHaveText([
    'الرئيسية',
    'البحث عن قطعة',
    'القطع',
    'السيارات',
    'إعداد الكتالوج',
    'المخزون',
    'الجرد',
    'المواقع',
    'أسعار الصرف',
    'الأدوار والصلاحيات',
  ]);

  // Opening an admin page directly is refused (and the API refuses the data).
  await page.goto('/users');
  await expect(page.getByRole('alert')).toContainText('ليست لديك صلاحية');

  // English is one click away and flips the layout.
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
});
