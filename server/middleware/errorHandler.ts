import { getCorsHeaders } from '../config/cors.js';

export const createSuccessResponse = (
  data: any,
  statusCode: number = 200,
  origin?: string
): Response => {
  return new Response(JSON.stringify({
    success: true,
    data,
  }), {
    status: statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(origin),
    },
  });
};

export const createErrorResponse = (
  error: Error,
  statusCode: number = 500,
  origin?: string
): Response => {
  console.error('Error:', error);
  
  return new Response(JSON.stringify({
    success: false,
    error: error.message || 'Internal server error',
    timestamp: new Date().toISOString(),
  }), {
    status: statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(origin),
    },
  });
};

