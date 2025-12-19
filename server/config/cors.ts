export const corsOptions = {
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

export const getCorsHeaders = (origin?: string) => {
  const allowedOrigin = origin && corsOptions.origin.includes(origin) 
    ? origin 
    : corsOptions.origin;
  
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': corsOptions.methods.join(', '),
    'Access-Control-Allow-Headers': corsOptions.allowedHeaders.join(', '),
  };
};

