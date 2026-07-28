import { test as setup, expect } from "@playwright/test";

const STORAGE_STATE = "e2e/.auth/user.json";

/**
 * Sign in once and hand the session to every other spec. Without this each
 * test would re-enact the login, which is noise in both the suite and any
 * demo generated from it.
 */
setup("authenticate", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Work email").fill("rosa@northwind.design");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.context().storageState({ path: STORAGE_STATE });
});
