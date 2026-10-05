import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const shop = JSON.parse(readFileSync(new URL('../.state/shop.json', import.meta.url), 'utf8')) as {
  slug: string;
  username: string;
  password: string;
};
const LAND = new URL('../.state/land.xlsx', import.meta.url).pathname;

/** A Mantine Select: open it by its label (required ones end with " *"), then pick. */
async function pick(
  page: Page,
  label: string,
  option: string | RegExp,
  scope: Page | Locator = page,
) {
  // The label also names the dropdown's listbox; the input comes first.
  await scope
    .getByLabel(new RegExp(`^${label}\\s*\\*?$`))
    .first()
    .click();
  await page.getByRole('option', { name: option }).first().click();
}

test('owner imports a stock sheet; search ranks alternatives by grade, then price', async ({
  page,
}) => {
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto('/catalog/setup');
  await page.getByRole('textbox', { name: 'رمز المحل', exact: true }).fill(shop.slug);
  await page.getByRole('textbox', { name: 'اسم المستخدم', exact: true }).fill(shop.username);
  await page.getByRole('textbox', { name: 'كلمة المرور', exact: true }).fill(shop.password);
  await page.getByRole('button', { name: 'دخول' }).click();

  // A default selling price list in the shop's currency.
  await expect(page.getByRole('heading', { name: 'إعداد الكتالوج' })).toBeVisible();
  const lists = page.getByRole('tabpanel', { name: 'قوائم الأسعار' });
  await lists.getByLabel(/^الاسم/).fill('البيع');
  await pick(page, 'العملة', 'AAA', lists);
  await lists.getByRole('checkbox', { name: 'افتراضية' }).check();
  await lists.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.getByRole('cell', { name: 'البيع' })).toBeVisible();

  // Import: file, header row, columns.
  await page.getByRole('link', { name: 'استيراد الكتالوج' }).click();
  await page.locator('input[type=file]').setInputFiles(LAND);
  await page.getByRole('button', { name: 'قراءة الملف' }).click();
  await page.getByTestId('sheet-row-2').click();
  await page.getByRole('button', { name: 'التالي' }).click();
  await pick(page, 'رقم القطعة', 'A — Part');
  await pick(page, 'الاسم بالإنجليزية', 'B — Name EN');
  await pick(page, 'الاسم بالعربية', 'C — Name AR');
  await pick(page, 'رمز السيارة', 'D — Car');
  await pick(page, 'سعر البيع', 'E — Price');
  await pick(page, 'أرقام القطع في الملف هي', 'أرقام وكالة (OEM)');
  await pick(page, 'يذهب سعر البيع إلى قائمة', 'البيع (AAA)');
  await page.getByLabel(/^بادئة رمز الصنف/).fill('SKY');
  await page.getByRole('button', { name: 'فحص الصفوف' }).click();

  // Map the shop's vehicle code, then import.
  await expect(page.getByText('مسودة')).toBeVisible();
  await page.getByTestId('code-lc').getByRole('button', { name: 'ربط' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('ابحث عن سيارة').fill('لاندكروزر');
  await page
    .getByRole('option', { name: /Land Cruiser/ })
    .first()
    .click();
  await dialog.getByRole('button', { name: 'حفظ' }).click();
  await expect(page.getByText('تم الفحص', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'استيراد الآن' }).click();
  await expect(page.getByText('تم الاستيراد', { exact: true })).toBeVisible();

  // The salesperson's search: ungraded alternatives rank by price.
  const search = async () => {
    await page.getByRole('link', { name: 'البحث عن قطعة' }).click();
    await page.getByRole('textbox', { name: 'البحث عن قطعة' }).fill('فحمات امامية لاندكروزر 2015');
    await page.getByRole('button', { name: 'بحث' }).click();
    const first = page.getByTestId('search-result').first();
    await expect(first).toContainText('SKY-00001');
    return first.getByTestId('alternative');
  };
  let alternatives = await search();
  await expect(alternatives).toHaveCount(2);
  await expect(alternatives.nth(0)).toContainText('فحمات امامية اقتصادي');
  await expect(alternatives.nth(0)).toContainText('25.00 AAA');
  await expect(alternatives.nth(1)).toContainText('40.00 AAA');

  // Grade the trade pads from the "needs review" list: graded parts now rank first.
  await page.getByRole('link', { name: 'القطع', exact: true }).click();
  await page.getByText('بلا درجة جودة').click();
  await page.getByRole('checkbox', { name: 'SKY-00002' }).check();
  await pick(page, 'تحديد الجودة', 'جيد');
  await page.getByRole('button', { name: 'تطبيق على المحدد' }).click();
  await expect(page.getByRole('checkbox', { name: 'SKY-00002' })).toHaveCount(0);

  alternatives = await search();
  await expect(alternatives.nth(0)).toContainText('فحمات امامية تجاري');
  await expect(alternatives.nth(0)).toContainText('جيد');
  await expect(alternatives.nth(1)).toContainText('فحمات امامية اقتصادي');
});
