import type { Express } from "express";
import express, { Request, Response } from "express";
import { createServer, type Server } from "http";
import * as path from "path";
import * as fs from "fs";
import { storage } from "./storage";
import { db } from "./db";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { checkExistingNumber, searchAvailableNumbers, purchasePhoneNumber, updatePhoneNumberWebhooks, getPhoneNumberDetails } from "./twilio-service";
import { insertUserSchema, updateUserSchema, insertRestaurantSchema, updateRestaurantSchema, insertAgentConfigurationSchema, updateAgentConfigSchema, insertCallLogSchema, insertUserAgentAccessSchema, type AgentConfiguration, insertSkillSchema, updateSkillSchema, insertMethodSchema, updateMethodSchema, insertAgentSkillSchema, updateAgentSkillSchema, insertPrinterSchema, updatePrinterSchema, insertPhoneNumberSchema, updatePhoneNumberSchema, insertPlatformSettingsSchema, updatePlatformSettingsSchema, insertMenuOverrideSchema, users, subscriptionPrices } from "@shared/schema";
import { stripeService } from "./stripe-service";
import Stripe from "stripe";
import { z } from "zod";
// @ts-ignore - Twilio types have export issues
import twilio from "twilio";
import { verifyFirebaseToken } from "./firebase-admin";
import { TwilioPollingService } from "./twilio-polling";
import { handleMCPConnection } from "./mcp-server";

// Note: updateAgentConfigSchema and updateRestaurantSchema are now imported from shared/schema

// Constants for Twilio webhook
const DEFAULT_TIMEOUT_SECONDS = 20;

// Helper function to send Slack notifications for errors
async function sendSlackErrorNotification(
  endpoint: string,
  statusCode: number,
  error: string,
  details?: any
): Promise<void> {
  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
  
  if (!slackWebhookUrl) {
    console.log('⚠️ Slack webhook URL not configured - skipping notification');
    return;
  }

  try {
    const timestamp = new Date().toISOString();
    const errorDetails = details ? `\n\`\`\`${JSON.stringify(details, null, 2)}\`\`\`` : '';
    
    // Simplified payload format for better compatibility
    const payload = {
      text: `🚨 API Error Alert - ${endpoint}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*🚨 API Error Alert*\n\n*Endpoint:* \`${endpoint}\`\n*Status Code:* \`${statusCode}\`\n*Error:* ${error}\n*Timestamp:* ${timestamp}${errorDetails}`
          }
        }
      ]
    };

    console.log('📤 Sending Slack notification:', { endpoint, statusCode, error });
    
    // Send to Slack asynchronously (don't block)
    const response = await fetch(slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const responseText = await response.text();
      console.error('❌ Slack notification failed:', {
        status: response.status,
        statusText: response.statusText,
        body: responseText
      });
    } else {
      console.log('✅ Slack notification sent successfully');
    }
  } catch (err: any) {
    console.error('❌ Error sending Slack notification:', {
      message: err?.message,
      stack: err?.stack
    });
  }
}

// Helper function to generate safe default TwiML
function getSafeDefaultTwiML(): string {
  return `<Response>
  <Say voice="alice">We're sorry. The service is temporarily unavailable.</Say>
  <Hangup/>
</Response>`;
}

