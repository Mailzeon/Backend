// This file extends Express's built-in Request interface
// so that req.user is typed everywhere after JWT authentication.

import 'express';
import { IUser } from './index';

declare global {
  namespace Express {
    interface Request {
      user?: IUser;
    }
  }
}
