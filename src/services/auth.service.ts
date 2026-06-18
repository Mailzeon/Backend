import { User } from '../models/User.model';
import { Wallet } from '../models/Wallet.model';
import { WorkerLevelModel } from '../models/WorkerLevel.model';
import { signToken } from '../utils/jwt';
import { IUser, UserRole } from '../types';

interface RegisterInput {
  name: string;
  email: string;
  password: string;
  role: 'customer' | 'worker';
}

interface AuthResult {
  user: Partial<IUser>;
  token: string;
}

const throwHttpError = (message: string, statusCode: number): never => {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  throw err;
};

export const authService = {
  async register(input: RegisterInput): Promise<AuthResult> {
    const { name, email, password, role } = input;

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) throwHttpError('An account with this email already exists.', 409);

    const user = await User.create({ name: name.trim(), email, password, role });

    // Workers get a wallet and level record on registration
    if (role === 'worker') {
      await Promise.all([
        Wallet.create({ userId: user._id }),
        WorkerLevelModel.create({ workerId: user._id }),
      ]);
    }

    const token = signToken(user._id, user.role as UserRole);
    return { user: user.toJSON(), token };
  },

  async login(email: string, password: string): Promise<AuthResult> {
    // +password because select: false in schema
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user) throwHttpError('Invalid email or password.', 401);

    const valid = await user!.comparePassword(password);
    if (!valid) throwHttpError('Invalid email or password.', 401);

    const token = signToken(user!._id, user!.role as UserRole);
    return { user: user!.toJSON(), token };
  },

  async getMe(userId: string): Promise<IUser> {
    const user = await User.findById(userId);
    if (!user) throwHttpError('User not found.', 404);
    return user!;
  },
};
