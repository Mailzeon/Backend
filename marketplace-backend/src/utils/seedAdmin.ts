import { User } from '../models/User.model';

/**
 * Seeds one admin account on first run.
 * Credentials: admin@marketplace.com / admin123456
 * Change the password immediately via the admin panel after first login.
 */
export const seedAdminUser = async (): Promise<void> => {
  const exists = await User.findOne({ role: 'admin' });
  if (exists) return;

  await User.create({
    name: 'Admin',
    email: 'admin@marketplace.com',
    password: 'admin123456',
    role: 'admin',
    isApproved: true,
  });

  console.log('✅ Admin user seeded → email: admin@marketplace.com | password: admin123456');
  console.log('   ⚠️  Change this password after first login!');
};
