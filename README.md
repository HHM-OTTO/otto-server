# Otto Admin Backend

Node.js + Express API that powers the Otto Admin experience. Provides REST endpoints, scheduled jobs, file storage, and integrations with Stripe, Twilio, Firebase, ElevenLabs, and external AI services. The backend is designed to run independently from the frontend and exposes a single JSON API on port `5001` by default.

## Tech Stack

- TypeScript with tsx for local development
- Express 4 with modular route registration
- Drizzle ORM targeting PostgreSQL/Neon
- Stripe, Twilio, Firebase Admin, Google Cloud Storage integrations
- Node cron-based background schedulers

## Prerequisites

- Node.js 20.x (LTS) and npm 10+
- PostgreSQL-compatible database (Neon, Supabase, RDS, etc.)
- Credentials for Stripe, Twilio, Firebase Admin SDK, and any optional services you intend to use

## Getting Started

1. Install dependencies
   ```bash
   npm install
   ```
2. Copy the environment template (create one if necessary) and fill in secrets
   ```bash
   cp .env.example .env
   ```
3. Start the API in watch mode
   ```bash
   npm run dev
   ```
   The server listens on `http://0.0.0.0:5001` and logs API requests.

## Available Scripts

| Command | Description |
| ------- | ----------- |
| `npm run dev` | Start the API with tsx and reload on changes |
| `npm run build` | Bundle TypeScript to ESM in `dist/` via esbuild |
| `npm start` | Run the bundled production build (`dist/index.js`) |
| `npm run typecheck` | Type-check the project |
| `npm run db:push` | Apply Drizzle schema changes to the target database |

## Environment Variables

| Key | Purpose |
| --- | ------- |
| `PORT` | Port to bind the HTTP server (defaults to `5001`) |
| `DATABASE_URL` | PostgreSQL connection string for Drizzle ORM |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | JSON string of Firebase Admin credentials |
| `FIREBASE_PROJECT_ID` | Firebase project ID (also used by analytics exports) |
| `STRIPE_SECRET_KEY`, `TESTING_STRIPE_SECRET_KEY` | Stripe secret keys for prod/test environments |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret for Stripe events |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio credentials for SMS and voice |
| `PUBLIC_BASE_URL` | Public URL used when generating links in outbound messages |
| `REPLIT_DOMAINS`, `REPLIT_DEV_DOMAIN`, `REPLIT_DEPLOYMENT` | Deployment hints for hosted environments (optional) |
| `ELEVENLABS_API_KEY` | ElevenLabs voice synthesis |
| `SERPAPI_KEY` | SerpAPI key for search-based agents |
| `OPENAI_API_KEY` | OpenAI key for AI-driven features |
| `MCP_SERVER_API_KEY` | Authentication key for MCP server endpoints |
| `AGENT_API_KEY` | Protect agent-facing endpoints |
| `KDS_API_KEY` | Key used when polling for kitchen display status |
| `PRIVATE_OBJECT_DIR` | Filesystem directory for storing generated archives (defaults to project root) |

> Tip: keep sensitive keys out of version control. `.env` is ignored by `.gitignore`.

## Database & Migrations

Drizzle ORM defines schema files in `shared/schema.ts`. After editing the schema, run:

```bash
npm run db:push
```

The command applies changes to the database defined by `DATABASE_URL`.

## Project Structure

```
backend/
├── src/
│   ├── routes.ts                    # HTTP routes and business logic
│   ├── services/                    # External integrations (Stripe, ElevenLabs, etc.)
│   ├── storage/                     # File system storage helpers
│   ├── wait-time-reset-scheduler.ts # Cron-style jobs
│   ├── objectStorage.ts             # Google Cloud Storage utilities
│   └── index.ts                     # Server bootstrap
├── shared/                          # Canonical database schema & shared types
├── drizzle.config.ts
├── tsconfig.json
└── package.json
```

## Shared Types

The `shared/` directory is the source of truth for database models and shared DTOs. Sync the `frontend/shared` folder whenever schema changes occur, or publish this code as a shared package to avoid manual copies.

## Deployment

1. Build the project: `npm run build`.
2. Deploy the contents of `dist/` to your Node environment (Docker, PM2, serverless worker, etc.).
3. Configure environment variables and ensure persistent storage for any directories referenced by `PRIVATE_OBJECT_DIR` or Google Cloud Storage.
4. Set up Stripe webhook forwarding to `<PUBLIC_BASE_URL>/api/billing/webhook`.
