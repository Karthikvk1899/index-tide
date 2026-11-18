import { test, expect } from "@playwright/test";

test("a failed search stays visible until a successful retry", async ({
  page,
}) => {
  await page.route("**/api/v1/status", (route) =>
    route.fulfill({
      json: {
        tenant: "fixture",
        role: "reader",
        generations: [
          {
            gen: 1,
            active: 1,
            lag: "0",
            head: "1",
            checkpoint: "1",
            phase: "tail",
            mapping: 1,
          },
        ],
      },
    }),
  );
  let available = false;
  await page.route("**/api/v1/search?**", (route) =>
    available
      ? route.fulfill({ json: { generation: 1, items: [], next: null } })
      : route.fulfill({
          status: 503,
          json: { error: "Dependency unavailable" },
        }),
  );
  await page.goto("/");
  await page.getByLabel("Workspace key").fill("synthetic");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Dependency unavailable");
  available = true;
  await page.getByLabel("Search runbooks").fill("absent");
  await page.getByLabel("Search runbooks").press("Enter");
  await expect(
    page.getByText("No runbooks matched. Try a broader term."),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
