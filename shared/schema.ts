import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, boolean, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  firebaseUid: text("firebase_uid").notNull().unique(),
  email: text("email").notNull().unique(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  role: text("role", { enum: ["admin", "user", "super_user"] }).notNull().default("user"),
  stripeCustomerId: text("stripe_customer_id").unique(),
  stripeSubscriptionId: text("stripe_subscription_id").unique(),
  subscriptionPlan: text("subscription_plan", { enum: ["starter", "growth", "pro", "unlimited"] }).default("starter"),
  subscriptionStatus: text("subscription_status", { enum: ["active", "canceled", "past_due", "trialing", "incomplete", "incomplete_expired"] }),
  billingCycleStart: timestamp("billing_cycle_start"),
  billingCycleEnd: timestamp("billing_cycle_end"),
  monthlyCallsUsed: integer("monthly_calls_used").default(0),
  monthlyMinutesUsed: integer("monthly_minutes_used").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  lastSeen: timestamp("last_seen"),
});

export const restaurants = pgTable("restaurants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  ownerId: varchar("owner_id").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const agentConfigurations = pgTable("agent_configurations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").references(() => restaurants.id).notNull().unique(),
  billingUserId: varchar("billing_user_id").references(() => users.id).notNull(), // User responsible for billing
  mode: text("mode", { enum: ["agent", "forward", "offline"] }).notNull().default("agent"),
  waitTimeMinutes: integer("wait_time_minutes").notNull().default(15),
  defaultWaitTimeMinutes: integer("default_wait_time_minutes").notNull().default(30),
  resetWaitTimeAt: timestamp("reset_wait_time_at"),
  menuOverrides: text("menu_overrides"), // Temporary menu adjustments/overrides
  timeoutSeconds: integer("timeout_seconds").default(20), // For forward mode timeout
  redirectPhoneNumber: text("redirect_phone_number"), // Forward destination
  callerId: text("caller_id"), // Optional caller ID for forward mode
  agentUrl: text("agent_url"), // Agent webhook URL
  printerId: varchar("printer_id").references(() => printers.id).unique(), // One-to-one relationship with printers
  phoneNumberId: varchar("phone_number_id").references(() => phoneNumbers.id).unique(), // One-to-one relationship with phone numbers
  errorSmsPhone: text("error_sms_phone"),
  elevenlabsAgentId: text("elevenlabs_agent_id"),
  customGreeting: text("custom_greeting"),
  openingHours: text("opening_hours"), // Business hours for the agent
  handoffPhoneNumber: text("handoff_phone_number"), // Phone number to transfer calls to human
  address: text("address"), // Restaurant address
  googlePlaceId: text("google_place_id"), // Google Places API place ID
  venueDetails: text("venue_details"), // Extensive venue information for the agent
  menu: text("menu"), // Menu in markdown format
  menuUrl: text("menu_url"), // URL to the restaurant's menu
  allowBetaSkills: boolean("allow_beta_skills").notNull().default(false),
  allowInactiveSkills: boolean("allow_inactive_skills").notNull().default(false),
  onboardingStage: text("onboarding_stage", { enum: ["Building", "Complete"] }).notNull().default("Complete"),
  isActive: boolean("is_active").notNull().default(true),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const skills = pgTable("skills", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  status: text("status", { enum: ["Active", "Beta", "Inactive"] }).notNull().default("Active"),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const methods = pgTable("methods", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  skillId: varchar("skill_id").references(() => skills.id).notNull(),
  name: text("name").notNull(),
  status: text("status", { enum: ["Active", "Beta", "Inactive"] }).notNull().default("Active"),
  prompt: text("prompt").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const callLogs = pgTable("call_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").references(() => restaurants.id).notNull(),
  customerPhone: text("customer_phone").notNull(),
  twilioCallSid: text("twilio_call_sid"), // Twilio's unique call identifier
  duration: integer("duration_seconds"),
  status: text("status", { enum: ["completed", "in-progress", "failed"] }).notNull(),
  orderValue: integer("order_value_cents"),
  recordingUrl: text("recording_url"),
  elevenlabsConversationId: text("elevenlabs_conversation_id"), // ElevenLabs conversation ID for fetching audio
  elevenlabsAudioUrl: text("elevenlabs_audio_url"), // URL to the ElevenLabs audio recording
  localAudioPath: text("local_audio_path"), // Local filesystem path to the downloaded audio file
  audioFileSize: integer("audio_file_size"), // Size of the audio file in bytes
  audioRetrievedAt: timestamp("audio_retrieved_at"), // When we fetched the audio from ElevenLabs
  lastPolledAt: timestamp("last_polled_at"), // When we last checked Twilio for status
  usageRecordedAt: timestamp("usage_recorded_at"), // When usage was recorded to prevent duplicate billing
  summary: text("summary"), // Full call summary from ElevenLabs
  summaryTitle: text("summary_title"), // Brief call summary title from ElevenLabs
  toolCallsJson: text("tool_calls_json"), // JSON string of tool calls made during the call
  transferredToHuman: boolean("transferred_to_human").default(false), // Whether call was transferred to a human
  mainLanguage: text("main_language"), // Primary language detected in the call
  createdAt: timestamp("created_at").defaultNow(),
});

// Junction table for many-to-many relationship between users and agent configurations
export const userAgentAccess = pgTable("user_agent_access", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  agentConfigurationId: varchar("agent_configuration_id").references(() => agentConfigurations.id).notNull(),
  accessLevel: text("access_level", { enum: ["read", "write"] }).notNull().default("write"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Junction table for agent configurations and skills
export const agentSkills = pgTable("agent_skills", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentConfigurationId: varchar("agent_configuration_id").references(() => agentConfigurations.id).notNull(),
  skillId: varchar("skill_id").references(() => skills.id).notNull(),
  methodId: varchar("method_id").references(() => methods.id).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  // Ensure each agent can only have one instance of each skill
  uniqueAgentSkill: unique().on(table.agentConfigurationId, table.skillId),
}));

// Printers table for managing Otto printers
export const printers = pgTable("printers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  friendlyName: text("friendly_name"),
  serialNumber: text("serial_number").notNull().unique(),
  model: text("model"),
  notes: text("notes"),
  wifiStrength: integer("wifi_strength"), // Signal strength in percentage (0-100)
  ethernetStatus: text("ethernet_status", { enum: ["connected", "disconnected", "unknown"] }),
  ipAddress: text("ip_address"),
  lastSeen: timestamp("last_seen"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Phone Numbers table for managing Twilio phone numbers
export const phoneNumbers = pgTable("phone_numbers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phoneNumber: text("phone_number").notNull().unique(), // E.164 format
  friendlyName: text("friendly_name"), // Display name for the number
  voiceUrl: text("voice_url"), // Twilio voice webhook URL
  statusUrl: text("status_url"), // Twilio status callback URL
  twilioSid: text("twilio_sid"), // Twilio's unique identifier for the number
  capabilities: text("capabilities"), // JSON string of capabilities (voice, sms, mms)
  status: text("status", { enum: ["active", "inactive", "released"] }).notNull().default("active"),
  areaCode: text("area_code"), // Area code of the number
  locality: text("locality"), // City/locality of the number
  region: text("region"), // State/region of the number
  country: text("country"), // Country code (e.g., US, CA)
  assignedRestaurantId: varchar("assigned_restaurant_id").references(() => restaurants.id), // Optional link to a restaurant
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ElevenLabs Webhooks table for storing raw webhook data
export const elevenlabsWebhooks = pgTable("elevenlabs_webhooks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  callLogId: varchar("call_log_id").references(() => callLogs.id).notNull(),
  conversationId: text("conversation_id"), // ElevenLabs conversation ID
  rawData: text("raw_data").notNull(), // Full JSON webhook payload
  eventTimestamp: timestamp("event_timestamp"), // When the event occurred (from ElevenLabs)
  createdAt: timestamp("created_at").defaultNow(), // When we received the webhook
});

// Call Transcript Messages table for storing individual conversation messages
export const callTranscriptMessages = pgTable("call_transcript_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  callLogId: varchar("call_log_id").references(() => callLogs.id).notNull(),
  messageType: text("message_type", { enum: ["agent", "user", "tool_call", "tool_result"] }).notNull(),
  content: text("content"), // Message text content (null for tool_call/tool_result)
  timeInCallSecs: integer("time_in_call_secs").notNull(), // When this message occurred in the call
  toolCallData: text("tool_call_data"), // JSON string of tool call/result data
  createdAt: timestamp("created_at").defaultNow(),
});

// Platform Settings table for global application settings
export const platformSettings = pgTable("platform_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  newUserNotificationWebhook: text("new_user_notification_webhook"),
  newAgentNotificationWebhook: text("new_agent_notification_webhook"),
  baseInstructions: text("base_instructions"),
  personality: text("personality"),
  updatedAt: timestamp("updated_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Payment Methods table for storing Stripe payment methods
export const paymentMethods = pgTable("payment_methods", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  stripePaymentMethodId: text("stripe_payment_method_id").notNull().unique(),
  type: text("type").notNull(), // card, bank_account, etc.
  last4: text("last4"), // Last 4 digits of card
  brand: text("brand"), // Card brand (visa, mastercard, etc.)
  expiryMonth: integer("expiry_month"),
  expiryYear: integer("expiry_year"),
  isDefault: boolean("is_default").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

// Invoices table for tracking billing history
export const invoices = pgTable("invoices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  stripeInvoiceId: text("stripe_invoice_id").unique(),
  invoiceNumber: text("invoice_number"),
  status: text("status", { enum: ["draft", "open", "paid", "void", "uncollectible"] }).notNull(),
  amountDue: integer("amount_due_cents"), // Store in cents
  amountPaid: integer("amount_paid_cents"),
  currency: text("currency").default("usd"),
  billingPeriodStart: timestamp("billing_period_start"),
  billingPeriodEnd: timestamp("billing_period_end"),
  pdfUrl: text("pdf_url"),
  hostedInvoiceUrl: text("hosted_invoice_url"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Usage Records table for tracking metered billing
export const usageRecords = pgTable("usage_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  restaurantId: varchar("restaurant_id").references(() => restaurants.id),
  type: text("type", { enum: ["call", "minute"] }).notNull(),
  quantity: integer("quantity").notNull(), // Number of calls or minutes
  timestamp: timestamp("timestamp").defaultNow(),
  reportedToStripe: boolean("reported_to_stripe").default(false),
  stripeUsageRecordId: text("stripe_usage_record_id"),
  billingPeriod: timestamp("billing_period"), // Which billing period this belongs to
  createdAt: timestamp("created_at").defaultNow(),
});

// Subscription Price IDs table for storing Stripe price IDs
export const subscriptionPrices = pgTable("subscription_prices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  plan: text("plan", { enum: ["starter", "growth", "pro", "unlimited"] }).notNull().unique(),
  stripePriceId: text("stripe_price_id").notNull(), // Monthly subscription price ID
  stripeMeteredPriceId: text("stripe_metered_price_id"), // Metered usage price ID (for overages)
  monthlyPrice: integer("monthly_price_cents").notNull(),
  includedMinutes: integer("included_minutes"),
  includedCalls: integer("included_calls"),
  perMinuteOverage: integer("per_minute_overage_cents"),
  perCallOverage: integer("per_call_overage_cents"),
  features: text("features"), // JSON string of plan features
  createdAt: timestamp("created_at").defaultNow(),
});

// Menu Overrides table for temporary agent instructions
export const menuOverrides = pgTable("menu_overrides", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentConfigurationId: varchar("agent_configuration_id").references(() => agentConfigurations.id).notNull(),
  content: text("content").notNull(), // Override instruction text
  resetAt: timestamp("reset_at"), // When to auto-clear this override (nullable)
  status: text("status", { enum: ["active", "deleted"] }).notNull().default("active"),
  lastModifiedBy: varchar("last_modified_by").references(() => users.id).notNull(),
  lastModifiedAt: timestamp("last_modified_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  restaurants: many(restaurants),
  agentAccess: many(userAgentAccess),
  paymentMethods: many(paymentMethods),
  invoices: many(invoices),
  usageRecords: many(usageRecords),
}));

export const skillsRelations = relations(skills, ({ many }) => ({
  methods: many(methods),
  agentSkills: many(agentSkills),
}));

export const methodsRelations = relations(methods, ({ one, many }) => ({
  skill: one(skills, {
    fields: [methods.skillId],
    references: [skills.id],
  }),
  agentSkills: many(agentSkills),
}));

export const restaurantsRelations = relations(restaurants, ({ one, many }) => ({
  owner: one(users, {
    fields: [restaurants.ownerId],
    references: [users.id],
  }),
  agentConfiguration: one(agentConfigurations),
  callLogs: many(callLogs),
}));

export const agentConfigurationsRelations = relations(agentConfigurations, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [agentConfigurations.restaurantId],
    references: [restaurants.id],
  }),
  billingUser: one(users, {
    fields: [agentConfigurations.billingUserId],
    references: [users.id],
  }),
  printer: one(printers, {
    fields: [agentConfigurations.printerId],
    references: [printers.id],
  }),
  phoneNumber: one(phoneNumbers, {
    fields: [agentConfigurations.phoneNumberId],
    references: [phoneNumbers.id],
  }),
  userAccess: many(userAgentAccess),
  agentSkills: many(agentSkills),
  menuOverrides: many(menuOverrides),
}));

