import { test, expect } from "@playwright/test";

import { prisma } from "../server/db/prisma.ts";

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await prisma.$disconnect();
});

const minimalJobBody = {
  pdfQty: 1000,
  printColour: "cmyk",
  finishing: "none",
  productionPath: "indigo_only",
};

test.describe("Schedule UI → database", () => {
  test("POST job: manual job persists to scheduler.Job", async ({ request }) => {
    const material = `e2e_job_${Date.now()}`;

    const res = await request.post("/api/scheduler/jobs", {
      data: { ...minimalJobBody, material },
    });
    expect(res.ok()).toBeTruthy();

    const jobsRes = await request.get("/api/scheduler/jobs");
    expect(jobsRes.ok()).toBeTruthy();
    const jobs = (await jobsRes.json()) as Array<{ material: string; source: string }>;
    expect(jobs.find((j) => j.material === material)?.source).toBe("manual");

    const row = await prisma.job.findFirst({ where: { material } });
    expect(row).not.toBeNull();
    expect(row?.source).toBe("manual");
    expect(row?.pdfQty).toBe(1000);
  });

  test("Config: new machine persists to scheduler.Machine", async ({ page, request }) => {
    const name = `e2e_m_${Date.now()}`;
    const displayName = "E2E Machine";

    await page.goto("/");
    await page.getByTestId("nav-config").click();
    await expect(page.getByTestId("scheduler-config")).toBeVisible();
    await page.getByTestId("config-tab-machine").click();

    await page.getByTestId("config-add-machine-open").click();
    await page.getByTestId("config-new-machine-name").fill(name);
    await page.getByTestId("config-new-machine-display").fill(displayName);
    await page.getByTestId("config-new-machine-sort").fill("42");
    await page.getByTestId("config-save-machine").click();

    await expect(page.getByTestId("config-success")).toContainText("saved", { timeout: 20_000 });

    const apiRes = await request.get("/api/scheduler/config/machines");
    expect(apiRes.ok()).toBeTruthy();
    const machines = (await apiRes.json()) as Array<{ name: string; displayName: string }>;
    expect(machines.find((m) => m.name === name)?.displayName).toBe(displayName);

    const row = await prisma.machine.findUnique({ where: { name } });
    expect(row).not.toBeNull();
    expect(row?.displayName).toBe(displayName);
    expect(row?.sortOrder).toBe(42);
  });

  test("Calendar shows machine strip and lists job after POST", async ({ page, request }) => {
    const material = `e2e_cal_${Date.now()}`;

    const res = await request.post("/api/scheduler/jobs", {
      data: { ...minimalJobBody, material },
    });
    expect(res.ok()).toBeTruthy();

    await page.goto("/");
    await page.getByTestId("nav-schedule").click();

    await expect(page.getByTestId("scheduler-calendar-machines")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("scheduler-machine-select")).toBeVisible();

    await expect(page.getByText(material, { exact: false })).toBeVisible({ timeout: 15_000 });
  });
});
