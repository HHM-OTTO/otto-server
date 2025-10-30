import "dotenv/config";
import express from "express";
import { registerRoutes } from "./routes.js";

const app = express();

// CORS middleware - allow all origins for API access
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Register routes (async initialization)
let isInitialized = false;
const initPromise = registerRoutes(app).then(() => {
  isInitialized = true;
});

// Middleware to ensure routes are initialized
app.use(async (req, res, next) => {
  if (!isInitialized) {
    await initPromise;
  }
  next();
});

// Export for Vercel serverless
export default app;