export const callLogsRelations = relations(callLogs, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [callLogs.restaurantId],
    references: [restaurants.id],
  }),
}));

export const userAgentAccessRelations = relations(userAgentAccess, ({ one }) => ({
  user: one(users, {
    fields: [userAgentAccess.userId],
    references: [users.id],
  }),
  agentConfiguration: one(agentConfigurations, {
    fields: [userAgentAccess.agentConfigurationId],
    references: [agentConfigurations.id],
  }),
}));

export const agentSkillsRelations = relations(agentSkills, ({ one }) => ({
  agentConfiguration: one(agentConfigurations, {
    fields: [agentSkills.agentConfigurationId],
    references: [agentConfigurations.id],
  }),
  skill: one(skills, {
    fields: [agentSkills.skillId],
    references: [skills.id],
  }),
  method: one(methods, {
    fields: [agentSkills.methodId],
    references: [methods.id],
  }),
}));

export const menuOverridesRelations = relations(menuOverrides, ({ one }) => ({
  agentConfiguration: one(agentConfigurations, {
    fields: [menuOverrides.agentConfigurationId],
    references: [agentConfigurations.id],
  }),
  lastModifiedByUser: one(users, {
    fields: [menuOverrides.lastModifiedBy],
    references: [users.id],
  }),
}));

