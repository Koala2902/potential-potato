import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

import { buildDatabaseUrl } from "../server/db/build-database-url.ts";
import {
  SWITCH_FLOW_DEFAULTS,
  SWITCH_FLOW_DEFAULTS_KEY,
} from "../server/scheduler/switch-flow-defaults.ts";

dotenv.config();
process.env.DATABASE_URL = buildDatabaseUrl();

const prisma = new PrismaClient();

async function main() {
  await prisma.timeEstimatorSettings.upsert({
    where: { key: SWITCH_FLOW_DEFAULTS_KEY },
    create: {
      key: SWITCH_FLOW_DEFAULTS_KEY,
      label: "Switch time_v1_sscript flow defaults (README v2.2)",
      flowProperties: SWITCH_FLOW_DEFAULTS,
    },
    update: {
      label: "Switch time_v1_sscript flow defaults (README v2.2)",
      flowProperties: SWITCH_FLOW_DEFAULTS,
    },
  });

  const indigo = await prisma.machine.upsert({
    where: { name: "hp_indigo_6900" },
    create: {
      name: "hp_indigo_6900",
      displayName: "HP Indigo 6900",
      sortOrder: 0,
      constants: {
        STEP_HEIGHT_MM: 980,
        MODE: 4,
        MAX_SPEED_M_PER_MIN: 60,
      },
    },
    update: {},
  });

  /** Calendar resource strip + production lines (internal names stable for workflows). */
  const calendarMachines = [
    { name: "digicon_line", displayName: "Digicon", sortOrder: 1 },
    { name: "digital_cutter", displayName: "Digital Cut", sortOrder: 2 },
    { name: "slitter_line", displayName: "Slitter", sortOrder: 3 },
  ] as const;
  for (const cm of calendarMachines) {
    await prisma.machine.upsert({
      where: { name: cm.name },
      create: {
        name: cm.name,
        displayName: cm.displayName,
        sortOrder: cm.sortOrder,
        constants: {},
      },
      update: { displayName: cm.displayName, sortOrder: cm.sortOrder },
    });
  }

  const printing = await prisma.operation.upsert({
    where: { id: "op001" },
    create: {
      id: "op001",
      machineId: indigo.id,
      name: "Printing",
      type: "production",
      sortOrder: 2,
      calcFnKey: "indigo_production_time",
    },
    update: {
      machineId: indigo.id,
      name: "Printing",
      type: "production",
      sortOrder: 2,
      calcFnKey: "indigo_production_time",
    },
  });

  const paramCount = await prisma.operationParam.count({
    where: { operationId: printing.id },
  });
  if (paramCount === 0) {
    await prisma.operationParam.createMany({
      data: [
        {
          operationId: printing.id,
          key: "step_height_mm",
          value: 980,
          valueType: "number",
          label: "Step height (mm)",
          isConfigurable: true,
          sortOrder: 0,
        },
        {
          operationId: printing.id,
          key: "mode",
          value: 4,
          valueType: "number",
          label: "Mode",
          isConfigurable: true,
          sortOrder: 1,
        },
        {
          operationId: printing.id,
          key: "max_speed_m_per_min",
          value: 60,
          valueType: "number",
          label: "Max speed (m/min)",
          isConfigurable: true,
          sortOrder: 2,
        },
      ],
    });
  }

  await prisma.batchRule.upsert({
    where: { operationId: printing.id },
    create: {
      operationId: printing.id,
      scope: "per_job",
      groupByFields: [],
      appliesOnce: false,
    },
    update: {},
  });

  console.log("Seed OK — scheduler machines (4 + Indigo op001)");
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