// Helper function to generate TwiML based on agent configuration
function generateTwiMLResponse(config: AgentConfiguration): string {
  switch (config.mode) {
    case "forward":
      const timeout = config.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS;
      const callerIdAttr = config.callerId ? ` callerId="${config.callerId}"` : "";
      
      if (!config.redirectPhoneNumber) {
        console.log("Forward mode requires redirectPhoneNumber");
        return getSafeDefaultTwiML();
      }
      
      return `<Response>
  <Dial answerOnBridge="true" timeout="${timeout}"${callerIdAttr}>
    <Number>${config.redirectPhoneNumber}</Number>
  </Dial>
</Response>`;

    case "agent":
      return `<Response>
  <Redirect method="POST">https://api.us.elevenlabs.io/twilio/inbound_call</Redirect>
</Response>`;

    case "offline":
    default:
      return getSafeDefaultTwiML();
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  function getStripeInstance(): Stripe | null {
    const isProduction = process.env.REPLIT_DEPLOYMENT === '1';
    const key = isProduction
      ? process.env.STRIPE_SECRET_KEY
      : (process.env.TESTING_STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY);
    if (!key) return null;
    return new Stripe(key, { apiVersion: "2025-09-30.clover" });
  }
  // ========== MCP Server Routes (MUST come before Firebase auth middleware) ==========
  // MCP JSON-RPC 2.0 endpoint for ChatGPT Agent Builder
  app.post("/api/mcp", async (req, res) => {
    await handleMCPConnection(req, res);
  });

  app.post("/api/mcp/", async (req, res) => {
    await handleMCPConnection(req, res);
  });

  // ========== Firebase Authentication Middleware (for all other routes) ==========
  app.use("/api", async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader?.replace("Bearer ", "");
      
      if (!token) {
        // Allow unauthenticated access to public endpoints
        return next();
      }

      const firebaseUser = await verifyFirebaseToken(token);
      if (firebaseUser) {
        // Add Firebase user info to request for authenticated routes
        req.firebaseUser = firebaseUser;
      }
      
      next();
    } catch (error) {
      console.error('Auth middleware error:', error);
      next(); // Continue without authentication
    }
  });

  // User routes (admin only)
  app.post("/api/users", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const userData = insertUserSchema.parse(req.body);
      const user = await storage.createUser(userData);
      res.json(user);
    } catch (error) {
      console.error("Failed to create user:", error);
      res.status(400).json({ error: "Invalid user data" });
    }
  });

  app.get("/api/users/me", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      let user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      
      if (!user) {
        // Create user if doesn't exist
        // Split display name into firstName and lastName if available
        const displayName = firebaseUser.name || "";
        const nameParts = displayName.trim().split(" ");
        const firstName = nameParts[0] || "Unknown";
        const lastName = nameParts.slice(1).join(" ") || "User";
        
        user = await storage.createUser({
          firebaseUid: firebaseUser.uid,
          email: firebaseUser.email || "unknown@example.com",
          firstName,
          lastName,
          role: "user"  // Default role should be user, not admin
        });
      }
      
      // Update lastSeen timestamp
      const updatedUser = await storage.updateUserLastSeen(user.id);
      
      res.json(updatedUser || user);
    } catch (error) {
      console.error("Failed to get user:", error);
      res.status(500).json({ error: "Failed to get user" });
    }
  });

  // Get all users (admin only)
  app.get("/api/users", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const users = await storage.getAllUsers();
      res.json(users);
    } catch (error) {
      console.error("Failed to get users:", error);
      res.status(500).json({ error: "Failed to get users" });
    }
  });

  // Update user
  app.put("/api/users/:id", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const userId = req.params.id;
      const updateData = updateUserSchema.parse(req.body);
      const updatedUser = await storage.updateUser(userId, updateData);
      
      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json(updatedUser);
    } catch (error) {
      console.error("Failed to update user:", error);
      res.status(500).json({ error: "Failed to update user" });
    }
  });

  // Delete user
  app.delete("/api/users/:id", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const userId = req.params.id;
      
      // Prevent deleting yourself
      if (userId === currentUser.id) {
        return res.status(400).json({ error: "Cannot delete your own account" });
      }

      const deleted = await storage.deleteUser(userId);
      
      if (!deleted) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Failed to delete user:", error);
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  // Restaurant routes
  app.get("/api/restaurants", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      let restaurants;
      if (user.role === "admin") {
        restaurants = await storage.getAllRestaurants();
      } else {
        restaurants = await storage.getRestaurantsByOwnerId(user.id);
      }
      
      res.json(restaurants);
    } catch (error) {
      console.error("Failed to get restaurants:", error);
      res.status(500).json({ error: "Failed to get restaurants" });
    }
  });

  app.post("/api/restaurants", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      // Parse only name from request and create restaurant data with secure ownerId
      const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
      const restaurantData = { name, ownerId: user.id };
      
      const restaurant = await storage.createRestaurant(restaurantData);
      res.status(201).json(restaurant);
    } catch (error) {
      console.error("Restaurant creation error:", error);
      res.status(400).json({ error: "Invalid restaurant data", details: error instanceof Error ? error.message : String(error) });
    }
  });

  // Twilio webhook endpoint for handling incoming calls
  app.post("/api/twilio/voice", (req: Request, res: Response) => {
    try {
      // Validate Twilio signature if auth token is available
      const twilioSignature = req.headers["x-twilio-signature"] as string;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      
      if (authToken && twilioSignature) {
        // Validate signature using twilio webhook
        const isValid = twilio.validateRequest(
          authToken,
          twilioSignature,
          `${req.protocol}://${req.get('host')}${req.originalUrl}`,
          req.body
        );
        
        if (!isValid) {
          console.log("Invalid Twilio signature");
          return res.status(403).send("Forbidden");
        }
      }

      // Get called number from Twilio parameters
      const calledNumber = req.body.To || req.body.Called;
      
      if (!calledNumber) {
        console.log("No called number found in Twilio request");
        return res.type('text/xml').send(getSafeDefaultTwiML());
      }

      // Fetch configuration for the called number
      storage.getAgentConfigurationByPhoneNumber(calledNumber)
        .then(config => {
          if (!config || !config.isActive) {
            console.log(`No active config found for ${calledNumber}`);
            return res.type('text/xml').send(getSafeDefaultTwiML());
          }

          const twiml = generateTwiMLResponse(config);
          res.type('text/xml').send(twiml);
        })
        .catch(error => {
          console.error("Error fetching agent config:", error);
          res.type('text/xml').send(getSafeDefaultTwiML());
        });

    } catch (error) {
      console.error("Twilio webhook error:", error);
      res.type('text/xml').send(getSafeDefaultTwiML());
    }
  });

  app.get("/api/restaurants/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      const restaurant = await storage.getRestaurant(id);
      if (!restaurant) {
        return res.status(404).json({ error: "Restaurant not found" });
      }

      // Check authorization: owner, admin, or super_user can access
      if (user.role !== "admin" && user.role !== "super_user" && restaurant.ownerId !== user.id) {
        return res.status(403).json({ error: "Forbidden" });
      }

      res.json(restaurant);
    } catch (error) {
      res.status(500).json({ error: "Failed to get restaurant" });
    }
  });

  app.put("/api/restaurants/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      // Check if restaurant exists and get ownership info
      const existingRestaurant = await storage.getRestaurant(id);
      if (!existingRestaurant) {
        return res.status(404).json({ error: "Restaurant not found" });
      }

      // Check authorization: owner, admin, or super_user can update
      if (user.role !== "admin" && user.role !== "super_user" && existingRestaurant.ownerId !== user.id) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const updateData = updateRestaurantSchema.parse(req.body);
      const restaurant = await storage.updateRestaurant(id, updateData);
      res.json(restaurant);
    } catch (error) {
      res.status(400).json({ error: "Invalid restaurant data" });
    }
  });

  // Agent configuration routes
  app.get("/api/restaurants/:id/agent", async (req, res) => {
    try {
      const { id } = req.params;
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      // Check if restaurant exists and get ownership info
      const restaurant = await storage.getRestaurant(id);
      if (!restaurant) {
        return res.status(404).json({ error: "Restaurant not found" });
      }

      // Get agent config
      const config = await storage.getAgentConfiguration(id);
      if (!config) {
        return res.status(404).json({ error: "Agent configuration not found" });
      }

      // Check authorization: owner, admin, or user with any access level can view agent config
      const isOwner = restaurant.ownerId === user.id;
      const isAdmin = user.role === "admin";
      const hasAccess = await storage.hasUserAgentAccess(user.id, config.id);

      if (!isAdmin && !isOwner && !hasAccess) {
        return res.status(403).json({ error: "Forbidden: You do not have access to this agent" });
      }
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: "Failed to get agent configuration" });
    }
  });

  app.put("/api/restaurants/:id/agent", async (req, res) => {
    try {
      const { id } = req.params;
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      // Check if restaurant exists and get ownership info
      const restaurant = await storage.getRestaurant(id);
      if (!restaurant) {
        return res.status(404).json({ error: "Restaurant not found" });
      }

      // Check authorization: owner, admin, super_user, or user with write access can update agent config
      const isOwner = restaurant.ownerId === user.id;
      const isAdmin = user.role === "admin";
      const isSuperUser = user.role === "super_user";
      
      // Get agent config to check user access
      const existingConfig = await storage.getAgentConfiguration(id);
      let hasWriteAccess = false;
      
      if (existingConfig) {
        hasWriteAccess = await storage.hasUserAgentWriteAccess(user.id, existingConfig.id);
      }
      
      if (!isAdmin && !isSuperUser && !isOwner && !hasWriteAccess) {
        return res.status(403).json({ error: "Forbidden: You do not have write access to this agent" });
      }

      const configData = updateAgentConfigSchema.parse(req.body);
      
      // Normalize resetWaitTimeAt to Date object for Drizzle (ensures UTC storage)
      if (configData.resetWaitTimeAt !== undefined) {
        if (configData.resetWaitTimeAt) {
          const resetDate = new Date(configData.resetWaitTimeAt);
          if (isNaN(resetDate.getTime())) {
            return res.status(400).json({ error: "Invalid resetWaitTimeAt timestamp" });
          }
          // Validate it's a future time
          if (resetDate <= new Date()) {
            return res.status(400).json({ error: "resetWaitTimeAt must be a future time" });
          }
          configData.resetWaitTimeAt = resetDate;
        } else {
          configData.resetWaitTimeAt = null;
        }
      }
      
      // Get the existing configuration to check for phone number changes
      const previousConfig = await storage.getAgentConfiguration(id);
      const previousPhoneNumberId = previousConfig?.phoneNumberId;
      const newPhoneNumberId = configData.phoneNumberId;
      
      // Try to update existing config, if not found, create new one
      let config = await storage.updateAgentConfiguration(id, configData);
      if (!config) {
        // Create new agent config if none exists
        // Set the billing user to the creator (current user)
        const newConfigData = {
          restaurantId: id,
          billingUserId: user.id,
          ...configData,
          resetWaitTimeAt: configData.resetWaitTimeAt instanceof Date ? configData.resetWaitTimeAt : 
                          typeof configData.resetWaitTimeAt === 'string' ? new Date(configData.resetWaitTimeAt) : 
                          configData.resetWaitTimeAt,
        };
        config = await storage.createAgentConfiguration(newConfigData);
        if (!config) {
          return res.status(500).json({ error: "Failed to create agent configuration" });
        }
      }
      
      // Handle Twilio webhook updates ONLY if phone number has actually changed
      // Check if phoneNumberId was explicitly provided in the update (not undefined)
      const phoneNumberExplicitlyChanged = configData.phoneNumberId !== undefined;
      
      if (phoneNumberExplicitlyChanged && previousPhoneNumberId !== newPhoneNumberId) {
        try {
          // Only clear webhooks if admin explicitly removed the phone number (set to null)
          // AND the user is an admin (only admins should be able to clear webhooks)
          if (previousPhoneNumberId && newPhoneNumberId === null && isAdmin) {
            const previousPhoneNumber = await storage.getPhoneNumber(previousPhoneNumberId);
            if (previousPhoneNumber?.twilioSid) {
              console.log(`Admin clearing webhooks for phone number ${previousPhoneNumber.phoneNumber} (was unlinked from agent)`);
              await updatePhoneNumberWebhooks(previousPhoneNumber.twilioSid, '', '');
              
              // Update the phone numbers table to clear the webhook URLs for consistency
              await storage.updatePhoneNumber(previousPhoneNumberId, {
                voiceUrl: undefined,
                statusUrl: undefined,
              });
            }
          }
          
          // If a new phone number is being linked, update its webhooks
          if (newPhoneNumberId) {
            const newPhoneNumber = await storage.getPhoneNumber(newPhoneNumberId);
            if (newPhoneNumber?.twilioSid) {
              // Construct the webhook URLs using a more reliable approach
              let baseUrl: string;
              
              // Check if this is production (admin.callotto.ai domain)
              const isProduction = process.env.REPLIT_DOMAINS && process.env.REPLIT_DOMAINS.includes('admin.callotto.ai');
              
              if (isProduction) {
                // Always use the production domain for webhooks in production
                baseUrl = 'https://admin.callotto.ai';
              } else if (process.env.PUBLIC_BASE_URL) {
                // Use explicit public URL if configured
                baseUrl = process.env.PUBLIC_BASE_URL;
              } else if (process.env.REPLIT_DOMAINS) {
                // Handle Replit domains (may be comma-separated)
                const domain = process.env.REPLIT_DOMAINS.split(',')[0].trim();
                baseUrl = domain.startsWith('http') ? domain : `https://${domain}`;
              } else {
                // Fallback to request-based URL construction
                const protocol = req.get('x-forwarded-proto') || req.protocol;
                const port = process.env.PORT || '5001';
                const host = req.get('host') || `localhost:${port}`;
                baseUrl = `${protocol}://${host}`;
              }
              
              // Use the correct /twiml/ path format with restaurant ID
              const voiceUrl = `${baseUrl}/twiml/voice/${id}`;
              const statusCallback = `${baseUrl}/twiml/status/${id}`;
              
              console.log(`Setting webhooks for phone number ${newPhoneNumber.phoneNumber}: voice=${voiceUrl}, status=${statusCallback}`);
              await updatePhoneNumberWebhooks(newPhoneNumber.twilioSid, voiceUrl, statusCallback);
              
              // Update the phone numbers table with the new webhook URLs for consistency
              await storage.updatePhoneNumber(newPhoneNumberId, {
                voiceUrl,
                statusUrl: statusCallback,
              });
            }
          }
        } catch (webhookError) {
          console.error('Error updating Twilio webhooks:', webhookError);
          // Log the error but don't fail the agent update
        }
      }
      
      res.json(config);
    } catch (error) {
      console.error('Agent configuration update error:', error);
      
      // If it's a Zod validation error, return detailed field errors
      if (error instanceof z.ZodError) {
        const fieldErrors = error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message
        }));
        return res.status(400).json({ 
          error: "Invalid configuration data",
          details: fieldErrors
        });
      }
      
      res.status(400).json({ error: "Invalid configuration data" });
    }
  });

  // Admin-only endpoint to update billing user for an agent
  app.patch("/api/agent-configurations/:id/billing-user", async (req, res) => {
    try {
      const { id } = req.params;
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      // Only admins can update billing user
      if (user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Validate request body
      const { billingUserId } = z.object({ 
        billingUserId: z.string() 
      }).parse(req.body);

      // Verify the new billing user exists
      const newBillingUser = await storage.getUser(billingUserId);
      if (!newBillingUser) {
        return res.status(404).json({ error: "Billing user not found" });
      }

      // Get the agent configuration
      const agentConfig = await storage.getAgentConfigurationById(id);
      if (!agentConfig) {
        return res.status(404).json({ error: "Agent configuration not found" });
      }

      // Update the billing user
      const updatedConfig = await storage.updateAgentConfigurationById(id, { 
        billingUserId 
      });
      
      if (!updatedConfig) {
        return res.status(500).json({ error: "Failed to update billing user" });
      }

      res.json(updatedConfig);
    } catch (error) {
      console.error("Failed to update billing user:", error);
      res.status(400).json({ error: "Invalid request data" });
    }
  });

  // Call logs routes
  app.get("/api/restaurants/:id/calls", async (req, res) => {
    try {
      const { id } = req.params;
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      const restaurant = await storage.getRestaurant(id);
      if (!restaurant) {
        return res.status(404).json({ error: "Restaurant not found" });
      }

      // Check authorization: only owner, admin, or users with agent access can view calls
      if (user.role !== "admin" && restaurant.ownerId !== user.id) {
        // Check if user has access to any agents in this restaurant
        const hasAccess = await storage.userHasAccessToRestaurant(user.id, id);
        if (!hasAccess) {
          return res.status(403).json({ error: "Forbidden" });
        }
      }

      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const calls = await storage.getCallLogsByRestaurant(id, limit);
      res.json(calls);
    } catch (error) {
      res.status(500).json({ error: "Failed to get call logs" });
    }
  });

  // Get ALL calls across all restaurants (Admin only)
  app.get("/api/all-calls", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const calls = await storage.getAllCallLogs(limit);
      res.json(calls);
    } catch (error) {
      res.status(500).json({ error: "Failed to get all call logs" });
    }
  });

  // Get aggregate stats across ALL restaurants (Admin only)
  app.get("/api/all-stats", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const calls = await storage.getAllCallLogs();
      
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const todayCalls = calls.filter(call => call.createdAt && call.createdAt >= today);
      const completedCalls = todayCalls.filter(call => call.status === 'completed');
      const totalDuration = completedCalls.reduce((sum, call) => sum + (call.duration || 0), 0);
      const avgDuration = completedCalls.length > 0 ? Math.round(totalDuration / completedCalls.length) : 0;
      const totalValue = completedCalls.reduce((sum, call) => sum + (call.orderValue || 0), 0);

      const inProgressCalls = calls.filter(call => call.status === 'in-progress');
      const stats = {
        callsToday: todayCalls.length,
        callsInProgress: inProgressCalls.length,
        avgDuration: `${Math.floor(avgDuration / 60)}:${(avgDuration % 60).toString().padStart(2, '0')}`,
        totalValue: totalValue / 100, // Convert cents to dollars
      };

      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: "Failed to get aggregate statistics" });
    }
  });

  // Get system health statistics (Admin only)
  app.get("/api/system-health", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Get all call logs to calculate statistics
      const calls = await storage.getAllCallLogs();
      
      // Calculate statistics
      const totalConversations = calls.length;
      const withElevenLabsIds = calls.filter(call => call.elevenlabsConversationId).length;
      
      // Categorize audio by storage type
      const audioInObjectStorage = calls.filter(call => 
        call.localAudioPath && call.localAudioPath.startsWith('/objects/')
      ).length;
      
      const audioInLegacyFilesystem = calls.filter(call => 
        call.localAudioPath && call.localAudioPath.startsWith('server/storage/')
      ).length;
      
      const audioMissing = calls.filter(call => 
        call.elevenlabsConversationId && !call.localAudioPath
      ).length;
      
      const audioRetrieved = audioInObjectStorage + audioInLegacyFilesystem;
      
      res.json({
        totalConversations,
        withElevenLabsIds,
        audioRetrieved,
        audioInObjectStorage,
        audioInLegacyFilesystem,
        audioMissing
      });
    } catch (error) {
      console.error("Failed to get system health stats:", error);
      res.status(500).json({ error: "Failed to get system health statistics" });
    }
  });

  // Migrate audio to object storage (Admin only)
  app.post("/api/conversations/process-unretrieved-audio", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Import the ElevenLabs service
      const { elevenlabsService } = await import('./services/elevenlabsService');
      
      // Start migration in the background
      elevenlabsService.migrateAudioToObjectStorage().catch(error => {
        console.error('Error migrating audio:', error);
      });
      
      res.json({ 
        message: "Started migrating audio to object storage in the background" 
      });
    } catch (error) {
      console.error("Failed to start audio migration:", error);
      res.status(500).json({ error: "Failed to start audio migration" });
    }
  });

  // Poll Twilio for stale in-progress calls (Admin only)
  app.post("/api/twilio/poll-stale-calls", async (req, res) => {
    try {
      // Check if user is authenticated and admin
      if (!req.firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const user = await storage.getUserByFirebaseUid(req.firebaseUser.uid);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const ageMinutes = req.body.ageMinutes || 15;
      const updatedCount = await TwilioPollingService.pollStaleInProgressCalls(ageMinutes);
      
      res.json({ 
        success: true, 
        message: `Polling completed. Updated ${updatedCount} calls.`,
        updatedCount 
      });
    } catch (error: any) {
      console.error('Twilio polling error:', error);
      res.status(500).json({ 
        error: "Failed to poll Twilio for call status",
        details: error.message 
      });
    }
  });

  // Get calls for user's accessible agents (Regular users)
  app.get("/api/my/calls", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }

      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const calls = await storage.getCallLogsForUser(currentUser.id, limit);
      res.json(calls);
    } catch (error) {
      console.error("Failed to get user calls:", error);
      res.status(500).json({ error: "Failed to get call logs" });
    }
  });

  // Get stats for user's accessible agents (Regular users)
  app.get("/api/my/stats", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }

      const calls = await storage.getCallLogsForUser(currentUser.id);
      
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const todayCalls = calls.filter(call => call.createdAt && call.createdAt >= today);
      const completedCalls = todayCalls.filter(call => call.status === 'completed');
      const totalDuration = completedCalls.reduce((sum, call) => sum + (call.duration || 0), 0);
      const avgDuration = completedCalls.length > 0 ? Math.round(totalDuration / completedCalls.length) : 0;
      const totalValue = completedCalls.reduce((sum, call) => sum + (call.orderValue || 0), 0);

      const inProgressCalls = calls.filter(call => call.status === 'in-progress');
      const stats = {
        callsToday: todayCalls.length,
        callsInProgress: inProgressCalls.length,
        avgDuration: `${Math.floor(avgDuration / 60)}:${(avgDuration % 60).toString().padStart(2, '0')}`,
        totalValue: totalValue / 100, // Convert cents to dollars
      };

      res.json(stats);
    } catch (error) {
      console.error("Failed to get user statistics:", error);
      res.status(500).json({ error: "Failed to get statistics" });
    }
  });

  // ====================
  // Conversations Endpoints
  // ====================

  // Get conversations list with pagination and filtering (Admin & Super User only)
  app.get("/api/conversations", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }

      // Check role - only admin and super_user can access conversations
      if (currentUser.role !== "admin" && currentUser.role !== "super_user") {
        return res.status(403).json({ error: "Access denied. Admin or Super User role required." });
      }

      // Parse query parameters
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
      const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;
      const searchQuery = req.query.search as string | undefined;
      
      // Handle both single agentId (legacy) and multiple agentIds (new)
      let agentIds: string[] | undefined;
      if (req.query.agentIds) {
        agentIds = Array.isArray(req.query.agentIds) 
          ? req.query.agentIds as string[]
          : [req.query.agentIds as string];
      } else if (req.query.agentId) {
        // Legacy support for single agentId
        agentIds = [req.query.agentId as string];
      }
      
      // Parse date filters
      let startDate: Date | undefined;
      let endDate: Date | undefined;
      if (req.query.startDate) {
        startDate = new Date(req.query.startDate as string);
      }
      if (req.query.endDate) {
        endDate = new Date(req.query.endDate as string);
        // Set to end of day
        endDate.setHours(23, 59, 59, 999);
      }

      // Get conversations with role-based filtering
      const result = await storage.getConversationsForUser(
        currentUser.id,
        currentUser.role,
        {
          limit,
          offset,
          searchQuery,
          agentIds,
          startDate,
          endDate,
        }
      );

      res.json(result);
    } catch (error) {
      console.error("Failed to get conversations:", error);
      res.status(500).json({ error: "Failed to get conversations" });
    }
  });

  // Get list of agents accessible to the user (for filtering)
  app.get("/api/conversations/agents", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }

      // Check role - only admin and super_user can access conversations
      if (currentUser.role !== "admin" && currentUser.role !== "super_user") {
        return res.status(403).json({ error: "Access denied. Admin or Super User role required." });
      }

      let agents;
      if (currentUser.role === "admin") {
        // Admins can see all restaurants
        const restaurants = await storage.getAllRestaurants();
        agents = restaurants.map(r => ({ id: r.id, name: r.name }));
      } else {
        // Super users only see their accessible agents
        const accessibleAgents = await storage.getAgentsForUser(currentUser.id);
        agents = accessibleAgents.map(a => ({ id: a.restaurantId, name: a.agentName }));
      }

      res.json(agents);
    } catch (error) {
      console.error("Failed to get agents list:", error);
      res.status(500).json({ error: "Failed to get agents list" });
    }
  });

  // Get detailed conversation with transcript (Admin & Super User only)
  app.get("/api/conversations/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }

      // Check role - only admin and super_user can access conversations
      if (currentUser.role !== "admin" && currentUser.role !== "super_user") {
        return res.status(403).json({ error: "Access denied. Admin or Super User role required." });
      }

      // Get conversation with authorization check
      const conversation = await storage.getConversationDetails(
        id,
        currentUser.id,
        currentUser.role
      );

      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found or access denied" });
      }

      res.json(conversation);
    } catch (error) {
      console.error("Failed to get conversation details:", error);
      res.status(500).json({ error: "Failed to get conversation details" });
    }
  });

  // Stream or download conversation audio (Admin & Super User only)
  app.get("/api/conversations/:id/audio", async (req, res) => {
    try {
      const { id } = req.params;
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }

      // Check role - only admin and super_user can access conversations
      if (currentUser.role !== "admin" && currentUser.role !== "super_user") {
        return res.status(403).json({ error: "Access denied. Admin or Super User role required." });
      }

      // Get conversation to check authorization and get audio URL
      const conversation = await storage.getConversationDetails(
        id,
        currentUser.id,
        currentUser.role
      );

      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found or access denied" });
      }

      if (!conversation.elevenlabsAudioUrl) {
        return res.status(404).json({ error: "Audio not available for this conversation" });
      }

      // For now, just return the audio URL
      // In production, you would stream the file or use signed URLs
      res.json({ 
        audioUrl: conversation.elevenlabsAudioUrl,
        fileSize: conversation.audioFileSize,
        retrievedAt: conversation.audioRetrievedAt
      });
    } catch (error) {
      console.error("Failed to get conversation audio:", error);
      res.status(500).json({ error: "Failed to get conversation audio" });
    }
  });

  // Process unretrieved audio from ElevenLabs (Admin only)
  app.post("/api/conversations/process-audio", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Import the service dynamically to avoid circular dependencies
      const { elevenlabsService } = await import('./services/elevenlabsService');
      
      // Process unretrieved audio asynchronously
      res.json({ 
        success: true, 
        message: "Audio retrieval process started" 
      });

      // Process in background
      elevenlabsService.processUnretrievedAudio().then(result => {
        console.log(`[ElevenLabs Audio Processing] Completed: ${result.processed} conversations processed, ${result.successful} successful, ${result.failed} failed`);
      }).catch(error => {
        console.error(`[ElevenLabs Audio Processing] Error:`, error);
      });
    } catch (error) {
      console.error("Failed to start audio processing:", error);
      res.status(500).json({ error: "Failed to start audio processing" });
    }
  });

  // Download conversations as JSON files in a zip (Admin only)
  app.post("/api/conversations/download-json", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { conversationIds } = req.body;
      
      if (!conversationIds || !Array.isArray(conversationIds) || conversationIds.length === 0) {
        return res.status(400).json({ error: "conversationIds array is required" });
      }

      // Dynamically import archiver
      const archiver = (await import('archiver')).default;

      // Fetch raw_data for all conversation IDs
      const webhookData = await storage.getWebhookDataByCallLogIds(conversationIds);

      if (webhookData.length === 0) {
        return res.status(404).json({ error: "No webhook data found for the provided conversation IDs" });
      }

      // Set response headers for zip download
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="conversations_${new Date().toISOString().split('T')[0]}.zip"`);

      // Create archive
      const archive = archiver('zip', {
        zlib: { level: 9 } // Maximum compression
      });

      // Handle archive errors
      archive.on('error', (err) => {
        console.error('Archive error:', err);
        res.status(500).json({ error: 'Failed to create archive' });
      });

      // Pipe archive to response
      archive.pipe(res);

      // Add each conversation's raw_data as a JSON file
      for (const data of webhookData) {
        const filename = `conversation_${data.callLogId}.json`;
        const jsonContent = JSON.stringify(JSON.parse(data.rawData), null, 2);
        archive.append(jsonContent, { name: filename });
      }

      // Finalize the archive
      await archive.finalize();

    } catch (error) {
      console.error("Failed to download JSON:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to download JSON" });
      }
    }
  });

  // TwiML webhook endpoints
  app.post("/twiml/voice/:restaurantId", async (req, res) => {
    try {
      const { restaurantId } = req.params;
      const config = await storage.getAgentConfiguration(restaurantId);
      
      if (!config || !config.isActive) {
        // Return offline message
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thank you for calling. We are currently offline. Please try again later or visit our website to place an order.</Say>
  <Hangup/>
</Response>`;
        res.type('text/xml');
        return res.send(twiml);
      }

      let twiml = '';
      
      switch (config.mode) {
        case 'agent':
          // Redirect to ElevenLabs AI agent
          twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">https://api.us.elevenlabs.io/twilio/inbound_call</Redirect>
</Response>`;
          break;
          
        case 'forward':
          // Redirect to specified phone number
          twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Please hold while we connect you.</Say>
  <Dial>${config.redirectPhoneNumber}</Dial>
</Response>`;
          break;
          
        case 'offline':
        default:
          // Play offline message
          twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thank you for calling. We are currently offline. Please try again later or visit our website to place an order.</Say>
  <Hangup/>
</Response>`;
          break;
      }

      // Log the call
      await storage.createCallLog({
        restaurantId,
        customerPhone: req.body.From || 'unknown',
        status: 'in-progress',
      });

      res.type('text/xml');
      res.send(twiml);
    } catch (error) {
      console.error('TwiML error:', error);
      const errorTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">We're sorry, but we're experiencing technical difficulties. Please try calling again later.</Say>
  <Hangup/>
</Response>`;
      res.type('text/xml');
      res.send(errorTwiml);
    }
  });

  // TwiML status callback endpoint
  app.post("/twiml/status/:restaurantId", async (req, res) => {
    try {
      const { restaurantId } = req.params;
      const { CallSid, CallStatus, CallDuration, From } = req.body;
      
      console.log(`Status callback: CallSid=${CallSid}, Status=${CallStatus}, Duration=${CallDuration}, From=${From}`);
      
      let callLog = null;
      
      // First try to find by Twilio CallSid (most reliable)
      if (CallSid) {
        callLog = await storage.getCallLogByTwilioSid(CallSid);
      }
      
      // Fallback: find by phone number and restaurant (for existing calls without CallSid)
      if (!callLog && From && restaurantId) {
        const calls = await storage.getCallLogsByRestaurant(restaurantId, 100);
        callLog = calls.find(call => 
          call.customerPhone === From && 
          call.status === 'in-progress'
        );
      }
      
      if (callLog) {
        const updates: any = {
          status: CallStatus === 'completed' ? 'completed' : 'failed',
          lastPolledAt: new Date(),
        };
        
        // Add duration if available
        if (CallDuration && !callLog.duration) {
          updates.duration = parseInt(CallDuration);
        }
        
        // Store CallSid if we don't have it yet
        if (CallSid && !callLog.twilioCallSid) {
          updates.twilioCallSid = CallSid;
        }
        
        await storage.updateCallLog(callLog.id, updates);
        console.log(`Updated call log ${callLog.id} with status: ${updates.status}`);
        
        // Record usage when call is completed (with atomic idempotency check)
        if (CallStatus === 'completed' && !callLog.usageRecordedAt) {
          // Atomically claim this call for usage recording - only first caller succeeds
          const claimedForRecording = await storage.markUsageRecorded(callLog.id);
          
          if (claimedForRecording) {
            let stripeRecordingStarted = false;
            try {
              // Get the agent configuration to find the billing user
              const agentConfig = await storage.getAgentConfiguration(restaurantId);
              if (!agentConfig || !agentConfig.billingUserId) {
                console.warn(`Agent ${restaurantId} has no billing user set, rolling back usage claim`);
                // Reset the flag since we haven't started Stripe recording
                await storage.updateCallLog(callLog.id, { usageRecordedAt: null });
              } else {
                // Get duration from multiple sources (updates, existing log, or callback parameter)
                const durationSeconds = updates.duration ?? callLog.duration ?? Number(CallDuration ?? 0);
                
                // Always record call usage (1 call)
                await stripeService.recordUsage(agentConfig.billingUserId, restaurantId, "call", 1);
                stripeRecordingStarted = true; // Mark after first successful Stripe call
                
                // Record minute usage (convert seconds to minutes, rounded up)
                const minutes = Math.ceil(durationSeconds / 60);
                if (minutes > 0) {
                  await stripeService.recordUsage(agentConfig.billingUserId, restaurantId, "minute", minutes);
                }
                
                console.log(`Recorded usage for agent ${restaurantId}: 1 call, ${minutes} minutes (billed to user ${agentConfig.billingUserId})`);
              }
            } catch (usageError) {
              console.error('Failed to record usage:', usageError);
              // Only rollback if we haven't started Stripe recording to avoid partial-success duplicates
              if (!stripeRecordingStarted) {
                console.log('Rolling back usage claim to allow retry');
                await storage.updateCallLog(callLog.id, { usageRecordedAt: null });
              } else {
                console.log('Keeping usage claim to prevent duplicate billing despite error (usage may be partial)');
              }
            }
          } else {
            console.log(`Usage already recorded for call ${callLog.id}, skipping duplicate (CallSid: ${CallSid})`);
          }
        } else if (CallStatus === 'completed' && callLog.usageRecordedAt) {
          console.log(`Usage already recorded for call ${callLog.id}, skipping duplicate (CallSid: ${CallSid})`);
        }
      } else {
        console.log(`No call log found for CallSid=${CallSid}, From=${From}, Restaurant=${restaurantId}`);
      }

      res.status(200).send('OK');
    } catch (error) {
      console.error('Status callback error:', error);
      res.status(500).send('Error');
    }
  });

  // ElevenLabs webhook endpoint for post-call transcription
  app.post("/api/elevenlabs/webhook", async (req, res) => {
    // Log all incoming webhook requests immediately
    const timestamp = new Date().toISOString();
    console.log(`[ElevenLabs Webhook] Received request at ${timestamp}`);
    console.log(`[ElevenLabs Webhook] Headers:`, JSON.stringify(req.headers));
    console.log(`[ElevenLabs Webhook] Body type:`, req.body?.type);
    
    // Return 200 immediately to prevent webhook auto-disable
    // Process the webhook asynchronously
    res.status(200).json({ success: true, received: timestamp });
    
    // Process webhook asynchronously
    (async () => {
      try {
        const webhookData = req.body;
        
        // Log the full payload for debugging (truncate if too large)
        const payloadStr = JSON.stringify(webhookData);
        if (payloadStr.length > 1000) {
          console.log(`[ElevenLabs Webhook] Payload preview:`, payloadStr.substring(0, 1000) + '...');
        } else {
          console.log(`[ElevenLabs Webhook] Full payload:`, payloadStr);
        }
        
        // Validate webhook type
        if (webhookData.type !== 'post_call_transcription') {
          console.log(`[ElevenLabs Webhook] Skipping non-transcription webhook type: ${webhookData.type}`);
          return;
        }

        console.log(`[ElevenLabs Webhook] Processing post_call_transcription webhook`);

        const data = webhookData.data;
        if (!data) {
          console.error('[ElevenLabs Webhook] ERROR: No data in webhook payload');
          return;
        }

        // Extract Twilio Call SID from dynamic variables
        const twilioCallSid = data.conversation_initiation_client_data?.dynamic_variables?.system__call_sid;
        if (!twilioCallSid) {
          console.error('[ElevenLabs Webhook] ERROR: No Twilio Call SID found in webhook data');
          console.error('[ElevenLabs Webhook] Dynamic variables:', JSON.stringify(data.conversation_initiation_client_data?.dynamic_variables));
          return;
        }

        console.log(`[ElevenLabs Webhook] Processing webhook for Twilio Call SID: ${twilioCallSid}`);

        // Find the corresponding call log
        const callLog = await storage.getCallLogByTwilioSid(twilioCallSid);
        if (!callLog) {
          console.error(`[ElevenLabs Webhook] ERROR: No call log found for Twilio SID: ${twilioCallSid}`);
          return;
        }

        console.log(`[ElevenLabs Webhook] Found call log ID: ${callLog.id}`);

        // Store raw webhook data
        const conversationId = data.conversation_id || null;
        const eventTimestamp = webhookData.event_timestamp ? new Date(webhookData.event_timestamp * 1000) : null;
        
        console.log(`[ElevenLabs Webhook] Storing raw webhook data (conversation_id: ${conversationId})`);
        await storage.createElevenlabsWebhook({
          id: nanoid(),
          callLogId: callLog.id,
          conversationId,
          rawData: JSON.stringify(webhookData),
          eventTimestamp,
        });
        console.log(`[ElevenLabs Webhook] Raw webhook data stored successfully`);

        // Store conversation ID in call log for future audio retrieval
        if (conversationId) {
          await storage.updateCallLog(callLog.id, {
            elevenlabsConversationId: conversationId,
          });
          console.log(`[ElevenLabs Webhook] Stored conversation ID in call log`);
          
          // Retrieve audio URL immediately after storing conversation ID
          try {
            console.log(`[ElevenLabs Webhook] Attempting to retrieve audio for conversation ${conversationId}`);
            const { elevenlabsService } = await import('./services/elevenlabsService');
            const audioResult = await elevenlabsService.retrieveConversationAudio(callLog.id, conversationId);
            
            if (audioResult.success && audioResult.audioUrl) {
              console.log(`[ElevenLabs Webhook] Successfully retrieved audio URL: ${audioResult.audioUrl}`);
              console.log(`[ElevenLabs Webhook] Audio file size: ${audioResult.fileSize} bytes`);
            } else {
              console.log(`[ElevenLabs Webhook] Could not retrieve audio yet: ${audioResult.error || 'Unknown error'}`);
              console.log(`[ElevenLabs Webhook] Audio will be retrieved later via process-audio endpoint`);
            }
          } catch (audioError) {
            console.error(`[ElevenLabs Webhook] Error retrieving audio:`, audioError);
            console.log(`[ElevenLabs Webhook] Audio will be retrieved later via process-audio endpoint`);
          }
        }

        // Extract and update call log with analysis data
        const analysis = data.analysis;
        const metadata = data.metadata;
        
        if (analysis || metadata) {
          const updates: any = {};
          
          if (analysis) {
            if (analysis.transcript_summary) {
              updates.summary = analysis.transcript_summary;
              console.log(`[ElevenLabs Webhook] Found transcript summary (${analysis.transcript_summary.length} chars)`);
            }
            if (analysis.call_summary_title) {
              updates.summaryTitle = analysis.call_summary_title;
              console.log(`[ElevenLabs Webhook] Found call summary title: ${analysis.call_summary_title}`);
            }
          }
          
          if (metadata) {
            if (metadata.main_language) {
              updates.mainLanguage = metadata.main_language;
              console.log(`[ElevenLabs Webhook] Main language: ${metadata.main_language}`);
            }
            
            // Check if call was transferred to human
            if (metadata.features_usage?.transfer_to_number?.used) {
              updates.transferredToHuman = metadata.features_usage.transfer_to_number.used;
              console.log(`[ElevenLabs Webhook] Transfer to human: ${metadata.features_usage.transfer_to_number.used}`);
            }
          }
          
          // Extract and store tool calls from transcript
          const transcript = data.transcript || [];
          const toolCalls = transcript
            .filter((msg: any) => msg.role === 'agent' && msg.tool_calls && msg.tool_calls.length > 0)
            .flatMap((msg: any) => msg.tool_calls);
          
          if (toolCalls.length > 0) {
            updates.toolCallsJson = JSON.stringify(toolCalls);
            console.log(`[ElevenLabs Webhook] Found ${toolCalls.length} tool calls`);
          }
          
          if (Object.keys(updates).length > 0) {
            await storage.updateCallLog(callLog.id, updates);
            console.log(`[ElevenLabs Webhook] Updated call log ${callLog.id} with ${Object.keys(updates).length} fields`);
          }
        }

        // Parse and store transcript messages
        const transcript = data.transcript || [];
        const transcriptMessages: any[] = [];
        
        console.log(`[ElevenLabs Webhook] Processing ${transcript.length} transcript entries`);
        
        for (const msg of transcript) {
          const timeInCallSecs = msg.time_in_call_secs || 0;
          
          if (msg.role === 'agent' || msg.role === 'user') {
            // Store regular agent/user messages
            if (msg.message) {
              transcriptMessages.push({
                id: nanoid(),
                callLogId: callLog.id,
                messageType: msg.role,
                content: msg.message,
                timeInCallSecs,
              });
            }
            
            // Store tool calls
            if (msg.tool_calls && msg.tool_calls.length > 0) {
              for (const toolCall of msg.tool_calls) {
                transcriptMessages.push({
                  id: nanoid(),
                  callLogId: callLog.id,
                  messageType: 'tool_call',
                  content: null,
                  timeInCallSecs,
                  toolCallData: JSON.stringify(toolCall),
                });
              }
            }
            
            // Store tool results
            if (msg.tool_results && msg.tool_results.length > 0) {
              for (const toolResult of msg.tool_results) {
                transcriptMessages.push({
                  id: nanoid(),
                  callLogId: callLog.id,
                  messageType: 'tool_result',
                  content: null,
                  timeInCallSecs,
                  toolCallData: JSON.stringify(toolResult),
                });
              }
            }
          }
        }
        
        if (transcriptMessages.length > 0) {
          await storage.createTranscriptMessages(transcriptMessages);
          console.log(`[ElevenLabs Webhook] Stored ${transcriptMessages.length} transcript messages for call ${callLog.id}`);
        }

        console.log(`[ElevenLabs Webhook] Successfully processed webhook for call log ${callLog.id}`);
      } catch (error) {
        console.error('[ElevenLabs Webhook] ERROR during async processing:', error);
        if (error instanceof Error) {
          console.error('[ElevenLabs Webhook] Error stack:', error.stack);
        }
      }
    })();
  });

  // Get transcript for a specific call log
  app.get("/api/call-logs/:id/transcript", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { id } = req.params;
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get the call log to verify access
      const callLog = await storage.getCallLogById(id);
      if (!callLog) {
        return res.status(404).json({ error: "Call log not found" });
      }

      // Check if user has access to this restaurant's data
      if (currentUser.role !== "admin") {
        const agentConfig = await storage.getAgentConfiguration(callLog.restaurantId);
        if (!agentConfig) {
          return res.status(403).json({ error: "Forbidden" });
        }
        
        const hasAccess = await storage.hasUserAgentAccess(currentUser.id, agentConfig.id);
        if (!hasAccess) {
          return res.status(403).json({ error: "Forbidden" });
        }
      }

      // Get transcript messages
      const transcriptMessages = await storage.getTranscriptMessagesByCallLogId(callLog.id);
      
      res.json({
        callLog,
        transcript: transcriptMessages,
      });
    } catch (error) {
      console.error('Error fetching transcript:', error);
      res.status(500).json({ error: 'Failed to fetch transcript' });
    }
  });

  // Get raw webhook data for a specific call log
  app.get("/api/call-logs/:id/webhook-data", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { id } = req.params;
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get the call log to verify access
      const callLog = await storage.getCallLogById(id);
      if (!callLog) {
        return res.status(404).json({ error: "Call log not found" });
      }

      // Check if user has access to this restaurant's data
      if (currentUser.role !== "admin") {
        const agentConfig = await storage.getAgentConfiguration(callLog.restaurantId);
        if (!agentConfig) {
          return res.status(403).json({ error: "Forbidden" });
        }
        
        const hasAccess = await storage.hasUserAgentAccess(currentUser.id, agentConfig.id);
        if (!hasAccess) {
          return res.status(403).json({ error: "Forbidden" });
        }
      }

      // Get webhook data
      const webhookData = await storage.getElevenlabsWebhookByCallLogId(callLog.id);
      if (!webhookData) {
        return res.status(404).json({ error: "Webhook data not found" });
      }

      res.json(webhookData);
    } catch (error) {
      console.error('Error fetching webhook data:', error);
      res.status(500).json({ error: 'Failed to fetch webhook data' });
    }
  });

  // Serve audio files for call logs from object storage
  app.get("/api/audio/:callLogId", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { callLogId } = req.params;
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get the call log to get the audio path
      const callLog = await storage.getCallLogById(callLogId);
      if (!callLog) {
        return res.status(404).json({ error: "Call log not found" });
      }

      // Check if audio file path exists
      if (!callLog.localAudioPath) {
        return res.status(404).json({ error: "Audio file not found" });
      }

      // Check if this is a legacy local filesystem path or new object storage path
      const isLegacyPath = callLog.localAudioPath.startsWith('server/storage/');
      
      if (isLegacyPath) {
        // Legacy path - serve from local filesystem (backward compatibility)
        const audioPath = path.resolve(process.cwd(), callLog.localAudioPath);
        
        if (!fs.existsSync(audioPath)) {
          console.error(`Legacy audio file not found at path: ${audioPath}`);
          return res.status(404).json({ error: "Audio file not found on disk" });
        }

        // Set appropriate headers for audio streaming
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Content-Disposition", `inline; filename="${callLogId}.mp3"`);
        res.setHeader("Cache-Control", "private, max-age=3600");

        // Stream the audio file
        const readStream = fs.createReadStream(audioPath);
        readStream.pipe(res);
        
        readStream.on('error', (error) => {
          console.error('Error streaming legacy audio file:', error);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to stream audio file' });
          }
        });
      } else {
        // New object storage path - retrieve from object storage
        const { ObjectStorageService, ObjectNotFoundError } = await import('./objectStorage');
        const { ObjectPermission } = await import('./objectAcl');
        const objectStorage = new ObjectStorageService();

        try {
          const objectFile = await objectStorage.getObjectEntityFile(callLog.localAudioPath);
          
          // Check if user has access to this audio file (ACL check)
          const canAccess = await objectStorage.canAccessObjectEntity({
            objectFile,
            userId: currentUser.id,
            requestedPermission: ObjectPermission.READ,
          });
          
          if (!canAccess) {
            return res.status(403).json({ error: "Access denied" });
          }

          // Stream the audio file from object storage
          await objectStorage.downloadObject(objectFile, res);
        } catch (error) {
          console.error('Error retrieving audio from object storage:', error);
          if (error instanceof ObjectNotFoundError) {
            return res.status(404).json({ error: "Audio file not found in storage" });
          }
          throw error;
        }
      }
    } catch (error) {
      console.error('Error serving audio file:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to serve audio file' });
      }
    }
  });

  // Dashboard statistics
  app.get("/api/restaurants/:id/stats", async (req, res) => {
    try {
      const { id } = req.params;
      const calls = await storage.getCallLogsByRestaurant(id);
      
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const todayCalls = calls.filter(call => call.createdAt && call.createdAt >= today);
      const completedCalls = todayCalls.filter(call => call.status === 'completed');
      const totalDuration = completedCalls.reduce((sum, call) => sum + (call.duration || 0), 0);
      const avgDuration = completedCalls.length > 0 ? Math.round(totalDuration / completedCalls.length) : 0;
      const totalValue = completedCalls.reduce((sum, call) => sum + (call.orderValue || 0), 0);

      const inProgressCalls = calls.filter(call => call.status === 'in-progress');
      const stats = {
        callsToday: todayCalls.length,
        callsInProgress: inProgressCalls.length,
        avgDuration: `${Math.floor(avgDuration / 60)}:${(avgDuration % 60).toString().padStart(2, '0')}`,
        totalValue: totalValue / 100, // Convert cents to dollars
      };

      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: "Failed to get statistics" });
    }
  });

  // User-Agent Access routes
  app.get("/api/users/:userId/agent-access", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { userId } = req.params;
      const userAccess = await storage.getUserAgentAccess(userId);
      res.json(userAccess);
    } catch (error) {
      console.error("Failed to get user agent access:", error);
      res.status(500).json({ error: "Failed to get user agent access" });
    }
  });


  // Create user-agent link (idempotent)
  app.post("/api/users/:userId/agents/:agentConfigId", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { userId, agentConfigId } = req.params;
      
      // Check if link already exists
      const exists = await storage.hasUserAgentAccess(userId, agentConfigId);
      if (exists) {
        return res.json({ message: "User already has access to this agent" });
      }
      
      const accessData = { userId, agentConfigurationId: agentConfigId };
      const userAccess = await storage.createUserAgentAccess(accessData);
      res.json(userAccess);
    } catch (error) {
      console.error("Failed to link user to agent:", error);
      res.status(500).json({ error: "Failed to link user to agent" });
    }
  });

  app.delete("/api/users/:userId/agents/:agentConfigId", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { userId, agentConfigId } = req.params;
      const deleted = await storage.deleteUserAgentAccess(userId, agentConfigId);
      
      if (!deleted) {
        return res.status(404).json({ error: "User agent access not found" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Failed to delete user agent access:", error);
      res.status(500).json({ error: "Failed to delete user agent access" });
    }
  });

  // Get agents accessible to the current user
  app.get("/api/my/agents", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }

      const userAgents = await storage.getAgentsForUser(currentUser.id);
      res.json(userAgents);
    } catch (error) {
      console.error("Failed to get user agents:", error);
      res.status(500).json({ error: "Failed to get user agents" });
    }
  });

  // KDS Integration: Get agents for a specific Firebase user
  // This endpoint is designed for external services (like KDS) to retrieve user agents
  app.get("/api/kds/user-agents/:firebaseUid", async (req, res) => {
    try {
      // Validate API key for secure access
      const apiKey = req.headers['x-api-key'] || req.query.api_key;
      const validApiKey = process.env.KDS_API_KEY;
      
      if (!validApiKey || apiKey !== validApiKey) {
        return res.status(401).json({ error: "Invalid or missing API key" });
      }

      const { firebaseUid } = req.params;
      if (!firebaseUid) {
        return res.status(400).json({ error: "Firebase UID is required" });
      }

      // Find user by Firebase UID
      const user = await storage.getUserByFirebaseUid(firebaseUid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get agents for this user with simplified response
      const userAgents = await storage.getAgentsForUser(user.id);
      
      // Return simplified list with ID, name, and elevenlabs agent ID
      const simplifiedAgents = userAgents.map(agent => ({
        id: agent.id,
        name: agent.agentName,
        mode: agent.mode,
        isActive: agent.isActive,
        elevenlabsAgentId: agent.elevenlabsAgentId || null
      }));

      res.json({
        userId: user.id,
        firebaseUid: firebaseUid,
        agents: simplifiedAgents
      });
    } catch (error) {
      console.error("KDS API error:", error);
      res.status(500).json({ error: "Failed to retrieve user agents" });
    }
  });

  // Get all agent configurations (for dropdown selections)
  app.get("/api/agent-configurations", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const restaurants = await storage.getAllRestaurants();
      const agentConfigs = [];
      
      for (const restaurant of restaurants) {
        const config = await storage.getAgentConfiguration(restaurant.id);
        if (config) {
          // Get billing user info
          const billingUser = await storage.getUser(config.billingUserId);
          
          // Get enabled skills count
          const agentSkills = await storage.getAgentSkillsByAgentConfigurationId(config.id);
          const enabledSkillsCount = agentSkills.length;
          
          // Get last call
          const lastCall = await storage.getLastCallForRestaurant(restaurant.id);
          
          // Get linked phone number
          let linkedPhoneNumber = null;
          if (config.phoneNumberId) {
            const phoneNumber = await storage.getPhoneNumber(config.phoneNumberId);
            linkedPhoneNumber = phoneNumber?.phoneNumber || null;
          }
          
          agentConfigs.push({
            ...config,
            agentName: restaurant.name,
            restaurantId: restaurant.id,
            restaurantName: restaurant.name,
            billingUserEmail: billingUser?.email || null,
            billingUserPlan: billingUser?.subscriptionPlan || null,
            enabledSkillsCount,
            lastCallTime: lastCall?.createdAt || null,
            phoneNumber: linkedPhoneNumber, // Add the linked phone number
          });
        }
      }
      
      res.json(agentConfigs);
    } catch (error) {
      console.error("Failed to get agent configurations:", error);
      res.status(500).json({ error: "Failed to get agent configurations" });
    }
  });

  // Public endpoint to get agent details by phone number with API key authentication
  app.get("/api/agent/phone", async (req, res) => {
    try {
      // Check for API key authentication
      const authHeader = req.headers.authorization;
      const token = authHeader?.replace("Bearer ", "");
      
      if (!token || token !== process.env.AGENT_API_KEY) {
        return res.status(401).json({ error: "Invalid or missing API key" });
      }

      // Get phone number from query parameter
      const phoneNumber = req.query.phone as string;
      
      if (!phoneNumber) {
        return res.status(400).json({ error: "Phone number parameter is required" });
      }

      // Fetch agent configuration by phone number
      const agentConfig = await storage.getAgentConfigurationByPhoneNumber(phoneNumber);
      
      if (!agentConfig) {
        return res.status(404).json({ error: "Agent configuration not found for this phone number" });
      }

      // Fetch the agent's skills with method details
      const agentSkillsWithMethods = await storage.getAgentSkillsWithMethodDetails(agentConfig.id);

      // Fetch the linked printer if any
      let printerSerialNumber = null;
      if (agentConfig.printerId) {
        const printer = await storage.getPrinter(agentConfig.printerId);
        if (printer) {
          printerSerialNumber = printer.serialNumber;
        }
      }

      // Fetch active menu overrides
      const activeOverrides = await storage.getActiveOverridesByAgentId(agentConfig.id);

      // Return all agent properties including restaurant name, skills, printer serial number, and active overrides
      res.json({
        ...agentConfig,
        skills: agentSkillsWithMethods,
        ottoPrinterSerial: printerSerialNumber, // Include printer serial number as ottoPrinterSerial for backward compatibility
        menuOverrides: activeOverrides.map(override => ({
          id: override.id,
          content: override.content,
          resetAt: override.resetAt,
          lastModifiedBy: override.modifiedByName,
          lastModifiedAt: override.lastModifiedAt
        }))
      });
    } catch (error) {
      console.error("Failed to get agent by phone number:", error);
      res.status(500).json({ error: "Failed to get agent configuration" });
    }
  });

  // Skills routes (admin only)
  app.get("/api/skills", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const skills = await storage.getAllSkills();
      res.json(skills);
    } catch (error) {
      console.error("Failed to get skills:", error);
      res.status(500).json({ error: "Failed to get skills" });
    }
  });

  app.post("/api/skills", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const skillData = insertSkillSchema.parse(req.body);
      const skill = await storage.createSkill(skillData);
      res.json(skill);
    } catch (error) {
      console.error("Failed to create skill:", error);
      res.status(400).json({ error: "Invalid skill data" });
    }
  });

  app.get("/api/skills/active", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const activeSkillsWithMethods = await storage.getActiveSkillsWithMethods();
      res.json(activeSkillsWithMethods);
    } catch (error) {
      console.error("Failed to get active skills:", error);
      res.status(500).json({ error: "Failed to get active skills" });
    }
  });

  app.get("/api/skills/with-methods", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const allSkillsWithMethods = await storage.getAllSkillsWithMethods();
      res.json(allSkillsWithMethods);
    } catch (error) {
      console.error("Failed to get skills with methods:", error);
      res.status(500).json({ error: "Failed to get skills with methods" });
    }
  });

  app.get("/api/skills/:id", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const skill = await storage.getSkill(req.params.id);
      if (!skill) {
        return res.status(404).json({ error: "Skill not found" });
      }
      res.json(skill);
    } catch (error) {
      console.error("Failed to get skill:", error);
      res.status(500).json({ error: "Failed to get skill" });
    }
  });

  app.put("/api/skills/:id", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const updateData = updateSkillSchema.parse(req.body);
      const skill = await storage.updateSkill(req.params.id, updateData);
      if (!skill) {
        return res.status(404).json({ error: "Skill not found" });
      }
      res.json(skill);
    } catch (error) {
      console.error("Failed to update skill:", error);
      res.status(400).json({ error: "Invalid skill data" });
    }
  });

  app.delete("/api/skills/:id", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const deleted = await storage.deleteSkill(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: "Skill not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to delete skill:", error);
      res.status(500).json({ error: "Failed to delete skill" });
    }
  });

  // Methods routes (admin only)
  app.get("/api/skills/:skillId/methods", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const methods = await storage.getMethodsBySkillId(req.params.skillId);
      res.json(methods);
    } catch (error) {
      console.error("Failed to get methods:", error);
      res.status(500).json({ error: "Failed to get methods" });
    }
  });

  app.post("/api/skills/:skillId/methods", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Parse method data without skillId since we'll add it from params
      const methodData = insertMethodSchema.omit({ skillId: true }).parse(req.body);
      const method = await storage.createMethod({
        ...methodData,
        skillId: req.params.skillId
      });
      res.json(method);
    } catch (error) {
      console.error("Failed to create method:", error);
      res.status(400).json({ error: "Invalid method data" });
    }
  });

  app.put("/api/methods/:id", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const updateData = updateMethodSchema.parse(req.body);
      const method = await storage.updateMethod(req.params.id, updateData);
      if (!method) {
        return res.status(404).json({ error: "Method not found" });
      }
      res.json(method);
    } catch (error) {
      console.error("Failed to update method:", error);
      res.status(400).json({ error: "Invalid method data" });
    }
  });

  app.delete("/api/methods/:id", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const deleted = await storage.deleteMethod(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: "Method not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to delete method:", error);
      res.status(500).json({ error: "Failed to delete method" });
    }
  });

  // Printers routes (admin only)
  app.get("/api/printers", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const printers = await storage.getAllPrinters();
      res.json(printers);
    } catch (error) {
      console.error("Failed to get printers:", error);
      res.status(500).json({ error: "Failed to get printers" });
    }
  });

  app.post("/api/printers", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const printerData = insertPrinterSchema.parse(req.body);
      const printer = await storage.createPrinter(printerData);
      res.json(printer);
    } catch (error) {
      console.error("Failed to create printer:", error);
      res.status(400).json({ error: "Invalid printer data" });
    }
  });

  app.patch("/api/printers/:id", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const updateData = updatePrinterSchema.parse(req.body);
      const printer = await storage.updatePrinter(req.params.id, updateData);
      if (!printer) {
        return res.status(404).json({ error: "Printer not found" });
      }
      res.json(printer);
    } catch (error) {
      console.error("Failed to update printer:", error);
      res.status(400).json({ error: "Invalid printer data" });
    }
  });

  app.delete("/api/printers/:id", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const deleted = await storage.deletePrinter(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: "Printer not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to delete printer:", error);
      res.status(500).json({ error: "Failed to delete printer" });
    }
  });

  // Phone Numbers routes (admin only)
  app.get("/api/phone-numbers", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const phoneNumbers = await storage.getAllPhoneNumbers();
      res.json(phoneNumbers);
    } catch (error) {
      console.error("Failed to get phone numbers:", error);
      res.status(500).json({ error: "Failed to get phone numbers" });
    }
  });

  app.post("/api/phone-numbers", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const phoneNumberData = insertPhoneNumberSchema.parse(req.body);
      const phoneNumber = await storage.createPhoneNumber(phoneNumberData);
      res.json(phoneNumber);
    } catch (error) {
      console.error("Failed to create phone number:", error);
      res.status(400).json({ error: "Invalid phone number data" });
    }
  });

  app.put("/api/phone-numbers/:id", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const updateData = updatePhoneNumberSchema.parse(req.body);
      
      // Get the current phone number to preserve existing values
      const existingPhoneNumber = await storage.getPhoneNumber(req.params.id);
      if (!existingPhoneNumber) {
        return res.status(404).json({ error: "Phone number not found" });
      }
      
      // Only include webhook URLs in update if they are explicitly provided (not empty)
      const filteredUpdateData = { ...updateData };
      if (updateData.voiceUrl === undefined || updateData.voiceUrl === '') {
        delete filteredUpdateData.voiceUrl;
      }
      if (updateData.statusUrl === undefined || updateData.statusUrl === '') {
        delete filteredUpdateData.statusUrl;
      }
      
      const phoneNumber = await storage.updatePhoneNumber(req.params.id, filteredUpdateData);
      
      // If Twilio SID is available and webhooks are being updated, sync with Twilio
      // Only update if we are EXPLICITLY setting webhook URLs (not undefined)
      if (phoneNumber?.twilioSid && (filteredUpdateData.voiceUrl !== undefined || filteredUpdateData.statusUrl !== undefined)) {
        try {
          // Only pass values that are actually being updated, preserving existing values
          const voiceUrlToSet = filteredUpdateData.voiceUrl !== undefined ? filteredUpdateData.voiceUrl : phoneNumber.voiceUrl;
          const statusUrlToSet = filteredUpdateData.statusUrl !== undefined ? filteredUpdateData.statusUrl : phoneNumber.statusUrl;
          
          console.log(`Updating Twilio webhooks for ${phoneNumber.phoneNumber}: voice=${voiceUrlToSet}, status=${statusUrlToSet}`);
          await updatePhoneNumberWebhooks(
            phoneNumber.twilioSid,
            voiceUrlToSet || undefined,
            statusUrlToSet || undefined
          );
        } catch (twilioError) {
          console.error("Failed to update Twilio webhooks:", twilioError);
        }
      }
      
      if (!phoneNumber) {
        return res.status(404).json({ error: "Phone number not found" });
      }
      res.json(phoneNumber);
    } catch (error) {
      console.error("Failed to update phone number:", error);
      res.status(400).json({ error: "Invalid phone number data" });
    }
  });

  app.delete("/api/phone-numbers/:id", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const deleted = await storage.deletePhoneNumber(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: "Phone number not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to delete phone number:", error);
      res.status(500).json({ error: "Failed to delete phone number" });
    }
  });

  app.post("/api/phone-numbers/:id/refresh", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Get the phone number from database
      const phoneNumber = await storage.getPhoneNumber(req.params.id);
      if (!phoneNumber) {
        return res.status(404).json({ error: "Phone number not found" });
      }

      if (!phoneNumber.twilioSid) {
        return res.status(400).json({ error: "Phone number does not have a Twilio SID" });
      }

      // Fetch latest details from Twilio
      const twilioDetails = await getPhoneNumberDetails(phoneNumber.twilioSid);
      if (!twilioDetails) {
        return res.status(404).json({ error: "Phone number not found in Twilio" });
      }

      // Update the database with the latest details
      const updated = await storage.updatePhoneNumber(req.params.id, {
        friendlyName: twilioDetails.friendlyName,
        locality: twilioDetails.locality || null,
        region: twilioDetails.region || null,
      });

      res.json(updated);
    } catch (error) {
      console.error("Failed to refresh phone number:", error);
      res.status(500).json({ error: "Failed to refresh phone number from Twilio" });
    }
  });

  // Twilio integration endpoints
  app.post("/api/phone-numbers/check-existing", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { phoneNumber } = req.body;
      if (!phoneNumber) {
        return res.status(400).json({ error: "Phone number is required" });
      }

      const twilioNumber = await checkExistingNumber(phoneNumber);
      if (!twilioNumber) {
        return res.status(404).json({ error: "Phone number not found in Twilio account" });
      }

      // Check if number already exists in database
      const existingNumber = await storage.getPhoneNumberByNumber(twilioNumber.phoneNumber);
      if (existingNumber) {
        // Return the existing number with a flag indicating it already existed
        return res.json({ 
          ...existingNumber, 
          alreadyExists: true 
        });
      }

      // Add to database
      const created = await storage.createPhoneNumber({
        phoneNumber: twilioNumber.phoneNumber,
        friendlyName: twilioNumber.friendlyName,
        voiceUrl: twilioNumber.voiceUrl,
        statusUrl: twilioNumber.statusCallback,
        twilioSid: twilioNumber.sid,
        capabilities: JSON.stringify(twilioNumber.capabilities),
        status: "active",
      });

      res.json({ ...created, alreadyExists: false });
    } catch (error) {
      console.error("Failed to check existing phone number:", error);
      res.status(500).json({ error: "Failed to check existing phone number" });
    }
  });

  app.post("/api/phone-numbers/search-available", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { country, areaCode, contains, numberType } = req.body;

      const availableNumbers = await searchAvailableNumbers({
        country,
        areaCode,
        contains,
        numberType,
        limit: 20
      });
      
      res.json(availableNumbers);
    } catch (error) {
      console.error("Failed to search available phone numbers:", error);
      res.status(500).json({ error: "Failed to search available phone numbers" });
    }
  });

  app.post("/api/phone-numbers/purchase", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { phoneNumber: number, locality, region, country } = req.body;
      if (!number) {
        return res.status(400).json({ error: "Phone number is required" });
      }

      // HungryHungry address SID for phone number registration
      const HUNGRYHUNGRY_ADDRESS_SID = "AD8933bb97d771aef75ca180a7479d9ad8";

      // Purchase from Twilio with address
      const twilioNumber = await purchasePhoneNumber(number, undefined, HUNGRYHUNGRY_ADDRESS_SID);

      // Add to database
      const created = await storage.createPhoneNumber({
        phoneNumber: twilioNumber.phoneNumber,
        friendlyName: twilioNumber.friendlyName,
        voiceUrl: twilioNumber.voiceUrl,
        statusUrl: twilioNumber.statusCallback,
        twilioSid: twilioNumber.sid,
        capabilities: JSON.stringify(twilioNumber.capabilities),
        status: "active",
        locality: locality,
        region: region,
        country: country || "US",
        areaCode: twilioNumber.phoneNumber.substring(2, 5), // Extract area code from +1XXX...
      });

      res.json(created);
    } catch (error) {
      console.error("Failed to purchase phone number:", error);
      res.status(500).json({ error: "Failed to purchase phone number" });
    }
  });

  // Webhook sync endpoints (admin only)
  app.get("/api/restaurants/:restaurantId/webhook-status", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { restaurantId } = req.params;
      const { voiceUrl, statusCallback } = req.query as { voiceUrl?: string, statusCallback?: string };

      // Get the agent configuration for this restaurant
      const agentConfig = await storage.getAgentConfiguration(restaurantId);
      if (!agentConfig) {
        return res.status(404).json({ error: "Agent configuration not found" });
      }

      if (!agentConfig.phoneNumberId) {
        return res.status(400).json({ error: "Agent does not have a linked phone number" });
      }

      // Get the phone number details
      const phoneNumber = await storage.getPhoneNumber(agentConfig.phoneNumberId);
      if (!phoneNumber || !phoneNumber.twilioSid) {
        return res.status(400).json({ error: "Phone number not found or missing Twilio SID" });
      }

      // Get the current webhook configuration from Twilio
      const twilioDetails = await getPhoneNumberDetails(phoneNumber.twilioSid);
      if (!twilioDetails) {
        return res.status(404).json({ error: "Phone number not found in Twilio" });
      }

      // Check if the provided URLs match what's in Twilio
      const voiceMatch = voiceUrl === twilioDetails.voiceUrl;
      const statusMatch = statusCallback === twilioDetails.statusCallback;

      res.json({
        voiceUrl: {
          current: twilioDetails.voiceUrl || "",
          expected: voiceUrl || "",
          inSync: voiceMatch
        },
        statusCallback: {
          current: twilioDetails.statusCallback || "",
          expected: statusCallback || "",
          inSync: statusMatch
        },
        allInSync: voiceMatch && statusMatch
      });
    } catch (error) {
      console.error("Failed to check webhook status:", error);
      res.status(500).json({ error: "Failed to check webhook status" });
    }
  });

  app.post("/api/restaurants/:restaurantId/sync-webhooks", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { restaurantId } = req.params;
      const { voiceUrl, statusCallback } = req.body;

      if (!voiceUrl || !statusCallback) {
        return res.status(400).json({ error: "Both voiceUrl and statusCallback are required" });
      }

      // Get the agent configuration for this restaurant
      const agentConfig = await storage.getAgentConfiguration(restaurantId);
      if (!agentConfig) {
        return res.status(404).json({ error: "Agent configuration not found" });
      }

      if (!agentConfig.phoneNumberId) {
        return res.status(400).json({ error: "Agent does not have a linked phone number" });
      }

      // Get the phone number details
      const phoneNumber = await storage.getPhoneNumber(agentConfig.phoneNumberId);
      if (!phoneNumber || !phoneNumber.twilioSid) {
        return res.status(400).json({ error: "Phone number not found or missing Twilio SID" });
      }

      // Update the webhook URLs in Twilio
      await updatePhoneNumberWebhooks(phoneNumber.twilioSid, voiceUrl, statusCallback);

      // Update the local database to keep in sync
      await storage.updatePhoneNumber(agentConfig.phoneNumberId, {
        voiceUrl,
        statusUrl: statusCallback,
      });

      res.json({ success: true, message: "Webhook URLs successfully synced to Twilio" });
    } catch (error) {
      console.error("Failed to sync webhooks:", error);
      res.status(500).json({ error: "Failed to sync webhook URLs to Twilio" });
    }
  });

  // Platform Settings routes (admin only)
  app.get("/api/platform-settings", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      let settings = await storage.getPlatformSettings();
      
      // If settings don't exist, create default settings
      if (!settings) {
        settings = await storage.createPlatformSettings({
          newUserNotificationWebhook: "",
          newAgentNotificationWebhook: "",
          baseInstructions: "",
          personality: "",
        });
      }

      res.json(settings);
    } catch (error) {
      console.error("Failed to get platform settings:", error);
      res.status(500).json({ error: "Failed to get platform settings" });
    }
  });

  app.put("/api/platform-settings/:id", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { id } = req.params;
      const settingsData = updatePlatformSettingsSchema.parse(req.body);
      const updated = await storage.updatePlatformSettings(id, settingsData);

      if (!updated) {
        return res.status(404).json({ error: "Platform settings not found" });
      }

      res.json(updated);
    } catch (error) {
      console.error("Failed to update platform settings:", error);
      res.status(400).json({ error: "Invalid platform settings data" });
    }
  });

  // Generate venue details from SerpAPI and ChatGPT
  app.post("/api/venues/generate-details", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { placeId } = z.object({
        placeId: z.string().min(1)
      }).parse(req.body);

      // Call SerpAPI to get place details
      const serpApiKey = process.env.SERPAPI_KEY;
      if (!serpApiKey) {
        throw new Error("SERPAPI_KEY not configured");
      }

      const serpApiUrl = `https://serpapi.com/search.json?engine=google_maps&q=&place_id=${placeId}&api_key=${serpApiKey}`;
      const serpResponse = await fetch(serpApiUrl);
      
      if (!serpResponse.ok) {
        throw new Error(`SerpAPI request failed: ${serpResponse.statusText}`);
      }

      const serpData = await serpResponse.json();

      // Process with ChatGPT
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey) {
        throw new Error("OPENAI_API_KEY not configured");
      }

      const prompt = `Take this data about a venue and populate a textbox with important information about the venue that will be used as a part of a prompt for the venue's AI voice agent. Focus on key details like cuisine type, ambiance, special features, services offered, and any unique characteristics. Keep it concise but informative.

Venue Data: ${JSON.stringify(serpData)}`;

      const chatGptResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${openaiKey}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are a helpful assistant that creates concise venue descriptions for AI voice agents." },
            { role: "user", content: prompt }
          ],
          temperature: 0.7
        })
      });

      if (!chatGptResponse.ok) {
        const errorText = await chatGptResponse.text();
        throw new Error(`OpenAI request failed: ${chatGptResponse.statusText} - ${errorText}`);
      }

      const chatGptData = await chatGptResponse.json();
      const venueDetails = chatGptData.choices[0]?.message?.content || "";

      // Extract menu URL from SerpAPI data, fallback to website URL if no menu URL
      const menuUrl = serpData.menu || serpData.website || "";

      res.json({ venueDetails, menuUrl });
    } catch (error) {
      console.error("Failed to generate venue details:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to generate venue details" });
    }
  });

  // Create agent with Building status
  app.post("/api/agents/create", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      // Regular users must have an active subscription to create agents (admins can create without subscription)
      if (user.role === "user" && (!user.subscriptionStatus || (user.subscriptionStatus !== "active" && user.subscriptionStatus !== "trialing"))) {
        return res.status(403).json({ error: "Sorry, we can't create an agent for you. Please head to billing to set up a subscription." });
      }

      // Parse the request data
      const { venueName, address, openingHours, venueDetails, placeId, menuUrl, onboardingStage, skills } = z.object({
        venueName: z.string().min(1).max(100),
        address: z.string().min(1),
        openingHours: z.string().optional(),
        venueDetails: z.string().optional(),
        placeId: z.string().optional(),
        menuUrl: z.string().optional(),
        onboardingStage: z.enum(["Building", "Complete"]).default("Building"),
        skills: z.array(z.object({
          skillId: z.string(),
          methodId: z.string()
        })).optional()
      }).parse(req.body);

      // Create the restaurant first
      const restaurant = await storage.createRestaurant({
        name: venueName,
        ownerId: user.id
      });

      // Update the agent configuration with the Building status and other details
      const updatedAgentConfig = await storage.updateAgentConfiguration(restaurant.id, {
        onboardingStage: onboardingStage || "Building",
        address: address,
        openingHours: openingHours || undefined,
        venueDetails: venueDetails || undefined,
        googlePlaceId: placeId || undefined,
        menuUrl: menuUrl || undefined,
      });

      // Create user-agent access relationship so the agent appears in user's My Agents page
      if (updatedAgentConfig) {
        await storage.createUserAgentAccess({
          userId: user.id,
          agentConfigurationId: updatedAgentConfig.id,
          accessLevel: "write"
        });

        // Create agent skills if provided
        if (skills && skills.length > 0) {
          for (const skill of skills) {
            await storage.createAgentSkill({
              agentConfigurationId: updatedAgentConfig.id,
              skillId: skill.skillId,
              methodId: skill.methodId
            });
          }
        }

        // Send webhook notification if configured
        try {
          const platformSettings = await storage.getPlatformSettings();
          if (platformSettings?.newAgentNotificationWebhook) {
            // Gather all agent data including skills
            const agentSkills = skills && skills.length > 0 
              ? await storage.getAgentSkillsByAgentConfigurationId(updatedAgentConfig.id)
              : [];

            const webhookPayload = {
              restaurant,
              agentConfiguration: updatedAgentConfig,
              skills: agentSkills,
              createdBy: user.email,
              createdAt: new Date().toISOString()
            };

            // Send webhook asynchronously (don't block response)
            fetch(platformSettings.newAgentNotificationWebhook, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(webhookPayload)
            }).catch((err) => {
              console.error('Failed to send new agent webhook notification:', err);
            });
          }
        } catch (webhookError) {
          // Log but don't fail the request if webhook fails
          console.error('Error processing webhook notification:', webhookError);
        }
      }

      res.status(201).json({
        restaurant,
        agentConfiguration: updatedAgentConfig
      });
    } catch (error) {
      console.error("Agent creation error:", error);
      res.status(400).json({ 
        error: "Failed to create agent", 
        details: error instanceof Error ? error.message : String(error) 
      });
    }
  });

  app.delete("/api/agents/:restaurantId", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      const { restaurantId } = req.params;

      // Check if user has access to this agent
      const hasAccess = await storage.userHasAccessToRestaurant(user.id, restaurantId);
      if (!hasAccess && user.role !== "admin") {
        return res.status(403).json({ error: "Access denied" });
      }

      // Delete the agent configuration and restaurant
      const deleted = await storage.deleteAgentConfiguration(restaurantId);
      if (!deleted) {
        return res.status(404).json({ error: "Agent not found" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Failed to delete agent:", error);
      res.status(500).json({ error: "Failed to delete agent" });
    }
  });

  // Agent Skills routes
  app.get("/api/agent-configurations/:agentId/skills", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const agentSkills = await storage.getAgentSkillsByAgentConfigurationId(req.params.agentId);
      res.json(agentSkills);
    } catch (error) {
      console.error("Failed to get agent skills:", error);
      res.status(500).json({ error: "Failed to get agent skills" });
    }
  });

  app.post("/api/agent-configurations/:agentId/skills", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }

      // Check if user has access to this agent configuration
      const hasAccess = await storage.hasUserAgentWriteAccess(currentUser.id, req.params.agentId);
      if (!hasAccess && currentUser.role !== "admin") {
        return res.status(403).json({ error: "Access denied" });
      }

      const agentSkillData = insertAgentSkillSchema.parse({
        ...req.body,
        agentConfigurationId: req.params.agentId
      });
      
      const agentSkill = await storage.createAgentSkill(agentSkillData);
      res.json(agentSkill);
    } catch (error) {
      console.error("Failed to create agent skill:", error);
      res.status(400).json({ error: "Invalid agent skill data" });
    }
  });

  app.put("/api/agent-skills/:id", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }

      const updateData = updateAgentSkillSchema.parse(req.body);
      const agentSkill = await storage.updateAgentSkill(req.params.id, updateData);
      if (!agentSkill) {
        return res.status(404).json({ error: "Agent skill not found" });
      }
      res.json(agentSkill);
    } catch (error) {
      console.error("Failed to update agent skill:", error);
      res.status(400).json({ error: "Invalid agent skill data" });
    }
  });

  app.delete("/api/agent-skills/:id", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }

      const deleted = await storage.deleteAgentSkill(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: "Agent skill not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to delete agent skill:", error);
      res.status(500).json({ error: "Failed to delete agent skill" });
    }
  });

  app.delete("/api/agent-configurations/:agentId/skills/:skillId", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }

      // Check if user has access to this agent configuration
      const hasAccess = await storage.hasUserAgentWriteAccess(currentUser.id, req.params.agentId);
      if (!hasAccess && currentUser.role !== "admin") {
        return res.status(403).json({ error: "Access denied" });
      }

      const deleted = await storage.deleteAgentSkillBySkillId(req.params.agentId, req.params.skillId);
      if (!deleted) {
        return res.status(404).json({ error: "Agent skill not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to delete agent skill:", error);
      res.status(500).json({ error: "Failed to delete agent skill" });
    }
  });

  // Menu Overrides endpoints
  app.get("/api/agent-configurations/:agentId/overrides", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }

      // Check if user has access to this agent configuration
      const hasAccess = await storage.hasUserAgentAccess(currentUser.id, req.params.agentId);
      if (!hasAccess && currentUser.role !== "admin") {
        return res.status(403).json({ error: "Access denied" });
      }

      const overrides = await storage.getActiveOverridesByAgentId(req.params.agentId);
      res.json(overrides);
    } catch (error) {
      console.error("Failed to get menu overrides:", error);
      res.status(500).json({ error: "Failed to get menu overrides" });
    }
  });

  app.post("/api/agent-configurations/:agentId/overrides", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }

      // Check if user has write access to this agent configuration
      // Allow: admins (all access), super_users (all access), or users with explicit write access
      const hasAccess = await storage.hasUserAgentWriteAccess(currentUser.id, req.params.agentId);
      const isAdminOrSuperUser = currentUser.role === "admin" || currentUser.role === "super_user";
      
      if (!hasAccess && !isAdminOrSuperUser) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Validate request body with Zod schema
      const validatedData = insertMenuOverrideSchema.omit({ 
        lastModifiedBy: true, 
        status: true,
        agentConfigurationId: true
      }).extend({
        resetAt: z.union([z.string().datetime(), z.null()]).optional()
      }).parse(req.body);
      
      // Normalize resetAt to Date if it's a string
      const normalizedResetAt = validatedData.resetAt ? new Date(validatedData.resetAt) : null;

      const override = await storage.createMenuOverride({
        agentConfigurationId: req.params.agentId,
        content: validatedData.content,
        resetAt: normalizedResetAt,
        lastModifiedBy: currentUser.id,
        status: 'active'
      });

      res.json(override);
    } catch (error) {
      console.error("Failed to create menu override:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid request data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create menu override" });
    }
  });

  app.put("/api/agent-configurations/:agentId/overrides/:overrideId", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }

      // Check if user has write access to this agent configuration
      // Allow: admins (all access), super_users (all access), or users with explicit write access
      const hasAccess = await storage.hasUserAgentWriteAccess(currentUser.id, req.params.agentId);
      const isAdminOrSuperUser = currentUser.role === "admin" || currentUser.role === "super_user";
      
      if (!hasAccess && !isAdminOrSuperUser) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Validate request body with Zod schema
      const updateSchema = z.object({
        content: z.string().min(1, "Content is required"),
        resetAt: z.union([z.string().datetime(), z.null()]).optional()
      });
      
      const validatedData = updateSchema.parse(req.body);
      
      // Normalize resetAt to Date if it's a string
      const normalizedResetAt = validatedData.resetAt ? new Date(validatedData.resetAt) : null;

      const override = await storage.updateMenuOverride(
        req.params.overrideId,
        validatedData.content,
        normalizedResetAt,
        currentUser.id
      );

      if (!override) {
        return res.status(404).json({ error: "Override not found" });
      }

      res.json(override);
    } catch (error) {
      console.error("Failed to update menu override:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid request data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to update menu override" });
    }
  });

  app.delete("/api/agent-configurations/:agentId/overrides/:overrideId", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }

      // Check if user has write access to this agent configuration
      // Allow: admins (all access), super_users (all access), or users with explicit write access
      const hasAccess = await storage.hasUserAgentWriteAccess(currentUser.id, req.params.agentId);
      const isAdminOrSuperUser = currentUser.role === "admin" || currentUser.role === "super_user";
      
      if (!hasAccess && !isAdminOrSuperUser) {
        return res.status(403).json({ error: "Access denied" });
      }

      const deleted = await storage.softDeleteMenuOverride(req.params.overrideId);
      if (!deleted) {
        return res.status(404).json({ error: "Override not found" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Failed to delete menu override:", error);
      res.status(500).json({ error: "Failed to delete menu override" });
    }
  });

  // Get available printers (not linked to any agent)
  app.get("/api/printers/available", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }

      // Check if user is admin or has write access to any agent
      if (currentUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Get current printer ID if provided (for editing scenarios)
      const currentPrinterId = req.query.currentPrinterId as string | undefined;
      
      const availablePrinters = await storage.getAvailablePrinters(currentPrinterId);
      res.json(availablePrinters);
    } catch (error) {
      console.error("Failed to get available printers:", error);
      res.status(500).json({ error: "Failed to get available printers" });
    }
  });

  // Phone numbers available route - for agent linking and QR code display
  app.get("/api/phone-numbers/available", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const currentUser = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }

      // Get current phone number ID if provided (for editing scenarios or viewing)
      const currentPhoneNumberId = req.query.currentPhoneNumberId as string | undefined;
      
      // For non-admin users, only return the current phone number if specified (for QR code display)
      if (currentUser.role !== "admin") {
        if (currentPhoneNumberId) {
          // Return only the specified phone number for QR code display
          const phoneNumber = await storage.getPhoneNumber(currentPhoneNumberId);
          if (phoneNumber) {
            res.json([phoneNumber]);
          } else {
            res.json([]);
          }
        } else {
          // Non-admins can't browse available phone numbers
          return res.status(403).json({ error: "Admin access required to browse phone numbers" });
        }
      } else {
        // Admin users get all available phone numbers
        const availablePhoneNumbers = await storage.getAvailablePhoneNumbers(currentPhoneNumberId);
        res.json(availablePhoneNumbers);
      }
    } catch (error) {
      console.error("Failed to get available phone numbers:", error);
      res.status(500).json({ error: "Failed to get available phone numbers" });
    }
  });

  // ================== BILLING ROUTES ==================
  // Process Stripe checkout session after successful payment
  app.post("/api/billing/process-checkout-session", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { sessionId } = req.body;
      if (!sessionId) {
        return res.status(400).json({ error: "Session ID required" });
      }

      // Pass the authenticated Firebase UID for security verification
      // The function will get the user from Stripe metadata and verify it matches
      const result = await stripeService.processCheckoutSession(sessionId, firebaseUser.uid);
      res.json(result);
    } catch (error: any) {
      console.error("Failed to process checkout session:", error);
      res.status(500).json({ error: error.message || "Failed to process checkout session" });
    }
  });

  // Create or retrieve subscription for signup
  app.post("/api/billing/create-subscription", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      let user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      
      // Create user if doesn't exist (handles first-time signup flow)
      if (!user) {
        // Split display name into firstName and lastName if available
        const displayName = firebaseUser.name || "";
        const nameParts = displayName.trim().split(" ");
        const firstName = nameParts[0] || "Unknown";
        const lastName = nameParts.slice(1).join(" ") || "User";
        
        user = await storage.createUser({
          firebaseUid: firebaseUser.uid,
          email: firebaseUser.email || "unknown@example.com",
          firstName,
          lastName,
          role: "user"
        });
      }

      const { plan, context = "signup" } = req.body;
      if (!["starter", "growth", "pro", "unlimited"].includes(plan)) {
        return res.status(400).json({ error: "Invalid plan" });
      }

      const checkoutSession = await stripeService.createCheckoutSession(user.id, plan, context);
      res.json(checkoutSession);
    } catch (error: any) {
      console.error("Failed to create subscription:", error);
      res.status(500).json({ error: error.message || "Failed to create subscription" });
    }
  });

  // Update subscription plan (multiple routes for compatibility)
  app.post("/api/billing/update-plan", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const { plan } = req.body;
      if (!["starter", "growth", "pro", "unlimited"].includes(plan)) {
        return res.status(400).json({ error: "Invalid plan" });
      }

      const subscription = await stripeService.updateSubscriptionPlan(user.id, plan);
      res.json(subscription);
    } catch (error: any) {
      console.error("Failed to update subscription:", error);
      res.status(500).json({ error: error.message || "Failed to update subscription" });
    }
  });

  // Alternate route for frontend compatibility  
  app.post("/api/billing/subscription/change", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Frontend sends 'planId', backend expects 'plan'
      const { planId } = req.body;
      if (!["starter", "growth", "pro", "unlimited"].includes(planId)) {
        return res.status(400).json({ error: "Invalid plan" });
      }

      const subscription = await stripeService.updateSubscriptionPlan(user.id, planId);
      res.json(subscription);
    } catch (error: any) {
      console.error("Failed to update subscription:", error);
      res.status(500).json({ error: error.message || "Failed to update subscription" });
    }
  });

  // Cancel subscription
  app.post("/api/billing/cancel-subscription", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const subscription = await stripeService.cancelSubscription(user.id);
      res.json(subscription);
    } catch (error: any) {
      console.error("Failed to cancel subscription:", error);
      res.status(500).json({ error: error.message || "Failed to cancel subscription" });
    }
  });

  // Alternate cancel route for frontend compatibility
  app.post("/api/billing/subscription/cancel", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const subscription = await stripeService.cancelSubscription(user.id);
      res.json(subscription);
    } catch (error: any) {
      console.error("Failed to cancel subscription:", error);
      res.status(500).json({ error: error.message || "Failed to cancel subscription" });
    }
  });

  // Get payment methods
  app.get("/api/billing/payment-methods", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const paymentMethods = await stripeService.getPaymentMethods(user.id);
      res.json(paymentMethods);
    } catch (error: any) {
      console.error("Failed to get payment methods:", error);
      res.status(500).json({ error: error.message || "Failed to get payment methods" });
    }
  });

  // Create SetupIntent for SCA-compliant payment method collection
  app.post("/api/billing/setup-intent", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const setupIntent = await stripeService.createSetupIntent(user.id);
      res.json(setupIntent);
    } catch (error: any) {
      console.error("Failed to create setup intent:", error);
      res.status(500).json({ error: error.message || "Failed to create setup intent" });
    }
  });

  // Add payment method (also matches frontend route)
  app.post("/api/billing/payment-method", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const { paymentMethodId, setAsDefault } = req.body;
      const paymentMethod = await stripeService.addPaymentMethod(user.id, paymentMethodId, setAsDefault);
      res.json(paymentMethod);
    } catch (error: any) {
      console.error("Failed to add payment method:", error);
      res.status(500).json({ error: error.message || "Failed to add payment method" });
    }
  });

  // Remove payment method
  app.delete("/api/billing/payment-methods/:id", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      await stripeService.removePaymentMethod(user.id, req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Failed to remove payment method:", error);
      res.status(500).json({ error: error.message || "Failed to remove payment method" });
    }
  });

  // Create billing portal session
  app.post("/api/billing/portal-session", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const portalSession = await stripeService.createBillingPortalSession(user.id);
      res.json(portalSession);
    } catch (error: any) {
      console.error("Failed to create portal session:", error);
      res.status(500).json({ error: error.message || "Failed to create portal session" });
    }
  });

  // Diagnostic endpoint to check Stripe meter configuration (admin only)
  app.get("/api/billing/check-meters", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user || user.role !== 'admin') {
        return res.status(403).json({ error: "Admin access required" });
      }

      const diagnostics: any = {
        environment: process.env.REPLIT_DEPLOYMENT === '1' ? 'production' : 'development',
        stripeKeyType: process.env.REPLIT_DEPLOYMENT === '1' ? 'STRIPE_SECRET_KEY' : 'TESTING_STRIPE_SECRET_KEY',
        meters: {},
        testCustomer: null,
        errors: []
      };

      // Try to list meters
      const stripeForDiagnostics = getStripeInstance();
      if (!stripeForDiagnostics) {
        diagnostics.errors.push({ operation: 'list_meters', error: 'Stripe not configured' });
      } else {
        try {
          const meters = await stripeForDiagnostics.billing.meters.list({ limit: 100 });
          diagnostics.meters = {
            count: meters.data.length,
            names: meters.data.map((m: any) => m.event_name),
            details: meters.data.map((m: any) => ({
              event_name: m.event_name,
              display_name: m.display_name,
              status: m.status,
              created: new Date(m.created * 1000).toISOString()
            }))
          };
        } catch (error: any) {
          diagnostics.errors.push({
            operation: 'list_meters',
            error: error.message,
            code: error.code
          });
        }
      }

      // Check if we can retrieve a customer (using the current user's customer ID if they have one)
      if (user.stripeCustomerId) {
        const stripeForCustomer = getStripeInstance();
        if (!stripeForCustomer) {
          diagnostics.errors.push({ operation: 'retrieve_customer', error: 'Stripe not configured' });
        } else {
          try {
            const customer = await stripeForCustomer.customers.retrieve(user.stripeCustomerId);
            diagnostics.testCustomer = {
              id: customer.id,
              livemode: (customer as any).livemode,
              created: new Date((customer as any).created * 1000).toISOString()
            };
          } catch (error: any) {
            diagnostics.errors.push({
              operation: 'retrieve_customer',
              customerId: user.stripeCustomerId,
              error: error.message,
              code: error.code
            });
          }
        }
      }

      // Check subscription prices configuration
      const priceConfigs = await db.select().from(subscriptionPrices);
      diagnostics.priceConfiguration = priceConfigs.map(p => ({
        plan: p.plan,
        hasMeteredPriceId: !!p.stripeMeteredPriceId,
        meteredPriceIdPrefix: p.stripeMeteredPriceId?.substring(0, 15) + '...'
      }));

      res.json(diagnostics);
    } catch (error) {
      console.error('Meter diagnostics error:', error);
      res.status(500).json({ error: "Failed to run diagnostics" });
    }
  });

  // Get invoices
  app.get("/api/billing/invoices", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const limit = parseInt(req.query.limit as string) || 10;
      const invoices = await stripeService.getInvoices(user.id, limit);
      res.json(invoices);
    } catch (error: any) {
      console.error("Failed to get invoices:", error);
      res.status(500).json({ error: error.message || "Failed to get invoices" });
    }
  });

  // Get current subscription info
  app.get("/api/billing/subscription", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Check if user has actually completed subscription setup
      // If they don't have a stripeSubscriptionId or subscriptionStatus, they haven't finished setup
      const hasSubscription = !!(user.stripeSubscriptionId && user.subscriptionStatus);

      // If user has a subscription, sync the billing dates from Stripe
      let currentPeriodStart = user.billingCycleStart;
      let currentPeriodEnd = user.billingCycleEnd;
      
      if (hasSubscription && user.stripeSubscriptionId) {
        const syncedDetails = await stripeService.getAndSyncSubscriptionDetails(user.id);
        if (syncedDetails) {
          currentPeriodStart = syncedDetails.currentPeriodStart;
          currentPeriodEnd = syncedDetails.currentPeriodEnd;
        }
      }

      // Return user's subscription info
      res.json({
        planId: hasSubscription ? (user.subscriptionPlan || "starter") : null,
        status: user.subscriptionStatus || null,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd: false, // TODO: Track this in the database
        stripeCustomerId: user.stripeCustomerId,
        stripeSubscriptionId: user.stripeSubscriptionId,
        hasSubscription, // New field to explicitly indicate if subscription is set up
      });
    } catch (error: any) {
      console.error("Failed to get subscription:", error);
      res.status(500).json({ error: error.message || "Failed to get subscription" });
    }
  });

  // Get usage data for the current billing period
  app.get("/api/billing/usage", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Count active agents for the user
      const agentList = await storage.getAgentsForUser(user.id);
      const activeAgents = agentList.filter(agent => agent.isActive).length;

      // Get the plan details from subscription_prices table
      let planDetails = null;
      if (user.subscriptionPlan) {
        const planName = user.subscriptionPlan.charAt(0).toUpperCase() + user.subscriptionPlan.slice(1);
        const [priceConfig] = await db
          .select()
          .from(subscriptionPrices)
          .where(eq(subscriptionPrices.plan, planName as any));
        
        if (priceConfig) {
          planDetails = {
            includedCalls: priceConfig.includedCalls,
            includedMinutes: priceConfig.includedMinutes,
            perCallOverageCents: priceConfig.perCallOverage,
            perMinuteOverageCents: priceConfig.perMinuteOverage,
          };
        }
      }

      // Calculate billing cycle days remaining if we have dates
      let daysRemaining = null;
      let billingResetDate = null;
      if (user.billingCycleEnd) {
        const now = new Date();
        const endDate = new Date(user.billingCycleEnd);
        daysRemaining = Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        billingResetDate = endDate.toISOString();
      }

      res.json({
        calls: user.monthlyCallsUsed || 0,
        minutes: user.monthlyMinutesUsed || 0,
        activeAgents,
        planDetails,
        daysRemaining,
        billingResetDate,
      });
    } catch (error: any) {
      console.error("Failed to get usage:", error);
      res.status(500).json({ error: error.message || "Failed to get usage" });
    }
  });

  // Record usage (internal endpoint for tracking)
  app.post("/api/billing/record-usage", async (req, res) => {
    try {
      const firebaseUser = req.firebaseUser;
      if (!firebaseUser) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const user = await storage.getUserByFirebaseUid(firebaseUser.uid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const { restaurantId, type, quantity } = req.body;
      if (!restaurantId || !type || !quantity) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      if (!["call", "minute"].includes(type)) {
        return res.status(400).json({ error: "Invalid usage type" });
      }

      // Get the agent configuration to find the billing user
      const agentConfig = await storage.getAgentConfiguration(restaurantId);
      if (!agentConfig) {
        return res.status(404).json({ error: "Agent configuration not found" });
      }

      // Verify billing user is set
      if (!agentConfig.billingUserId) {
        return res.status(422).json({ error: "Agent configuration missing billing user. Please contact support." });
      }

      // Use the agent's billing user for usage tracking
      await stripeService.recordUsage(agentConfig.billingUserId, restaurantId, type, quantity);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Failed to record usage:", error);
      res.status(500).json({ error: error.message || "Failed to record usage" });
    }
  });

  // Calculate Total Endpoint
  app.post('/api/calculate-total', async (req, res) => {
    try {
      console.log('📥 Received request:', JSON.stringify(req.body, null, 2));
      
      const { items } = req.body;
      
      // Validation
      if (!items) {
        console.error('❌ No items provided');
        await sendSlackErrorNotification(
          '/api/calculate-total',
          400,
          'items field is required',
          { requestBody: req.body }
        );
        return res.status(400).json({ 
          success: false,
          error: 'Invalid request',
          message: 'items field is required'
        });
      }
      
      if (!Array.isArray(items)) {
        console.error('❌ Items is not an array:', typeof items);
        await sendSlackErrorNotification(
          '/api/calculate-total',
          400,
          'items must be an array',
          { requestBody: req.body, itemsType: typeof items }
        );
        return res.status(400).json({ 
          success: false,
          error: 'Invalid request',
          message: 'items must be an array'
        });
      }
      
      if (items.length === 0) {
        console.error('❌ Items array is empty');
        await sendSlackErrorNotification(
          '/api/calculate-total',
          400,
          'items array cannot be empty',
          { requestBody: req.body }
        );
        return res.status(400).json({ 
          success: false,
          error: 'Invalid request',
          message: 'items array cannot be empty'
        });
      }
      
      // Calculate total
      let total = 0;
      let itemCount = 0;
      const breakdown: Array<{
        name: string;
        price: number;
        quantity: number;
        line_total: number;
      }> = [];
      
      items.forEach((item, index) => {
        console.log(`  Processing item ${index + 1}:`, item);
        
        // Validate item structure
        if (!item.name) {
          throw new Error(`Item at index ${index} is missing 'name' field`);
        }
        
        if (typeof item.price !== 'number') {
          throw new Error(`Item at index ${index} (${item.name}) has invalid price: ${item.price} (type: ${typeof item.price})`);
        }
        
        if (typeof item.quantity !== 'number') {
          throw new Error(`Item at index ${index} (${item.name}) has invalid quantity: ${item.quantity} (type: ${typeof item.quantity})`);
        }
        
        // Calculate line total
        const lineTotal = item.price * item.quantity;
        total += lineTotal;
        itemCount += item.quantity;
        
        breakdown.push({
          name: item.name,
          price: item.price,
          quantity: item.quantity,
          line_total: Math.round(lineTotal * 100) / 100
        });
        
        console.log(`    ✓ ${item.name}: ${item.quantity} x $${item.price} = $${lineTotal}`);
      });
      
      // Round to 2 decimal places
      total = Math.round(total * 100) / 100;
      
      console.log(`✅ TOTAL CALCULATED: $${total} (${itemCount} items)`);
      
      // Return response
      const response = {
        success: true,
        total: total,
        item_count: itemCount,
        formatted_total: `$${total.toFixed(2)}`,
        breakdown: breakdown
      };
      
      console.log('📤 Sending response:', JSON.stringify(response, null, 2));
      
      res.json(response);
      
    } catch (error: any) {
      console.error('❌ Calculate Total Error:', error.message);
      console.error('Stack:', error.stack);
      
      await sendSlackErrorNotification(
        '/api/calculate-total',
        400,
        error.message || 'Calculation failed',
        { 
          requestBody: req.body,
          stack: error.stack 
        }
      );
      
      res.status(400).json({ 
        success: false,
        error: 'Calculation failed',
        message: error.message
      });
    }
  });

  app.post('/api/check-restaurant-open', async (req, res) => {
    const { current_time, wait_time_minutes, opening_hours } = req.body;

    const parseOffsetMinutes = (isoString: string) => {
      const offsetMatch = isoString.match(/([+-])(\d{2}):?(\d{2})$/);
      if (offsetMatch) {
        const sign = offsetMatch[1] === '-' ? -1 : 1;
        return sign * (parseInt(offsetMatch[2], 10) * 60 + parseInt(offsetMatch[3], 10));
      }
      if (isoString.endsWith('Z')) {
        return 0;
      }
      const tempDate = new Date(isoString);
      return -tempDate.getTimezoneOffset();
    };

    const formatTimeWithOffset = (date: Date, offsetMinutes: number) => {
      const utcMinutes = Math.floor(date.getTime() / 60000);
      let localMinutes = utcMinutes + offsetMinutes;
      const minutesInDay = 24 * 60;
      localMinutes = ((localMinutes % minutesInDay) + minutesInDay) % minutesInDay;

      let hours = Math.floor(localMinutes / 60);
      const minutes = localMinutes % 60;
      const suffix = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      if (hours === 0) hours = 12;

      const minuteStr = minutes.toString().padStart(2, '0');
      return `${hours}:${minuteStr} ${suffix}`;
    };

    const parseTwelveHourIntervals = (input: string) => {
      const regex = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/gi;
      const timesInMinutes: number[] = [];

      let match: RegExpExecArray | null;
      while ((match = regex.exec(input))) {
        let hour = parseInt(match[1], 10);
        const minute = match[2] ? parseInt(match[2], 10) : 0;
        const meridian = match[3].toLowerCase();

        if (hour === 12) {
          hour = meridian === 'am' ? 0 : 12;
        } else if (meridian === 'pm') {
          hour += 12;
        }

        timesInMinutes.push(hour * 60 + minute);
      }

      if (timesInMinutes.length < 2) {
        return null;
      }

      const intervals: Array<[number, number]> = [];
      for (let i = 0; i + 1 < timesInMinutes.length; i += 2) {
        const start = timesInMinutes[i];
        const end = timesInMinutes[i + 1];
        if (end > start) {
          intervals.push([start, end]);
        }
      }

      return intervals.length ? intervals : null;
    };

    const createDateFromMinutes = (base: Date, offsetMinutes: number, minutes: number) => {
      const utcMidnight =
        Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
      const localMidnightUtc = utcMidnight - offsetMinutes * 60000;
      return new Date(localMidnightUtc + minutes * 60000);
    };

    try {
      const now = new Date(current_time);
      if (Number.isNaN(now.getTime())) {
        await sendSlackErrorNotification(
          '/api/check-restaurant-open',
          400,
          'Invalid current_time format',
          { requestBody: req.body, current_time }
        );
        return res.status(400).json({ error: "Invalid current_time format" });
      }

      const inputOffsetMinutes = parseOffsetMinutes(current_time);
      const pickupTime = new Date(now.getTime() + wait_time_minutes * 60000);

      const intervals = parseTwelveHourIntervals(opening_hours);

      if (!intervals) {
        await sendSlackErrorNotification(
          '/api/check-restaurant-open',
          400,
          "Invalid opening_hours format. Example: '12pm till 3pm and 5pm till 8:15pm'.",
          { requestBody: req.body, opening_hours }
        );
        return res.status(400).json({ error: "Invalid opening_hours format. Example: '12pm till 3pm and 5pm till 8:15pm'." });
      }

      let canAcceptOrders = false;
      let matchingClosingTime: Date | null = null;

      for (const [startMinutes, endMinutes] of intervals) {
        const startTime = createDateFromMinutes(now, inputOffsetMinutes, startMinutes);
        const endTime = createDateFromMinutes(now, inputOffsetMinutes, endMinutes);

        if (pickupTime >= startTime && pickupTime <= endTime) {
          canAcceptOrders = true;
          matchingClosingTime = endTime;
          break;
        }
      }

      const pickupTimeStr = formatTimeWithOffset(pickupTime, inputOffsetMinutes);

      const closingTimeStr = matchingClosingTime
        ? formatTimeWithOffset(matchingClosingTime, inputOffsetMinutes)
        : null;

      res.json({
        can_accept_orders: canAcceptOrders,
        pickup_time: pickupTimeStr,
        closing_time: closingTimeStr,
        message: canAcceptOrders
          ? `Order ready by ${pickupTimeStr}, before closing at ${closingTimeStr}.`
          : `Kitchen closed for the requested pickup time.`,
      });
      
    } catch (error: any) {
      console.error('Error:', error);
      
      await sendSlackErrorNotification(
        '/api/check-restaurant-open',
        500,
        error?.message || 'Failed to check availability',
        { 
          requestBody: req.body,
          stack: error?.stack 
        }
      );
      
      res.status(500).json({ error: "Failed to check availability" });
    }
  });

  // Stripe webhook handler
  app.post("/api/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"] as string;
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!endpointSecret) {
      console.error("Stripe webhook secret not configured");
      return res.status(500).json({ error: "Webhook not configured" });
    }

    let event;
    try {
      // Use production keys in production deployment, testing keys in development
      const isProduction = process.env.REPLIT_DEPLOYMENT === '1';
      const stripeKey = isProduction 
        ? process.env.STRIPE_SECRET_KEY 
        : (process.env.TESTING_STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY);
      
      const stripe = new Stripe(stripeKey!, {
        apiVersion: "2025-09-30.clover",
      });
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err: any) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    try {
      switch (event.type) {
        case "invoice.paid":
          const paidInvoice = event.data.object as Stripe.Invoice;
          await stripeService.syncInvoice(paidInvoice);
          break;

        case "invoice.payment_failed":
          const failedInvoice = event.data.object as Stripe.Invoice;
          await stripeService.syncInvoice(failedInvoice);
          // TODO: Send notification to user about failed payment
          break;

        case "customer.subscription.updated":
        case "customer.subscription.deleted":
          const subscription = event.data.object as any;
          // Update user's subscription status
          const customerId = subscription.customer;
          const user = await storage.getUserByStripeCustomerId(customerId);
          if (user) {
            // Update the subscription fields directly in the database
            await db.update(users)
              .set({
                subscriptionStatus: subscription.status,
                subscriptionPlan: subscription.items?.data[0]?.price?.lookup_key || user.subscriptionPlan,
              })
              .where(eq(users.id, user.id));
          }
          break;

        case "invoice.created":
          // Reset usage counters at the start of a new billing cycle
          const createdInvoice = event.data.object as Stripe.Invoice;
          const customerIdForReset = createdInvoice.customer as string;
          const userForReset = await storage.getUserByStripeCustomerId(customerIdForReset);
          if (userForReset) {
            await stripeService.resetMonthlyUsage(userForReset.id);
          }
          break;

        default:
          console.log(`Unhandled event type ${event.type}`);
      }

      res.json({ received: true });
    } catch (error: any) {
      console.error("Error handling webhook:", error);
      res.status(500).json({ error: "Webhook handler error" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
