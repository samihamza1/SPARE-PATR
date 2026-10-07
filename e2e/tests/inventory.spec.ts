import { readFileSync } from 'node:fs';
import { newId } from '@autoparts/shared';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const shop = JSON.parse(readFileSync(new URL('../.state/shop.json', import.meta.url), 'utf8')) as {
  slug: string;
  username: string;
  password: string;
};
const STOCK = readFileSync(new URL('../.state/stock.xlsx', import.meta.url));

/** A Mantine Select: open it by its label (required ones end with " *"), then pick. */
async function pick(
  page: Page,
  label: string,
  option: string | RegExp,
  scope: Page | Locator = page,
) {
  await scope
    .getByLabel(new RegExp(`^${label}\\s*\\*?$`))
    .first()
    .click();
  await page.getByRole('option', { name: option }).first().click();
}

/** The API as the signed-in user (same session cookie), for setup the UI tests elsewhere. */
async function api(page: Page, method: string, path: string, data: unknown) {
  const origin = new URL(page.url()).origin;
  const res = await page.request.fetch(`/api${path}`, { method, data, headers: { origin } });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as { id: string };
}

test('opening stock, a storeroom, a transfer and a count; search shows each location', async ({
  page,
}) => {
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto('/fx-rates');
  await page.getByRole('textbox', { name: 'رمز المحل', exact: true }).fill(shop.slug);
  await page.getByRole('textbox', { name: 'اسم المستخدم', exact: true }).fill(shop.username);
  await page.getByRole('textbox', { name: 'كلمة المرور', exact: true }).fill(shop.password);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page.getByRole('heading', { name: 'أسعار الصرف' })).toBeVisible();

  // Setup through the API (the import wizard has its own journey): a second currency and
  // the stock sheet, imported with its cost and quantity columns.
  await api(page, 'POST', '/currencies', { id: newId(), code: 'BBB', minorUnits: 3 });
  const batch = await api(page, 'POST', '/catalog/imports', {
    id: newId(),
    fileName: 'stock.xlsx',
    contentBase64: STOCK.toString('base64'),
    sheet: 'STOCK',
    headerRow: 1,
    mapping: {
      columns: { partNumber: 0, nameEn: 1, cost: 2, quantity: 3 },
      numberKind: 'oem',
      costCurrency: 'BBB',
      skuPrefix: 'OPN',
    },
  });
  await api(page, 'POST', `/catalog/imports/${batch.id}/apply`, {});

  // 1. Today's rate, entered as the market quotes it.
  await page.reload();
  await pick(page, 'عملة التسعير', 'BBB');
  await page.getByRole('textbox', { name: 'السعر', exact: true }).fill('3.6725');
  await page.getByRole('button', { name: 'حفظ السعر' }).click();
  await expect(page.getByRole('cell', { name: '1 AAA = 3.6725 BBB' }).first()).toBeVisible();

  // 2. Opening stock from the import: one line needs a cost, then it is posted.
  await page.getByRole('link', { name: 'الرصيد الافتتاحي' }).click();
  await pick(page, 'استيراد مطبَّق', 'stock.xlsx (STOCK)');
  await page.getByRole('button', { name: 'ابدأ' }).click();
  await expect(page.getByText('1 AAA = 3.6725 BBB')).toBeVisible();
  await expect(page.getByRole('button', { name: 'ترحيل الرصيد الافتتاحي' })).toBeDisabled();
  await page.getByRole('tab', { name: 'يحتاج تكلفة (1)' }).click();
  await page.getByRole('textbox', { name: 'تكلفة الوحدة بـ BBB' }).fill('18.3625');
  await page.getByRole('button', { name: 'حفظ' }).click();
  await expect(page.getByRole('tab', { name: 'يحتاج تكلفة (0)' })).toBeVisible();
  await page.getByRole('button', { name: 'ترحيل الرصيد الافتتاحي' }).click();
  await expect(page.getByText('مرحَّل')).toBeVisible();

  // 3. A storeroom next to the shop.
  await page.getByRole('link', { name: 'المواقع' }).click();
  await page.getByLabel(/^الاسم/).fill('المخزن');
  await pick(page, 'النوع', 'مخزن أو مستودع');
  await page.getByRole('button', { name: 'إضافة موقع' }).click();
  await expect(page.getByRole('cell', { name: 'المخزن' })).toBeVisible();

  // 4. One brake disc moves to the storeroom.
  await page.getByRole('link', { name: 'نقل المخزون' }).click();
  await pick(page, 'من', 'المحل');
  await pick(page, 'إلى', 'المخزن');
  await page
    .getByLabel(/^إضافة قطعة/)
    .first()
    .fill('Brake disc');
  await page.getByRole('option', { name: /Brake disc/ }).click();
  await page.getByRole('button', { name: 'ترحيل النقل' }).click();
  await expect(page.getByRole('status')).toContainText('رُحِّل');

  // 5. A blind count of the storeroom finds one more disc; the owner approves it.
  await page.getByRole('link', { name: 'الجرد' }).click();
  await pick(page, 'الموقع', 'المخزن');
  await pick(page, 'ما يُجرد', 'كل ما فيه رصيد');
  await page.getByRole('button', { name: 'فتح جرد' }).click();
  const counted = page.getByRole('textbox', { name: /^الكمية المعدودة من / });
  await counted.fill('2');
  await counted.blur();
  await expect(page.getByText('حُفظ')).toBeVisible();
  await page.getByRole('button', { name: 'اعتماد وترحيل الفروق' }).click();
  await expect(page.getByText('معتمَد')).toBeVisible();

  // 6. Search shows where the discs are: 2 in the shop, 2 in the storeroom.
  await page.getByRole('link', { name: 'البحث عن قطعة' }).click();
  await page.getByRole('textbox', { name: 'البحث عن قطعة' }).fill('Brake disc');
  await page.getByRole('button', { name: 'بحث' }).click();
  const result = page.getByTestId('search-result').first();
  await expect(result).toContainText('المحل: 2');
  await expect(result).toContainText('المخزن: 2');
});
