import { expect } from './expect.mjs';
import { observeAction } from '@srcplugins/atlassian-forge-test-framework/jira';

// A preview with work types reads every screen scheme on the site, which takes several seconds;
// the review step appears once every selected space's preview has returned.
const previewed = { timeout: 60000 };

/** Next reads each selected space's work types and opens the work types step. */
export async function nextStep(page) {
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Add Agent Prompts to screens', exact: true }),
  ).toBeVisible(previewed);
}

/**
 * Review changes previews every selected space without a current review and opens the review
 * step. When removing setup it previews from the first step.
 */
export async function reviewStep(page) {
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Changes', exact: true })).toBeVisible(previewed);
}

/** Goes from the first step to the review unchanged and returns a selected space's preview. */
export async function reviewConfiguration(page, target, unlink = false) {
  if (!unlink) await nextStep(page);
  const plan = await observeAction(
    page,
    'configuration-preview',
    () => page.getByRole('button', { name: 'Review changes', exact: true }).click(),
    target,
  );
  await expect(page.getByRole('heading', { name: 'Changes', exact: true })).toBeVisible(previewed);
  return plan;
}

/**
 * On the work types step, adds one work type to a space's picker, or without a name removes the
 * last chosen one. Either clears that space's review, so Review changes previews it again.
 */
export async function chooseScreenTypes(page, key, name) {
  await page.getByRole('combobox', { name: new RegExp(`^Work types for ${key} — `) }).click();
  if (name) await page.getByRole('option', { name, exact: true }).click();
  else await page.keyboard.press('Backspace');
  // Escape would close the modal once the menu has closed; clicking the heading only blurs the picker.
  await page.getByRole('heading', { name: 'Add Agent Prompts to screens', exact: true }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
}