export const printersRelations = relations(printers, ({ one }) => ({
  agentConfiguration: one(agentConfigurations, {
    fields: [printers.id],
    references: [agentConfigurations.printerId],
  }),
}));

export const phoneNumbersRelations = relations(phoneNumbers, ({ one }) => ({
  agentConfiguration: one(agentConfigurations, {
    fields: [phoneNumbers.id],
    references: [agentConfigurations.phoneNumberId],
  }),
}));

export const paymentMethodsRelations = relations(paymentMethods, ({ one }) => ({
  user: one(users, {
    fields: [paymentMethods.userId],
    references: [users.id],
  }),
}));

export const invoicesRelations = relations(invoices, ({ one }) => ({
  user: one(users, {
    fields: [invoices.userId],
    references: [users.id],
  }),
}));

export const usageRecordsRelations = relations(usageRecords, ({ one }) => ({
  user: one(users, {
    fields: [usageRecords.userId],
    references: [users.id],
  }),
  restaurant: one(restaurants, {
    fields: [usageRecords.restaurantId],
    references: [restaurants.id],
  }),
}));

// Insert schemas
export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});

export const insertRestaurantSchema = createInsertSchema(restaurants).omit({
  id: true,
  createdAt: true,
});

export const insertAgentConfigurationSchema = createInsertSchema(agentConfigurations).omit({
  id: true,
  updatedAt: true,
});

