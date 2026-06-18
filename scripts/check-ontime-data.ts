/**
 * Spot-check on-time metrics (jobmanager due dates + logs production-done signals).
 * Run: npx tsx scripts/check-ontime-data.ts
 */
import dotenv from 'dotenv';
import { Pool } from 'pg';

import {
    computeOnTimeMetrics,
    fetchJobmanagerJobsForOnTime,
    fetchProductionDoneByLogsJobId,
} from '../server/db/analytics-ontime.js';
import { getLogsDatabaseUrl } from '../server/db/database-config.js';

dotenv.config();

async function main() {
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = new Date();

    const jmJobs = await fetchJobmanagerJobsForOnTime(from, to);
    const logs = new Pool({ connectionString: getLogsDatabaseUrl() });
    const client = await logs.connect();
    let metrics;
    try {
        const logsJobIds = [...new Set(jmJobs.map((j) => j.logsJobId))];
        const productionDone = await fetchProductionDoneByLogsJobId(client, logsJobIds);
        const businessDays = parseInt(process.argv[2] ?? '5', 10);
        metrics = computeOnTimeMetrics(jmJobs, productionDone, businessDays);
    } finally {
        client.release();
        await logs.end();
    }

    console.log(
        JSON.stringify(
            {
                businessDaysAllowance: metrics.businessDaysAllowance,
                jobsOrderedInRange: jmJobs.length,
                completedInDenominator: metrics.totalDue,
                onTime: metrics.onTime,
                late: metrics.late,
                onTimePercent: metrics.onTimePercent,
                lateJobsSample: metrics.jobs.filter((j) => j.status === 'late').slice(0, 3),
                note: 'Unfinished jobs excluded from denominator',
            },
            null,
            2
        )
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
