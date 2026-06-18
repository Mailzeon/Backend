import { Request, Response } from 'express';
import { orderService } from '../services/order.service';
import { sendSuccess, sendError } from '../utils/response';

export const createOrder = async (req: Request, res: Response) => {
  const { serviceName } = req.body;
  if (!serviceName?.trim()) { sendError(res, 'Service name is required.', 400); return; }
  const order = await orderService.createOrder(req.user!._id.toString(), serviceName);
  sendSuccess(res, 'Order created successfully.', order, 201);
};

export const getMarketplace = async (_req: Request, res: Response) => {
  const orders = await orderService.getMarketplaceOrders();
  sendSuccess(res, 'Marketplace orders fetched.', orders);
};

export const acceptOrder = async (req: Request, res: Response) => {
  const order = await orderService.acceptOrder(
    req.params.id, req.user!._id.toString(), req.user!.name
  );
  sendSuccess(res, 'Order accepted. You have 10 minutes to submit credentials.', order);
};

export const submitCredentials = async (req: Request, res: Response) => {
  const { email, password, notes } = req.body;
  if (!email?.trim() || !password?.trim()) {
    sendError(res, 'Email and password are required.', 400); return;
  }
  const order = await orderService.submitCredentials(
    req.params.id, req.user!._id.toString(), { email: email.trim(), password: password.trim(), notes }
  );
  sendSuccess(res, 'Credentials submitted successfully.', order);
};

export const requestVerificationCode = async (req: Request, res: Response) => {
  const order = await orderService.requestVerificationCode(
    req.params.id, req.user!._id.toString()
  );
  sendSuccess(res, 'Verification code requested. Worker has been notified.', order);
};

export const submitVerificationCode = async (req: Request, res: Response) => {
  const { code } = req.body;
  if (!code?.trim()) { sendError(res, 'Verification code is required.', 400); return; }
  const order = await orderService.submitVerificationCode(
    req.params.id, req.user!._id.toString(), code
  );
  sendSuccess(res, 'Verification code submitted.', order);
};

export const requestNewCode = async (req: Request, res: Response) => {
  const order = await orderService.requestNewCode(
    req.params.id, req.user!._id.toString()
  );
  sendSuccess(res, 'New code requested. Worker has been notified.', order);
};

export const confirmSuccess = async (req: Request, res: Response) => {
  const order = await orderService.confirmSuccess(
    req.params.id, req.user!._id.toString()
  );
  sendSuccess(res, 'Order confirmed as successful. Worker earnings released.', order);
};

export const reportProblem = async (req: Request, res: Response) => {
  const order = await orderService.reportProblem(
    req.params.id, req.user!._id.toString()
  );
  sendSuccess(res, 'Problem reported. Order is under review.', order);
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