export const insertCallLogSchema = createInsertSchema(callLogs).omit({
  id: true,
  createdAt: true,
});

export const insertUserAgentAccessSchema = createInsertSchema(userAgentAccess).omit({
  id: true,
  createdAt: true,
});

export const insertSkillSchema = createInsertSchema(skills).omit({
  id: true,
  createdAt: true,
});

export const insertMethodSchema = createInsertSchema(methods).omit({
  id: true,
  createdAt: true,
});

export const insertAgentSkillSchema = createInsertSchema(agentSkills).omit({
  id: true,
  createdAt: true,
});

export const insertPrinterSchema = createInsertSchema(printers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  model: true,
  wifiStrength: true,
  ethernetStatus: true,
  ipAddress: true,
  lastSeen: true,
});

export const insertPhoneNumberSchema = createInsertSchema(phoneNumbers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertPlatformSettingsSchema = createInsertSchema(platformSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertPaymentMethodSchema = createInsertSchema(paymentMethods).omit({
  id: true,
  createdAt: true,
});

export const insertInvoiceSchema = createInsertSchema(invoices).omit({
  id: true,
  createdAt: true,
});

export const insertUsageRecordSchema = createInsertSchema(usageRecords).omit({
  id: true,
  createdAt: true,
  timestamp: true,
});

export const insertSubscriptionPriceSchema = createInsertSchema(subscriptionPrices).omit({
  id: true,
  createdAt: true,
});

export const insertMenuOverrideSchema = createInsertSchema(menuOverrides).omit({
  id: true,
  createdAt: true,
  lastModifiedAt: true,
});

export const insertElevenlabsWebhookSchema = createInsertSchema(elevenlabsWebhooks).omit({
  createdAt: true,
});

export const insertCallTranscriptMessageSchema = createInsertSchema(callTranscriptMessages).omit({
  createdAt: true,
});

// Update schemas
export const updateRestaurantSchema = z.object({
  name: z.string().min(1).max(100),
});

export const updateAgentConfigSchema = insertAgentConfigurationSchema.partial().omit({
  restaurantId: true,
}).extend({
  // Override resetWaitTimeAt to accept ISO string from frontend OR Date object (will be normalized to Date in backend)
  resetWaitTimeAt: z.union([z.string(), z.date()]).nullable().optional(),
});

export const updateUserSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  role: z.enum(["admin", "user", "super_user"]),
});

