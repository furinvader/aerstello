import type { Page } from '@playwright/test';

import { expect } from '../fixtures/test.ts';

export async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@aerstello.test');
  await page.getByLabel('Password').fill('AerstelloTest123!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app/);
}
