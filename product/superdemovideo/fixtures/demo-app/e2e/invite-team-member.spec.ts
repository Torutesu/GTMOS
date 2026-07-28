import { test, expect } from "@playwright/test";

test("invite a team member", async ({ page }) => {
  await page.goto("/settings/team");
  await page.getByLabel("Email address").fill("noor@northwind.design");
  await page.getByLabel("Role").selectOption("Editor");
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByText("Invitation sent to noor@northwind.design")).toBeVisible();
});
