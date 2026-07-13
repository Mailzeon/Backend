import { Document, Types } from 'mongoose';

// ─── Union Types ──────────────────────────────────────────────────────────────

export type UserRole     = 'customer' | 'worker' | 'admin';
export type WorkerLevel  = 'bronze' | 'silver' | 'gold';

export type OrderStatus =
  | 'payment_pending'   // NEW: order created, awaiting Cashfree payment confirmation
  | 'payment_failed'    // NEW: payment did not succeed — terminal state
  | 'pending'
  | 'accepted'
  | 'credentials_submitted'
  | 'verification_pending'
  | 'success_confirmed'
  | 'completed'
  | 'under_review'
  | 'cancelled';

export type WithdrawalStatus  = 'pending' | 'approved' | 'rejected' | 'completed';
export type PaymentMethod     = 'upi' | 'bank';
export type DisputeReason     = 'wrong_password' | 'unable_to_login' | 'account_issue' | 'other';
export type DisputeStatus     = 'open' | 'resolved' | 'rejected';
export type TransactionType   = 'credit' | 'debit' | 'withdrawal';
export type NotificationType  = 'order' | 'withdrawal' | 'verification' | 'dispute' | 'system';

// ─── Document Interfaces ──────────────────────────────────────────────────────

export interface IUser extends Document {
  _id: Types.ObjectId;
  name: string;
  email: string;
  password: string;
  role: UserRole;
  // NEW: required by Cashfree at order-creation time; optional here since
  // existing users won't have it until they place their first order.
  phone?: string;
  isOnline: boolean;
  isApproved: boolean;           // Workers need admin approval before accepting orders
  level: WorkerLevel;
  upiId?: string;
  bankDetails?: {
    accountHolder: string;
    accountNumber: string;
    ifscCode: string;
    bankName: string;
  };
  profileImage?: string;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

export interface JwtPayload {
  userId: string;
  role: UserRole;
}
