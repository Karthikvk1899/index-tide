import { expect, test } from "@playwright/test";
test("reader validates credentials, filters results, paginates and disconnects on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto("/");
  await page.getByLabel("Workspace key").fill("invalid");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("valid workspace key");
  await page.getByLabel("Workspace key").fill(process.env.READER_KEY!);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("article")).toHaveCount(12);
  await page.getByRole("button", { name: "Load more results" }).click();
  await expect(page.locator("article")).toHaveCount(24);
  await page.getByLabel("Search runbooks").fill("replica");
  await page.getByLabel("Search runbooks").press("Enter");
  await expect(page.locator("article")).toHaveCount(8);
  await expect(page.locator("article").first()).toContainText(
    "Replica recovery",
  );
  await page.getByRole("button", { name: "Index operations" }).click();
  await expect(
    page.getByRole("button", { name: "Audit first page" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByLabel("Workspace key")).toBeVisible();
});
test("operator rebuilds, activates and inspects consecutive audit pages", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Workspace key").fill(process.env.OPERATOR_KEY!);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Index operations" }).click();
  await page
    .getByRole("button", { name: "Build title-weighted index" })
    .click();
  const activate = page.getByRole("button", { name: /Activate generation/ });
  await expect(activate).toBeEnabled({ timeout: 15000 });
  await activate.click();
  await expect(activate).toHaveCount(0);
  await page.getByRole("button", { name: "Audit first page" }).click();
  await expect(page.getByRole("status")).toContainText(
    "32 checked · 0 differences",
  );
  await page.getByRole("button", { name: "Audit next page" }).click();
  await expect(page.getByRole("status")).toContainText("0 differences");
});
