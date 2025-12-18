import { Machine, ScheduledJob } from '../types';

export const mockMachines: Machine[] = [
    { id: 'M1', name: 'Digital Press 1', code: 'DP-001', type: 'Digital', status: 'active' },
    { id: 'M2', name: 'Digital Press 2', code: 'DP-002', type: 'Digital', status: 'active' },
    { id: 'M3', name: 'Offset Press Alpha', code: 'OP-001', type: 'Offset', status: 'active' },
    { id: 'M4', name: 'Offset Press Beta', code: 'OP-002', type: 'Offset', status: 'active' },
    { id: 'M5', name: 'Finishing Line 1', code: 'FL-001', type: 'Finishing', status: 'active' },
    { id: 'M6', name: 'Finishing Line 2', code: 'FL-002', type: 'Finishing', status: 'maintenance' },
    { id: 'M7', name: 'Large Format Printer', code: 'LF-001', type: 'Large Format', status: 'active' },
    { id: 'M8', name: 'UV Coater', code: 'UV-001', type: 'Coating', status: 'active' },
];

// Generate scheduled jobs for the next 30 days
const today = new Date();
today.setHours(8, 0, 0, 0); // Start at 8 AM

export const mockScheduledJobs: ScheduledJob[] = [
    // Today's jobs
    {
        id: 'SJ1',
        jobId: '1',
        jobCode: 'JOB-2025-001',
        machineId: 'M1',
        startTime: new Date(today.getTime() + 0 * 60 * 60 * 1000).toISOString(), // 8:00 AM
        endTime: new Date(today.getTime() + 2 * 60 * 60 * 1000).toISOString(), // 10:00 AM
        status: 'completed',
        orderId: 'ORD-12345',
        ticketId: 'TKT-67890',
        qty: 500,
    },
    {
        id: 'SJ2',
        jobId: '2',
        jobCode: 'JOB-2025-002',
        machineId: 'M1',
        startTime: new Date(today.getTime() + 2.5 * 60 * 60 * 1000).toISOString(), // 10:30 AM
        endTime: new Date(today.getTime() + 4.5 * 60 * 60 * 1000).toISOString(), // 12:30 PM
        status: 'started',
        orderId: 'ORD-12346',
        ticketId: 'TKT-67891',
        qty: 1000,
    },
    {
        id: 'SJ3',
        jobId: '3',
        jobCode: 'JOB-2025-003',
        machineId: 'M2',
        startTime: new Date(today.getTime() + 0.5 * 60 * 60 * 1000).toISOString(), // 8:30 AM
        endTime: new Date(today.getTime() + 1.5 * 60 * 60 * 1000).toISOString(), // 9:30 AM
        status: 'completed',
        orderId: 'ORD-12347',
        ticketId: 'TKT-67892',
        qty: 250,
    },
    {
        id: 'SJ4',
        jobId: '4',
        jobCode: 'JOB-2025-004',
        machineId: 'M2',
        startTime: new Date(today.getTime() + 2 * 60 * 60 * 1000).toISOString(), // 10:00 AM
        endTime: new Date(today.getTime() + 4 * 60 * 60 * 1000).toISOString(), // 12:00 PM
        status: 'pending',
        orderId: 'ORD-12348',
        ticketId: 'TKT-67893',
        qty: 750,
    },
    {
        id: 'SJ5',
        jobId: '5',
        jobCode: 'JOB-2025-005',
        machineId: 'M3',
        startTime: new Date(today.getTime() + 1 * 60 * 60 * 1000).toISOString(), // 9:00 AM
        endTime: new Date(today.getTime() + 5 * 60 * 60 * 1000).toISOString(), // 1:00 PM
        status: 'started',
        orderId: 'ORD-12349',
        ticketId: 'TKT-67894',
        qty: 2000,
    },
    {
        id: 'SJ6',
        jobId: '6',
        jobCode: 'JOB-2025-006',
        machineId: 'M4',
        startTime: new Date(today.getTime() + 0 * 60 * 60 * 1000).toISOString(), // 8:00 AM
        endTime: new Date(today.getTime() + 3 * 60 * 60 * 1000).toISOString(), // 11:00 AM
        status: 'pending',
        orderId: 'ORD-12350',
        ticketId: 'TKT-67895',
        qty: 600,
    },
    {
        id: 'SJ7',
        jobId: '7',
        jobCode: 'JOB-2025-007',
        machineId: 'M5',
        startTime: new Date(today.getTime() + 3 * 60 * 60 * 1000).toISOString(), // 11:00 AM
        endTime: new Date(today.getTime() + 4.5 * 60 * 60 * 1000).toISOString(), // 12:30 PM
        status: 'pending',
        orderId: 'ORD-12351',
        ticketId: 'TKT-67896',
        qty: 300,
    },
    {
        id: 'SJ8',
        jobId: '8',
        jobCode: 'JOB-2025-008',
        machineId: 'M7',
        startTime: new Date(today.getTime() + 1.5 * 60 * 60 * 1000).toISOString(), // 9:30 AM
        endTime: new Date(today.getTime() + 3.5 * 60 * 60 * 1000).toISOString(), // 11:30 AM
        status: 'pending',
        orderId: 'ORD-12352',
        ticketId: 'TKT-67897',
        qty: 150,
    },
    // Tomorrow's jobs
    {
        id: 'SJ9',
        jobId: '9',
        jobCode: 'JOB-2025-009',
        machineId: 'M1',
        startTime: new Date(today.getTime() + 24 * 60 * 60 * 1000 + 0 * 60 * 60 * 1000).toISOString(),
        endTime: new Date(today.getTime() + 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000).toISOString(),
        status: 'pending',
        orderId: 'ORD-12353',
        ticketId: 'TKT-67898',
        qty: 800,
    },
    {
        id: 'SJ10',
        jobId: '10',
        jobCode: 'JOB-2025-010',
        machineId: 'M2',
        startTime: new Date(today.getTime() + 24 * 60 * 60 * 1000 + 1 * 60 * 60 * 1000).toISOString(),
        endTime: new Date(today.getTime() + 24 * 60 * 60 * 1000 + 4 * 60 * 60 * 1000).toISOString(),
        status: 'pending',
        orderId: 'ORD-12354',
        ticketId: 'TKT-67899',
        qty: 1200,
    },
    // Day after tomorrow
    {
        id: 'SJ11',
        jobId: '11',
        jobCode: 'JOB-2025-011',
        machineId: 'M3',
        startTime: new Date(today.getTime() + 48 * 60 * 60 * 1000 + 0 * 60 * 60 * 1000).toISOString(),
        endTime: new Date(today.getTime() + 48 * 60 * 60 * 1000 + 6 * 60 * 60 * 1000).toISOString(),
        status: 'pending',
        orderId: 'ORD-12355',
        ticketId: 'TKT-67900',
        qty: 2500,
    },
];

