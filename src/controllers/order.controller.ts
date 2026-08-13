import { Request, Response } from 'express';
import { orderService, checkEmailAvailability } from '../services/order.service';
import { sendSuccess, sendError } from '../utils/response';

// NEW: pre-payment "Check" button — customer picks domain + name, hits
// Check, and only sees the Pay button once this comes back available.
// Doesn't require the rest of the order form to be filled in yet.
export const checkEmail = async (req: Request, res: Response) => {
  const { domain, customLocalPart } = req.body;
  const result = await checkEmailAvailability(domain, customLocalPart);
  const message = !result.checked
    ? 'Could not verify right now — you can still continue.'
    : result.available
      ? 'This email is available.'
      : 'This email is already taken. Please choose a different name.';
  sendSuccess(res, message, result);
};

// REWORKED for Cashfree: now accepts a customer-set `amount` and returns
// `paymentSessionId` (needed by the frontend to open Cashfree's hosted
// checkout) alongside the created order. Phone comes from the customer's
// verified profile now (see order.service.ts createOrder()), no longer
// collected per-order.
export const createOrder = async (req: Request, res: Response) => {
  const { serviceName, domain, emailType, customLocalPart, amount, useWalletCredit } = req.body;

  const result = await orderService.createOrder(
    req.user!._id.toString(),
    serviceName,
    domain,
    emailType,
    amount,
    customLocalPart,
    useWalletCredit
  );

  const message = result.paidWithWallet
    ? 'Order created and paid with wallet credit — it\'s already live in the marketplace!'
    : result.order.walletAmountApplied > 0
      ? 'Wallet credit applied — complete the remaining payment to publish your order.'
      : 'Order created. Complete payment to publish it to the marketplace.';

  sendSuccess(res, message, {
    order: result.order,
    paymentSessionId: result.paymentSessionId,
    paidWithWallet: result.paidWithWallet,
    walletAmountApplied: result.order.walletAmountApplied,
  }, 201);
};

export const cancelOrder = async (req: Request, res: Response) => {
  const order = await orderService.cancelOrder(req.params.id, req.user!._id.toString());
  sendSuccess(res, 'Order cancelled successfully.', order);
};

export const getMarketplace = async (req: Request, res: Response) => {
  const orders = await orderService.getMarketplaceOrders(req.user!._id.toString());
  sendSuccess(res, 'Marketplace orders fetched.', orders);
};

export const acceptOrder = async (req: Request, res: Response) => {
  const order = await orderService.acceptOrder(
    req.params.id, req.user!._id.toString(), req.user!.name
  );
  sendSuccess(res, 'Order accepted. You have 10 minutes to submit credentials.', order);
};

export const submitCredentials = async (req: Request, res: Response) => {
  const { email, password, notes, acknowledgedNoPhone } = req.body;
  if (!email?.trim() || !password?.trim()) {
    sendError(res, 'Email and password are required.', 400); return;
  }
  const order = await orderService.submitCredentials(
    req.params.id,
    req.user!._id.toString(),
    { email: email.trim(), password: password.trim(), notes },
    acknowledgedNoPhone === true
  );
  sendSuccess(res, 'Credentials submitted successfully.', order);
};

export const submitVerificationNumber = async (req: Request, res: Response) => {
  const { number } = req.body;
  if (!number?.trim()) { sendError(res, 'Verification number is required.', 400); return; }
  const order = await orderService.submitVerificationNumber(
    req.params.id, req.user!._id.toString(), number
  );
  sendSuccess(res, 'Verification number sent. Worker has been notified.', order);
};

export const confirmVerificationNumber = async (req: Request, res: Response) => {
  const order = await orderService.confirmVerificationNumber(
    req.params.id, req.user!._id.toString()
  );
  sendSuccess(res, 'Confirmed. Customer has been notified.', order);
};

export const requestVerificationCode = async (req: Request, res: Response) => {
  const order = await orderService.requestVerificationCode(
    req.params.id, req.user!._id.toString()
  );
  sendSuccess(res, 'Code requested. Worker has been notified.', order);
};

export const submitVerificationCode = async (req: Request, res: Response) => {
  const { code } = req.body;
  if (!code?.trim()) { sendError(res, 'Verification code is required.', 400); return; }
  const order = await orderService.submitVerificationCode(
    req.params.id, req.user!._id.toString(), code
  );
  sendSuccess(res, 'Code sent. Customer has been notified.', order);
};

export const confirmSuccess = async (req: Request, res: Response) => {
  const order = await orderService.confirmSuccess(
    req.params.id, req.user!._id.toString()
  );
  sendSuccess(res, 'Order confirmed as successful. Worker earnings released.', order);
};

export const reportProblem = async (req: Request, res: Response) => {
  const { reason, description } = req.body;

  const validReasons = ['wrong_password', 'unable_to_login', 'account_issue', 'other'];
  const finalReason  = validReasons.includes(reason) ? reason : 'other';

  const order = await orderService.reportProblem(
    req.params.id,
    req.user!._id.toString(),
    finalReason,
    description?.trim()
  );
  sendSuccess(res, 'Problem reported. Admin is reviewing your case.', order);
};

export const getOrder = async (req: Request, res: Response) => {
  const order = await orderService.getOrder(
    req.params.id, req.user!._id.toString(), req.user!.role
  );
  sendSuccess(res, 'Order fetched.', order);
};

export const getMyOrders = async (req: Request, res: Response) => {
  const orders = await orderService.getCustomerOrders(req.user!._id.toString());
  sendSuccess(res, 'Orders fetched.', orders);
};

export const getAssignedOrders = async (req: Request, res: Response) => {
  const orders = await orderService.getWorkerOrders(req.user!._id.toString());
  sendSuccess(res, 'Assigned orders fetched.', orders);
};
