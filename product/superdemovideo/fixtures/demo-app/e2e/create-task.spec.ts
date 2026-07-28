import { test, expect } from "@playwright/test";

test("create a task", async ({ page }) => {
  await page.goto("/tasks/new");
  await page.getByLabel("Title").fill("Draft the Q3 launch brief");
  await page.getByLabel("Tag").fill("Launch");
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(page.getByText("created")).toBeVisible();
});
