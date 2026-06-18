/** Quick check: Bladerunner cutter live → digital_cutter printbeat_live. */
import dotenv from "dotenv";
dotenv.config();

import {
    enrichProductionStatusWithSourceTables,
    getCachedDigitalCutterMachineId,
} from "../server/db/status-updates.js";

async function main() {
    const id = await getCachedDigitalCutterMachineId();
    if (!id) {
        console.error("No scheduler.Machine digital_cutter");
        process.exit(2);
    }
    const grouped = { [id]: { machine_id: id, completed: [], processing: [] } };
    await enrichProductionStatusWithSourceTables(grouped as never);
    console.log(JSON.stringify(grouped[id]?.printbeat_live, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
