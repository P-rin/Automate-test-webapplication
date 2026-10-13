import { expect, test } from "@playwright/test";

const TARGET_URL = "http://localhost:5173/";
const EMAIL = "actprin3@gmail.com";
const PASSWORD = "act24070";

test.describe("Product catalog", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(TARGET_URL);

    await page.locator('input[type="email"]').fill(EMAIL);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.getByRole("button", { name: /login|sign in|เข้าสู่ระบบ/i }).click();

    await expect(page.getByText("Signed in as")).toBeVisible();
    await expect(page.getByText(EMAIL)).toBeVisible();

    await page.getByRole("button", { name: "Catalog" }).click();
    await expect(page.getByRole("heading", { name: "Product Catalog" })).toBeVisible();
  });

  test("shows the full inventory with product availability and pricing", async ({ page }) => {
    await expect(page.getByPlaceholder("ค้นหาสินค้าด้วยชื่อ...")).toBeVisible();
    await expect(page.getByRole("combobox")).toHaveValue("all");

    const products = page.locator("article");
    await expect(products).toHaveCount(8);

    const airPods = products.filter({ hasText: "AirPods Pro 2 USB-C" });
    await expect(airPods.getByRole("img", { name: "AirPods Pro 2 USB-C" })).toBeVisible();
    await expect(airPods.getByText("฿7,990")).toBeVisible();
    await expect(airPods.getByRole("button", { name: "เพิ่มลงตะกร้า" })).toBeEnabled();

    const unavailableChair = products.filter({ hasText: "ErgoFlex Pro Office Chair" });
    await expect(unavailableChair.getByText("คงเหลือ 0")).toBeVisible();
    await expect(unavailableChair.getByRole("button", { name: "สินค้าหมด" })).toBeDisabled();
  });

  test("filters products by name", async ({ page }) => {
    const products = page.locator("article");

    await page.getByPlaceholder("ค้นหาสินค้าด้วยชื่อ...").fill("Sony");
    await expect(products).toHaveCount(1);
    await expect(products.first()).toContainText("Sony WH-1000XM5");

    await page.getByPlaceholder("ค้นหาสินค้าด้วยชื่อ...").fill("not-a-product");
    await expect(products).toHaveCount(0);
  });

  for (const { category, expectedCount, productName } of [
    { category: "Electronics", expectedCount: 6, productName: "AirPods Pro 2 USB-C" },
    { category: "Furniture", expectedCount: 1, productName: "ErgoFlex Pro Office Chair" },
    { category: "Gaming", expectedCount: 1, productName: "Logitech G502 X" },
  ]) {
    test(`filters products by the ${category} category`, async ({ page }) => {
      const products = page.locator("article");

      await page.getByRole("combobox").selectOption(category);
      await expect(products).toHaveCount(expectedCount);
      await expect(products.first()).toContainText(productName);
    });
  }

  test("opens a product detail view and returns to the catalog", async ({ page }) => {
    await page.getByRole("button", { name: /^AirPods Pro 2 USB-C/ }).click();

    await expect(page.getByRole("heading", { name: "AirPods Pro 2 USB-C" })).toBeVisible();
    await expect(
      page.getByText("หูฟังไร้สายพร้อม ANC และโหมด Transparency"),
    ).toBeVisible();
    await expect(page.getByText("Specifications")).toBeVisible();
    await expect(page.getByText("Brand: Apple")).toBeVisible();
    await expect(page.getByText("Connectivity: Bluetooth 5.3")).toBeVisible();
    await expect(page.getByText("฿7,990")).toBeVisible();
    await expect(page.getByText("คงเหลือ 45 ชิ้น")).toBeVisible();
    await expect(page.getByRole("button", { name: "เพิ่มลงตะกร้า" })).toBeEnabled();

    await page.getByRole("button", { name: "← กลับไปหน้าสินค้า" }).click();
    await expect(page.getByRole("heading", { name: "Product Catalog" })).toBeVisible();
    await expect(page.locator("article")).toHaveCount(8);
  });
});
