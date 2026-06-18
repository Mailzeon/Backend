# Marketplace Backend

Express.js + TypeScript API server for the Marketplace platform.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy env template and fill in values
cp .env.example .env

# 3. Start development server (auto-restarts on file changes)
npm run dev
```

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 5000) |
| `MONGODB_URI` | MongoDB Atlas connection string |
| `JWT_SECRET` | Secret key for JWT signing (min 32 chars) |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |
| `FRONTEND_URL` | Frontend URL for CORS (default: http://localhost:3000) |

## Default Admin Account

Seeded automatically on first run:
- Email: `admin@marketplace.com`
- Password: `admin123456`

**Change this password immediately after first login.**

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start with nodemon (auto-restart) |
| `npm run build` | Compile TypeScript to dist/ |
| `npm start` | Run compiled production build |
| `npm run typecheck` | Check TypeScript types without compiling |

## API Endpoints

```
POST   /api/auth/register
POST   /api/auth/login
GET    /api/auth/me
POST   /api/orders
GET    /api/orders/marketplace
GET    /api/orders/my
GET    /api/orders/assigned
GET    /api/orders/:id
PATCH  /api/orders/:id/accept
PATCH  /api/orders/:id/credentials
PATCH  /api/orders/:id/request-code
PATCH  /api/orders/:id/submit-code
PATCH  /api/orders/:id/request-new-code
PATCH  /api/orders/:id/confirm
PATCH  /api/orders/:id/dispute
GET    /api/wallet
GET    /api/wallet/transactions
POST   /api/withdrawals
GET    /api/withdrawals/my
GET    /api/notifications
PATCH  /api/notifications/:id/read
PATCH  /api/notifications/read-all
POST   /api/ratings
PATCH  /api/users/status
PUT    /api/users/profile
POST   /api/disputes
GET    /api/disputes/my
GET    /api/admin/stats
GET    /api/admin/orders
GET    /api/admin/users
PATCH  /api/admin/users/:id/approve
GET    /api/admin/withdrawals
PATCH  /api/admin/withdrawals/:id
GET    /api/admin/disputes
PATCH  /api/admin/disputes/:id
GET    /api/admin/leaderboard
```

## Deployment (Render)

1. Push code to GitHub
2. Connect repo to Render → New Web Service
3. Build command: `npm install && npm run build`
4. Start command: `npm start`
5. Add all environment variables in Render dashboard