export const updateSkillSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  status: z.enum(["Active", "Beta", "Inactive"]).optional(),
  description: z.string().optional(),
});

export const updateMethodSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  status: z.enum(["Active", "Beta", "Inactive"]).optional(),
  prompt: z.string().optional(),
});

export const updateAgentSkillSchema = z.object({
  methodId: z.string().optional(),
});

export const updatePrinterSchema = z.object({
  serialNumber: z.string().min(1).max(100),
  friendlyName: z.string().optional(),
  notes: z.string().optional(),
});

export const updatePhoneNumberSchema = z.object({
  friendlyName: z.string().optional(),
  voiceUrl: z.string().optional(),
  statusUrl: z.string().optional(),
  status: z.enum(["active", "inactive", "released"]).optional(),
  assignedRestaurantId: z.string().nullable().optional(),
  locality: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
});

export const updatePlatformSettingsSchema = z.object({
  newUserNotificationWebhook: z.string().optional(),
  newAgentNotificationWebhook: z.string().optional(),
  baseInstructions: z.string().optional(),
  personality: z.string().optional(),
});

export const updatePaymentMethodSchema = z.object({
  isDefault: z.boolean().optional(),
});

export const updateSubscriptionPriceSchema = z.object({
  stripePriceId: z.string().optional(),
  stripeMeteredPriceId: z.string().optional(),
  monthlyPrice: z.number().optional(),
  includedMinutes: z.number().optional(),
  includedCalls: z.number().optional(),
  perMinuteOverage: z.number().optional(),
  perCallOverage: z.number().optional(),
  features: z.string().optional(),
});

