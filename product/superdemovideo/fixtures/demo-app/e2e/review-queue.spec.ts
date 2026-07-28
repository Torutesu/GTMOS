import { test, expect } from "@playwright/test";

test("see what is waiting in review", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("Migrate billing webhooks to the new endpoint")).toBeVisible();
});
