const required = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`\n❌ Missing required environment variable: ${key}\n   Add it to your .env file.\n`);
  }
  return value;
};

const optional = (key: string, fallback = ''): string => {
  return process.env[key] || fallback;
};

export const env = {
  PORT:     parseInt(process.env.PORT || '5000', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',

  // Required — server won't start without these
  MONGODB_URI: required('MONGODB_URI'),
  JWT_SECRET:  required('JWT_SECRET'),
  JWT_EXPIRES_IN: optional('JWT_EXPIRES_IN', '7d'),

  // Optional — only needed for image uploads (profile pictures)
  CLOUDINARY_CLOUD_NAME: optional('CLOUDINARY_CLOUD_NAME'),
  CLOUDINARY_API_KEY:    optional('CLOUDINARY_API_KEY'),
  CLOUDINARY_API_SECRET: optional('CLOUDINARY_API_SECRET'),

  FRONTEND_URL: optional('FRONTEND_URL', 'http://localhost:3000'),
} as const;
