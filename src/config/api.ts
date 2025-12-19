// API Configuration
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const apiConfig = {
  baseURL: API_BASE_URL,
  endpoints: {
    jobs: `${API_BASE_URL}/api/jobs`,
    kanban: `${API_BASE_URL}/api/jobs/kanban-data`,
    scans: `${API_BASE_URL}/api/scans`,
    machineries: `${API_BASE_URL}/api/machineries`,
    operations: `${API_BASE_URL}/api/operations`,
  },
};

export default apiConfig;