// Types
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type Restaurant = typeof restaurants.$inferSelect;
export type InsertRestaurant = z.infer<typeof insertRestaurantSchema>;
export type AgentConfiguration = typeof agentConfigurations.$inferSelect;
export type InsertAgentConfiguration = z.infer<typeof insertAgentConfigurationSchema>;
export type CallLog = typeof callLogs.$inferSelect;
export type InsertCallLog = z.infer<typeof insertCallLogSchema>;
export type UserAgentAccess = typeof userAgentAccess.$inferSelect;
export type InsertUserAgentAccess = z.infer<typeof insertUserAgentAccessSchema>;
export type UpdateRestaurant = z.infer<typeof updateRestaurantSchema>;
export type UpdateAgentConfig = z.infer<typeof updateAgentConfigSchema>;
export type UpdateUser = z.infer<typeof updateUserSchema>;
export type Skill = typeof skills.$inferSelect;
export type InsertSkill = z.infer<typeof insertSkillSchema>;
export type UpdateSkill = z.infer<typeof updateSkillSchema>;
export type Method = typeof methods.$inferSelect;
export type InsertMethod = z.infer<typeof insertMethodSchema>;
export type UpdateMethod = z.infer<typeof updateMethodSchema>;
export type AgentSkill = typeof agentSkills.$inferSelect;
export type InsertAgentSkill = z.infer<typeof insertAgentSkillSchema>;
export type UpdateAgentSkill = z.infer<typeof updateAgentSkillSchema>;
export type Printer = typeof printers.$inferSelect;
export type InsertPrinter = z.infer<typeof insertPrinterSchema>;
export type UpdatePrinter = z.infer<typeof updatePrinterSchema>;

export type PhoneNumber = typeof phoneNumbers.$inferSelect;
export type InsertPhoneNumber = z.infer<typeof insertPhoneNumberSchema>;
export type UpdatePhoneNumber = z.infer<typeof updatePhoneNumberSchema>;

export type PlatformSettings = typeof platformSettings.$inferSelect;
export type InsertPlatformSettings = z.infer<typeof insertPlatformSettingsSchema>;
export type UpdatePlatformSettings = z.infer<typeof updatePlatformSettingsSchema>;

export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type InsertPaymentMethod = z.infer<typeof insertPaymentMethodSchema>;
export type UpdatePaymentMethod = z.infer<typeof updatePaymentMethodSchema>;

export type Invoice = typeof invoices.$inferSelect;
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;

export type UsageRecord = typeof usageRecords.$inferSelect;
export type InsertUsageRecord = z.infer<typeof insertUsageRecordSchema>;

export type SubscriptionPrice = typeof subscriptionPrices.$inferSelect;
export type InsertSubscriptionPrice = z.infer<typeof insertSubscriptionPriceSchema>;
export type UpdateSubscriptionPrice = z.infer<typeof updateSubscriptionPriceSchema>;

export type ElevenlabsWebhook = typeof elevenlabsWebhooks.$inferSelect;
export type InsertElevenlabsWebhook = z.infer<typeof insertElevenlabsWebhookSchema>;

export type CallTranscriptMessage = typeof callTranscriptMessages.$inferSelect;
export type InsertCallTranscriptMessage = z.infer<typeof insertCallTranscriptMessageSchema>;

export type MenuOverride = typeof menuOverrides.$inferSelect;
export type InsertMenuOverride = z.infer<typeof insertMenuOverrideSchema>;
