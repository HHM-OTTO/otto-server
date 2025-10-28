import { 
  users, 
  restaurants, 
  agentConfigurations, 
  callLogs,
  userAgentAccess,
  agentSkills,
  elevenlabsWebhooks,
  callTranscriptMessages,
  menuOverrides,
  type User, 
  type InsertUser,
  type UpdateUser,
  type Restaurant,
  type InsertRestaurant,
  type UpdateRestaurant,
  type AgentConfiguration,
  type InsertAgentConfiguration,
  type UpdateAgentConfig,
  type CallLog,
  type InsertCallLog,
  type UserAgentAccess,
  type InsertUserAgentAccess,
  type Skill,
  type InsertSkill,
  type UpdateSkill,
  type Method,
  type InsertMethod,
  type UpdateMethod,
  type AgentSkill,
  type InsertAgentSkill,
  type UpdateAgentSkill,
  type Printer,
  type InsertPrinter,
  type UpdatePrinter,
  type PhoneNumber,
  type InsertPhoneNumber,
  type UpdatePhoneNumber,
  type PlatformSettings,
  type InsertPlatformSettings,
  type UpdatePlatformSettings,
  type SubscriptionPrice,
  type InsertSubscriptionPrice,
  type ElevenlabsWebhook,
  type InsertElevenlabsWebhook,
  type CallTranscriptMessage,
  type InsertCallTranscriptMessage,
  type MenuOverride,
  type InsertMenuOverride,
  skills,
  methods,
  printers,
  phoneNumbers,
  platformSettings,
  subscriptionPrices
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, or, sql, inArray } from "drizzle-orm";

export interface IStorage {
  // Users
  getUser(id: string): Promise<User | undefined>;
  getUserByFirebaseUid(firebaseUid: string): Promise<User | undefined>;
  getUserByStripeCustomerId(stripeCustomerId: string): Promise<User | undefined>;
  getAllUsers(): Promise<User[]>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, updateData: Partial<User>): Promise<User | undefined>;
  deleteUser(id: string): Promise<boolean>;
  updateUserRole(id: string, role: "admin" | "user"): Promise<User | undefined>;
  updateUserLastSeen(id: string): Promise<User | undefined>;

  // User-Agent Access Relationships
  getUserAgentAccess(userId: string): Promise<UserAgentAccess[]>;
  getAgentConfigurationAccess(agentConfigId: string): Promise<UserAgentAccess[]>;
  createUserAgentAccess(access: InsertUserAgentAccess): Promise<UserAgentAccess>;
  hasUserAgentAccess(userId: string, agentConfigId: string): Promise<boolean>;
  hasUserAgentWriteAccess(userId: string, agentConfigId: string): Promise<boolean>;
  deleteUserAgentAccess(userId: string, agentConfigId: string): Promise<boolean>;
  getAgentsForUser(userId: string): Promise<Array<AgentConfiguration & { agentName: string }>>;

  // Restaurants
  getRestaurant(id: string): Promise<Restaurant | undefined>;
  getRestaurantsByOwnerId(ownerId: string): Promise<Restaurant[]>;
  getAllRestaurants(): Promise<Restaurant[]>;
  createRestaurant(restaurant: InsertRestaurant): Promise<Restaurant>;
  updateRestaurant(id: string, updateData: UpdateRestaurant): Promise<Restaurant | undefined>;

  // Agent Configurations
  getAgentConfiguration(restaurantId: string): Promise<AgentConfiguration | undefined>;
  getAgentConfigurationById(id: string): Promise<AgentConfiguration | undefined>;
  getAllAgentConfigurations(): Promise<AgentConfiguration[]>;
  getAgentConfigurationByPhoneNumber(phoneNumber: string): Promise<(AgentConfiguration & { restaurantName: string }) | undefined>;
  createAgentConfiguration(config: InsertAgentConfiguration): Promise<AgentConfiguration>;
  updateAgentConfiguration(restaurantId: string, config: UpdateAgentConfig): Promise<AgentConfiguration | undefined>;
  updateAgentConfigurationById(id: string, config: Partial<AgentConfiguration>): Promise<AgentConfiguration | undefined>;
  deleteAgentConfiguration(restaurantId: string): Promise<boolean>;

  // Call Logs
  getCallLogsByRestaurant(restaurantId: string, limit?: number): Promise<Array<CallLog & { agentName: string }>>;
  getAllCallLogs(limit?: number): Promise<Array<CallLog & { agentName: string }>>;
  getCallLogsForUser(userId: string, limit?: number): Promise<Array<CallLog & { agentName: string }>>;
  getLastCallForRestaurant(restaurantId: string): Promise<CallLog | undefined>;
  getCallLogById(id: string): Promise<CallLog | undefined>;
  createCallLog(callLog: InsertCallLog): Promise<CallLog>;
  updateCallLog(id: string, updates: Partial<InsertCallLog>): Promise<CallLog | undefined>;
  getCallLogByTwilioSid(twilioCallSid: string): Promise<CallLog | undefined>;
  getInProgressCallsOlderThan(minutes: number): Promise<CallLog[]>;
  markUsageRecorded(id: string): Promise<boolean>;

  // ElevenLabs Webhooks
  createElevenlabsWebhook(webhook: InsertElevenlabsWebhook): Promise<ElevenlabsWebhook>;
  getElevenlabsWebhookByCallLogId(callLogId: string): Promise<ElevenlabsWebhook | undefined>;
  getWebhookDataByCallLogIds(callLogIds: string[]): Promise<Array<{ callLogId: string; rawData: string }>>;

  // Call Transcript Messages
  createTranscriptMessages(messages: InsertCallTranscriptMessage[]): Promise<CallTranscriptMessage[]>;
  getTranscriptMessagesByCallLogId(callLogId: string): Promise<CallTranscriptMessage[]>;

  // Conversations API
  getConversationsForUser(
    userId: string,
    userRole: string,
    options: {
      limit?: number;
      offset?: number;
      searchQuery?: string;
      agentIds?: string[];
      startDate?: Date;
      endDate?: Date;
    }
  ): Promise<{
    conversations: Array<CallLog & { 
      agentName: string;
      elevenlabsConversationId: string | null;
      elevenlabsAudioUrl: string | null;
      audioFileSize: number | null;
      audioRetrievedAt: Date | null;
    }>;
    total: number;
  }>;
  getConversationDetails(
    conversationId: string,
    userId: string,
    userRole: string
  ): Promise<(CallLog & { agentName: string; transcripts: CallTranscriptMessage[] }) | undefined>;
  
  // Authorization helpers
  userHasAccessToRestaurant(userId: string, restaurantId: string): Promise<boolean>;

  // Skills
  getAllSkills(): Promise<Skill[]>;
  getSkill(id: string): Promise<Skill | undefined>;
  createSkill(skill: InsertSkill): Promise<Skill>;
  updateSkill(id: string, skill: UpdateSkill): Promise<Skill | undefined>;
  deleteSkill(id: string): Promise<boolean>;

  // Methods
  getMethodsBySkillId(skillId: string): Promise<Array<Method & { agentCount: number }>>;
  getMethod(id: string): Promise<Method | undefined>;
  createMethod(method: InsertMethod): Promise<Method>;
  updateMethod(id: string, method: UpdateMethod): Promise<Method | undefined>;
  deleteMethod(id: string): Promise<boolean>;

  // Agent Skills
  getAgentSkillsByAgentConfigurationId(agentConfigurationId: string): Promise<Array<AgentSkill & { skillName: string; methodName: string }>>;
  getAgentSkillsByAgentId(agentId: string): Promise<AgentSkill[]>;
  createAgentSkill(agentSkill: InsertAgentSkill): Promise<AgentSkill>;
  updateAgentSkill(id: string, agentSkill: UpdateAgentSkill): Promise<AgentSkill | undefined>;
  deleteAgentSkill(id: string): Promise<boolean>;
  deleteAgentSkillBySkillId(agentConfigurationId: string, skillId: string): Promise<boolean>;
  deleteAgentSkillsByAgentId(agentId: string): Promise<boolean>;
  getActiveSkillsWithMethods(): Promise<Array<Skill & { methods: Method[] }>>;
  getAllSkillsWithMethods(): Promise<Array<Skill & { methods: Method[] }>>;

  // Printers
  getAllPrinters(): Promise<(Printer & { assignedAgent?: string | null })[]>;
  getAvailablePrinters(currentPrinterId?: string): Promise<Printer[]>; // Get printers not linked to any agent (include current if editing)
  getPrinter(id: string): Promise<Printer | undefined>;
  createPrinter(printer: InsertPrinter): Promise<Printer>;
  updatePrinter(id: string, printer: UpdatePrinter): Promise<Printer | undefined>;
  deletePrinter(id: string): Promise<boolean>;

  // Phone Numbers
  getAllPhoneNumbers(): Promise<(PhoneNumber & { linkedAgentName?: string | null })[]>;
  getAvailablePhoneNumbers(currentPhoneNumberId?: string): Promise<PhoneNumber[]>; // Get phone numbers not linked to any agent (include current if editing)
  getPhoneNumber(id: string): Promise<PhoneNumber | undefined>;
  getPhoneNumberByNumber(phoneNumber: string): Promise<PhoneNumber | undefined>;
  createPhoneNumber(phoneNumber: InsertPhoneNumber): Promise<PhoneNumber>;
  updatePhoneNumber(id: string, phoneNumber: UpdatePhoneNumber): Promise<PhoneNumber | undefined>;
  deletePhoneNumber(id: string): Promise<boolean>;

  // Platform Settings
  getPlatformSettings(): Promise<PlatformSettings | undefined>;
  createPlatformSettings(settings: InsertPlatformSettings): Promise<PlatformSettings>;
  updatePlatformSettings(id: string, settings: UpdatePlatformSettings): Promise<PlatformSettings | undefined>;

  // Wait Time Reset
  getAgentsNeedingWaitTimeReset(): Promise<AgentConfiguration[]>;

  // Menu Overrides
  createMenuOverride(override: InsertMenuOverride): Promise<MenuOverride>;
  getActiveOverridesByAgentId(agentConfigurationId: string): Promise<Array<MenuOverride & { modifiedByName: string }>>;
  getMenuOverrideById(id: string): Promise<MenuOverride | undefined>;
  updateMenuOverride(id: string, content: string, resetAt: Date | null, lastModifiedBy: string): Promise<MenuOverride | undefined>;
  softDeleteMenuOverride(id: string): Promise<boolean>;
  getOverridesNeedingAutoDelete(): Promise<MenuOverride[]>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByFirebaseUid(firebaseUid: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.firebaseUid, firebaseUid));
    return user || undefined;
  }

  async getUserByStripeCustomerId(stripeCustomerId: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.stripeCustomerId, stripeCustomerId));
    return user || undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users).orderBy(users.createdAt);
  }

  async updateUser(id: string, updateData: UpdateUser): Promise<User | undefined> {
    const [user] = await db
      .update(users)
      .set(updateData)
      .where(eq(users.id, id))
      .returning();
    return user || undefined;
  }

  async deleteUser(id: string): Promise<boolean> {
    // First delete any user-agent access relationships
    await db.delete(userAgentAccess).where(eq(userAgentAccess.userId, id));
    
    // Delete the user
    const result = await db.delete(users).where(eq(users.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async updateUserRole(id: string, role: "admin" | "user"): Promise<User | undefined> {
    const [user] = await db
      .update(users)
      .set({ role })
      .where(eq(users.id, id))
      .returning();
    return user || undefined;
  }

  async updateUserLastSeen(id: string): Promise<User | undefined> {
    const [user] = await db
      .update(users)
      .set({ lastSeen: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user || undefined;
  }

  // User-Agent Access Methods
  async getUserAgentAccess(userId: string): Promise<UserAgentAccess[]> {
    return await db
      .select()
      .from(userAgentAccess)
      .where(eq(userAgentAccess.userId, userId));
  }

  async getAgentConfigurationAccess(agentConfigId: string): Promise<UserAgentAccess[]> {
    return await db
      .select()
      .from(userAgentAccess)
      .where(eq(userAgentAccess.agentConfigurationId, agentConfigId));
  }

  async createUserAgentAccess(access: InsertUserAgentAccess): Promise<UserAgentAccess> {
    const [userAccess] = await db
      .insert(userAgentAccess)
      .values(access)
      .returning();
    return userAccess;
  }

  async hasUserAgentAccess(userId: string, agentConfigId: string): Promise<boolean> {
    const [access] = await db
      .select()
      .from(userAgentAccess)
      .where(
        and(
          eq(userAgentAccess.userId, userId),
          eq(userAgentAccess.agentConfigurationId, agentConfigId)
        )
      );
    return !!access;
  }

  async hasUserAgentWriteAccess(userId: string, agentConfigId: string): Promise<boolean> {
    const [access] = await db
      .select()
      .from(userAgentAccess)
      .where(
        and(
          eq(userAgentAccess.userId, userId),
          eq(userAgentAccess.agentConfigurationId, agentConfigId),
          eq(userAgentAccess.accessLevel, "write")
        )
      );
    return !!access;
  }

  async deleteUserAgentAccess(userId: string, agentConfigId: string): Promise<boolean> {
    const result = await db
      .delete(userAgentAccess)
      .where(
        and(
          eq(userAgentAccess.userId, userId),
          eq(userAgentAccess.agentConfigurationId, agentConfigId)
        )
      );
    return (result.rowCount ?? 0) > 0;
  }

  async getAgentsForUser(userId: string): Promise<Array<AgentConfiguration & { agentName: string; phoneNumber?: string | null }>> {
    const result = await db
      .select({
        // Agent configuration fields
        id: agentConfigurations.id,
        restaurantId: agentConfigurations.restaurantId,
        billingUserId: agentConfigurations.billingUserId,
        mode: agentConfigurations.mode,
        waitTimeMinutes: agentConfigurations.waitTimeMinutes,
        defaultWaitTimeMinutes: agentConfigurations.defaultWaitTimeMinutes,
        resetWaitTimeAt: agentConfigurations.resetWaitTimeAt,
        menuOverrides: agentConfigurations.menuOverrides,
        timeoutSeconds: agentConfigurations.timeoutSeconds,
        redirectPhoneNumber: agentConfigurations.redirectPhoneNumber,
        callerId: agentConfigurations.callerId,
        agentUrl: agentConfigurations.agentUrl,
        printerId: agentConfigurations.printerId,
        phoneNumberId: agentConfigurations.phoneNumberId,
        errorSmsPhone: agentConfigurations.errorSmsPhone,
        elevenlabsAgentId: agentConfigurations.elevenlabsAgentId,
        customGreeting: agentConfigurations.customGreeting,
        openingHours: agentConfigurations.openingHours,
        handoffPhoneNumber: agentConfigurations.handoffPhoneNumber,
        address: agentConfigurations.address,
        googlePlaceId: agentConfigurations.googlePlaceId,
        venueDetails: agentConfigurations.venueDetails,
        menu: agentConfigurations.menu,
        menuUrl: agentConfigurations.menuUrl,
        allowBetaSkills: agentConfigurations.allowBetaSkills,
        allowInactiveSkills: agentConfigurations.allowInactiveSkills,
        onboardingStage: agentConfigurations.onboardingStage,
        isActive: agentConfigurations.isActive,
        updatedAt: agentConfigurations.updatedAt,
        // Restaurant name as agentName
        agentName: restaurants.name,
        // Phone number
        phoneNumber: phoneNumbers.phoneNumber,
      })
      .from(userAgentAccess)
      .innerJoin(agentConfigurations, eq(userAgentAccess.agentConfigurationId, agentConfigurations.id))
      .innerJoin(restaurants, eq(agentConfigurations.restaurantId, restaurants.id))
      .leftJoin(phoneNumbers, eq(agentConfigurations.phoneNumberId, phoneNumbers.id))
      .where(eq(userAgentAccess.userId, userId));
    
    return result;
  }

  async getRestaurant(id: string): Promise<Restaurant | undefined> {
    const [restaurant] = await db.select().from(restaurants).where(eq(restaurants.id, id));
    return restaurant || undefined;
  }

  async getRestaurantsByOwnerId(ownerId: string): Promise<Restaurant[]> {
    return await db.select().from(restaurants).where(eq(restaurants.ownerId, ownerId));
  }

  async getAllRestaurants(): Promise<Restaurant[]> {
    return await db.select().from(restaurants);
  }

  async createRestaurant(insertRestaurant: InsertRestaurant): Promise<Restaurant> {
    const [restaurant] = await db
      .insert(restaurants)
      .values(insertRestaurant)
      .returning();
    
    // Create default agent configuration with owner as billing user
    await this.createAgentConfiguration({
      restaurantId: restaurant.id,
      billingUserId: insertRestaurant.ownerId,
      mode: "agent",
      waitTimeMinutes: 15,
      isActive: true,
    });

    return restaurant;
  }

  async updateRestaurant(id: string, updateData: UpdateRestaurant): Promise<Restaurant | undefined> {
    const [updated] = await db
      .update(restaurants)
      .set(updateData)
      .where(eq(restaurants.id, id))
      .returning();
    return updated || undefined;
  }

  async getAgentConfiguration(restaurantId: string): Promise<AgentConfiguration | undefined> {
    const [config] = await db
      .select()
      .from(agentConfigurations)
      .where(eq(agentConfigurations.restaurantId, restaurantId));
    return config || undefined;
  }

  async getAgentConfigurationByPhoneNumber(phoneNumber: string): Promise<(AgentConfiguration & { restaurantName: string }) | undefined> {
    // Ensure phone number has + prefix for database query
    const formattedPhoneNumber = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
    
    const [result] = await db
      .select({
        id: agentConfigurations.id,
        restaurantId: agentConfigurations.restaurantId,
        billingUserId: agentConfigurations.billingUserId,
        mode: agentConfigurations.mode,
        phoneNumber: phoneNumbers.phoneNumber,
        waitTimeMinutes: agentConfigurations.waitTimeMinutes,
        defaultWaitTimeMinutes: agentConfigurations.defaultWaitTimeMinutes,
        resetWaitTimeAt: agentConfigurations.resetWaitTimeAt,
        menuOverrides: agentConfigurations.menuOverrides,
        timeoutSeconds: agentConfigurations.timeoutSeconds,
        redirectPhoneNumber: agentConfigurations.redirectPhoneNumber,
        callerId: agentConfigurations.callerId,
        agentUrl: agentConfigurations.agentUrl,
        printerId: agentConfigurations.printerId,
        phoneNumberId: agentConfigurations.phoneNumberId,
        errorSmsPhone: agentConfigurations.errorSmsPhone,
        elevenlabsAgentId: agentConfigurations.elevenlabsAgentId,
        customGreeting: agentConfigurations.customGreeting,
        openingHours: agentConfigurations.openingHours,
        handoffPhoneNumber: agentConfigurations.handoffPhoneNumber,
        address: agentConfigurations.address,
        googlePlaceId: agentConfigurations.googlePlaceId,
        venueDetails: agentConfigurations.venueDetails,
        menu: agentConfigurations.menu,
        menuUrl: agentConfigurations.menuUrl,
        allowBetaSkills: agentConfigurations.allowBetaSkills,
        allowInactiveSkills: agentConfigurations.allowInactiveSkills,
        onboardingStage: agentConfigurations.onboardingStage,
        isActive: agentConfigurations.isActive,
        updatedAt: agentConfigurations.updatedAt,
        restaurantName: restaurants.name,
      })
      .from(agentConfigurations)
      .innerJoin(restaurants, eq(agentConfigurations.restaurantId, restaurants.id))
      .innerJoin(phoneNumbers, eq(agentConfigurations.phoneNumberId, phoneNumbers.id))
      .where(eq(phoneNumbers.phoneNumber, formattedPhoneNumber));
    
    return result || undefined;
  }

  async createAgentConfiguration(config: InsertAgentConfiguration): Promise<AgentConfiguration> {
    const [agentConfig] = await db
      .insert(agentConfigurations)
      .values(config)
      .returning();
    return agentConfig;
  }

  async updateAgentConfiguration(restaurantId: string, config: UpdateAgentConfig): Promise<AgentConfiguration | undefined> {
    // Convert resetWaitTimeAt from string to Date if needed
    const processedConfig: any = {
      ...config,
      updatedAt: new Date()
    };
    
    // Handle resetWaitTimeAt conversion
    if (config.resetWaitTimeAt !== undefined) {
      if (typeof config.resetWaitTimeAt === 'string') {
        processedConfig.resetWaitTimeAt = new Date(config.resetWaitTimeAt);
      } else {
        processedConfig.resetWaitTimeAt = config.resetWaitTimeAt;
      }
    }
    
    const [updated] = await db
      .update(agentConfigurations)
      .set(processedConfig)
      .where(eq(agentConfigurations.restaurantId, restaurantId))
      .returning();
    return updated || undefined;
  }

  async getAgentConfigurationById(id: string): Promise<AgentConfiguration | undefined> {
    const [config] = await db
      .select()
      .from(agentConfigurations)
      .where(eq(agentConfigurations.id, id));
    return config || undefined;
  }

  async getAllAgentConfigurations(): Promise<AgentConfiguration[]> {
    return await db
      .select()
      .from(agentConfigurations)
      .orderBy(agentConfigurations.restaurantId);
  }

  async updateAgentConfigurationById(id: string, config: Partial<AgentConfiguration>): Promise<AgentConfiguration | undefined> {
    const [updated] = await db
      .update(agentConfigurations)
      .set({ ...config, updatedAt: new Date() })
      .where(eq(agentConfigurations.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteAgentConfiguration(restaurantId: string): Promise<boolean> {
    // Get the agent configuration to get its ID
    const agentConfig = await this.getAgentConfiguration(restaurantId);
    if (!agentConfig) {
      return false;
    }

    // Delete agent skills
    await db.delete(agentSkills).where(eq(agentSkills.agentConfigurationId, agentConfig.id));

    // Delete user agent access
    await db.delete(userAgentAccess).where(eq(userAgentAccess.agentConfigurationId, agentConfig.id));

    // Delete agent configuration (note: call logs are kept for history)
    await db.delete(agentConfigurations).where(eq(agentConfigurations.restaurantId, restaurantId));

    // Delete the restaurant
    const result = await db.delete(restaurants).where(eq(restaurants.id, restaurantId));
    
    return (result.rowCount ?? 0) > 0;
  }

  async getCallLogsByRestaurant(restaurantId: string, limit: number = 50): Promise<Array<CallLog & { agentName: string }>> {
    const result = await db
      .select({
        id: callLogs.id,
        restaurantId: callLogs.restaurantId,
        customerPhone: callLogs.customerPhone,
        twilioCallSid: callLogs.twilioCallSid,
        duration: callLogs.duration,
        status: callLogs.status,
        orderValue: callLogs.orderValue,
        recordingUrl: callLogs.recordingUrl,
        elevenlabsConversationId: callLogs.elevenlabsConversationId,
        elevenlabsAudioUrl: callLogs.elevenlabsAudioUrl,
        localAudioPath: callLogs.localAudioPath,
        audioFileSize: callLogs.audioFileSize,
        audioRetrievedAt: callLogs.audioRetrievedAt,
        lastPolledAt: callLogs.lastPolledAt,
        usageRecordedAt: callLogs.usageRecordedAt,
        summary: callLogs.summary,
        summaryTitle: callLogs.summaryTitle,
        toolCallsJson: callLogs.toolCallsJson,
        transferredToHuman: callLogs.transferredToHuman,
        mainLanguage: callLogs.mainLanguage,
        createdAt: callLogs.createdAt,
        agentName: restaurants.name,
      })
      .from(callLogs)
      .innerJoin(restaurants, eq(callLogs.restaurantId, restaurants.id))
      .where(eq(callLogs.restaurantId, restaurantId))
      .orderBy(desc(callLogs.createdAt))
      .limit(limit);
    
    return result;
  }

  async getAllCallLogs(limit: number = 1000): Promise<Array<CallLog & { agentName: string }>> {
    const result = await db
      .select({
        id: callLogs.id,
        restaurantId: callLogs.restaurantId,
        customerPhone: callLogs.customerPhone,
        twilioCallSid: callLogs.twilioCallSid,
        duration: callLogs.duration,
        status: callLogs.status,
        orderValue: callLogs.orderValue,
        recordingUrl: callLogs.recordingUrl,
        elevenlabsConversationId: callLogs.elevenlabsConversationId,
        elevenlabsAudioUrl: callLogs.elevenlabsAudioUrl,
        localAudioPath: callLogs.localAudioPath,
        audioFileSize: callLogs.audioFileSize,
        audioRetrievedAt: callLogs.audioRetrievedAt,
        lastPolledAt: callLogs.lastPolledAt,
        usageRecordedAt: callLogs.usageRecordedAt,
        summary: callLogs.summary,
        summaryTitle: callLogs.summaryTitle,
        toolCallsJson: callLogs.toolCallsJson,
        transferredToHuman: callLogs.transferredToHuman,
        mainLanguage: callLogs.mainLanguage,
        createdAt: callLogs.createdAt,
        agentName: restaurants.name,
      })
      .from(callLogs)
      .innerJoin(restaurants, eq(callLogs.restaurantId, restaurants.id))
      .orderBy(desc(callLogs.createdAt))
      .limit(limit);
    
    return result;
  }

  async getCallLogsForUser(userId: string, limit: number = 1000): Promise<Array<CallLog & { agentName: string }>> {
    const result = await db
      .select({
        id: callLogs.id,
        restaurantId: callLogs.restaurantId,
        customerPhone: callLogs.customerPhone,
        twilioCallSid: callLogs.twilioCallSid,
        duration: callLogs.duration,
        status: callLogs.status,
        orderValue: callLogs.orderValue,
        recordingUrl: callLogs.recordingUrl,
        elevenlabsConversationId: callLogs.elevenlabsConversationId,
        elevenlabsAudioUrl: callLogs.elevenlabsAudioUrl,
        localAudioPath: callLogs.localAudioPath,
        audioFileSize: callLogs.audioFileSize,
        audioRetrievedAt: callLogs.audioRetrievedAt,
        lastPolledAt: callLogs.lastPolledAt,
        usageRecordedAt: callLogs.usageRecordedAt,
        summary: callLogs.summary,
        summaryTitle: callLogs.summaryTitle,
        toolCallsJson: callLogs.toolCallsJson,
        transferredToHuman: callLogs.transferredToHuman,
        mainLanguage: callLogs.mainLanguage,
        createdAt: callLogs.createdAt,
        agentName: restaurants.name,
      })
      .from(callLogs)
      .innerJoin(restaurants, eq(callLogs.restaurantId, restaurants.id))
      .innerJoin(agentConfigurations, eq(callLogs.restaurantId, agentConfigurations.restaurantId))
      .innerJoin(userAgentAccess, eq(agentConfigurations.id, userAgentAccess.agentConfigurationId))
      .where(eq(userAgentAccess.userId, userId))
      .orderBy(desc(callLogs.createdAt))
      .limit(limit);
    
    return result;
  }

  async getLastCallForRestaurant(restaurantId: string): Promise<CallLog | undefined> {
    const [lastCall] = await db
      .select()
      .from(callLogs)
      .where(eq(callLogs.restaurantId, restaurantId))
      .orderBy(desc(callLogs.createdAt))
      .limit(1);
    return lastCall || undefined;
  }

  async createCallLog(callLog: InsertCallLog): Promise<CallLog> {
    const [log] = await db
      .insert(callLogs)
      .values(callLog)
      .returning();
    return log;
  }

  async updateCallLog(id: string, updates: Partial<InsertCallLog>): Promise<CallLog | undefined> {
    const [updated] = await db
      .update(callLogs)
      .set(updates)
      .where(eq(callLogs.id, id))
      .returning();
    return updated || undefined;
  }

  async getCallLogById(id: string): Promise<CallLog | undefined> {
    const [callLog] = await db
      .select()
      .from(callLogs)
      .where(eq(callLogs.id, id));
    return callLog || undefined;
  }

  async getCallLogByTwilioSid(twilioCallSid: string): Promise<CallLog | undefined> {
    const [callLog] = await db
      .select()
      .from(callLogs)
      .where(eq(callLogs.twilioCallSid, twilioCallSid));
    return callLog || undefined;
  }

  async getInProgressCallsOlderThan(minutes: number): Promise<CallLog[]> {
    const cutoffTime = new Date(Date.now() - minutes * 60 * 1000);
    
    return await db
      .select()
      .from(callLogs)
      .where(
        and(
          eq(callLogs.status, "in-progress"),
          sql`${callLogs.createdAt} < ${cutoffTime}`
        )
      );
  }

  async markUsageRecorded(id: string): Promise<boolean> {
    // Atomic operation: only set usageRecordedAt if it's currently null
    // Returns true if the update was successful (i.e., we were the first to mark it)
    const [result] = await db
      .update(callLogs)
      .set({ usageRecordedAt: new Date() })
      .where(
        and(
          eq(callLogs.id, id),
          sql`${callLogs.usageRecordedAt} IS NULL`
        )
      )
      .returning({ id: callLogs.id });
    
    return !!result;
  }

  // ElevenLabs Webhooks operations
  async createElevenlabsWebhook(webhook: InsertElevenlabsWebhook): Promise<ElevenlabsWebhook> {
    const [created] = await db.insert(elevenlabsWebhooks).values(webhook).returning();
    return created;
  }

  async getElevenlabsWebhookByCallLogId(callLogId: string): Promise<ElevenlabsWebhook | undefined> {
    const [webhook] = await db
      .select()
      .from(elevenlabsWebhooks)
      .where(eq(elevenlabsWebhooks.callLogId, callLogId));
    return webhook || undefined;
  }

  async getWebhookDataByCallLogIds(callLogIds: string[]): Promise<Array<{ callLogId: string; rawData: string }>> {
    if (callLogIds.length === 0) return [];
    
    const webhooks = await db
      .select({
        callLogId: elevenlabsWebhooks.callLogId,
        rawData: elevenlabsWebhooks.rawData,
      })
      .from(elevenlabsWebhooks)
      .where(inArray(elevenlabsWebhooks.callLogId, callLogIds));
    
    return webhooks;
  }

  // Call Transcript Messages operations
  async createTranscriptMessages(messages: InsertCallTranscriptMessage[]): Promise<CallTranscriptMessage[]> {
    if (messages.length === 0) return [];
    const created = await db.insert(callTranscriptMessages).values(messages).returning();
    return created;
  }

  async getTranscriptMessagesByCallLogId(callLogId: string): Promise<CallTranscriptMessage[]> {
    return await db
      .select()
      .from(callTranscriptMessages)
      .where(eq(callTranscriptMessages.callLogId, callLogId))
      .orderBy(callTranscriptMessages.timeInCallSecs);
  }

  // Conversations API methods for the new Conversations feature
  async getConversationsForUser(
    userId: string,
    userRole: string,
    options: {
      limit?: number;
      offset?: number;
      searchQuery?: string;
      agentIds?: string[];
      startDate?: Date;
      endDate?: Date;
    } = {}
  ): Promise<{
    conversations: Array<CallLog & { 
      agentName: string;
      elevenlabsConversationId: string | null;
      elevenlabsAudioUrl: string | null;
      audioFileSize: number | null;
      audioRetrievedAt: Date | null;
    }>;
    total: number;
  }> {
    const { limit = 20, offset = 0, searchQuery, agentIds, startDate, endDate } = options;
    
    // Build the base query based on user role
    let baseQuery = db
      .select({
        id: callLogs.id,
        restaurantId: callLogs.restaurantId,
        customerPhone: callLogs.customerPhone,
        twilioCallSid: callLogs.twilioCallSid,
        duration: callLogs.duration,
        status: callLogs.status,
        orderValue: callLogs.orderValue,
        recordingUrl: callLogs.recordingUrl,
        elevenlabsConversationId: callLogs.elevenlabsConversationId,
        elevenlabsAudioUrl: callLogs.elevenlabsAudioUrl,
        localAudioPath: callLogs.localAudioPath,
        audioFileSize: callLogs.audioFileSize,
        audioRetrievedAt: callLogs.audioRetrievedAt,
        lastPolledAt: callLogs.lastPolledAt,
        usageRecordedAt: callLogs.usageRecordedAt,
        summary: callLogs.summary,
        summaryTitle: callLogs.summaryTitle,
        toolCallsJson: callLogs.toolCallsJson,
        transferredToHuman: callLogs.transferredToHuman,
        mainLanguage: callLogs.mainLanguage,
        createdAt: callLogs.createdAt,
        agentName: restaurants.name,
      })
      .from(callLogs)
      .innerJoin(restaurants, eq(callLogs.restaurantId, restaurants.id))
      .$dynamic();

    // Build conditions array
    const conditions = [];

    // Add role-based filtering
    if (userRole === 'super_user') {
      // Super users only see agents they have access to
      baseQuery = baseQuery
        .innerJoin(agentConfigurations, eq(callLogs.restaurantId, agentConfigurations.restaurantId))
        .innerJoin(userAgentAccess, eq(agentConfigurations.id, userAgentAccess.agentConfigurationId));
      conditions.push(eq(userAgentAccess.userId, userId));
    }
    // Admin users see all conversations (no additional filtering needed)

    // Filter only completed conversations
    conditions.push(eq(callLogs.status, 'completed'));

    // Add search filter
    if (searchQuery) {
      conditions.push(
        or(
          sql`${callLogs.summary} ILIKE ${`%${searchQuery}%`}`,
          sql`${callLogs.summaryTitle} ILIKE ${`%${searchQuery}%`}`
        )
      );
    }

    // Add agent filter (support multiple agents)
    if (agentIds && agentIds.length > 0) {
      conditions.push(inArray(callLogs.restaurantId, agentIds));
    }

    // Add date range filter
    if (startDate) {
      conditions.push(sql`${callLogs.createdAt} >= ${startDate}`);
    }
    if (endDate) {
      conditions.push(sql`${callLogs.createdAt} <= ${endDate}`);
    }

    // Apply conditions if any exist
    if (conditions.length > 0) {
      baseQuery = baseQuery.where(and(...conditions));
    }

    // Get total count
    let countQuery;
    if (userRole === 'super_user') {
      countQuery = db.select({ count: sql`COUNT(*)` })
        .from(callLogs)
        .innerJoin(agentConfigurations, eq(callLogs.restaurantId, agentConfigurations.restaurantId))
        .innerJoin(userAgentAccess, eq(agentConfigurations.id, userAgentAccess.agentConfigurationId));
    } else {
      countQuery = db.select({ count: sql`COUNT(*)` }).from(callLogs);
    }
    
    if (conditions.length > 0) {
      countQuery = countQuery.where(and(...conditions));
    }
    const [{ count }] = await countQuery;

    // Get paginated results
    const conversations = await baseQuery
      .orderBy(desc(callLogs.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      conversations,
      total: Number(count),
    };
  }

  async getConversationDetails(
    conversationId: string,
    userId: string,
    userRole: string
  ): Promise<(CallLog & { agentName: string; transcripts: CallTranscriptMessage[] }) | undefined> {
    // First get the call log with agent name
    const [conversation] = await db
      .select({
        id: callLogs.id,
        restaurantId: callLogs.restaurantId,
        customerPhone: callLogs.customerPhone,
        twilioCallSid: callLogs.twilioCallSid,
        duration: callLogs.duration,
        status: callLogs.status,
        orderValue: callLogs.orderValue,
        recordingUrl: callLogs.recordingUrl,
        elevenlabsConversationId: callLogs.elevenlabsConversationId,
        elevenlabsAudioUrl: callLogs.elevenlabsAudioUrl,
        localAudioPath: callLogs.localAudioPath,
        audioFileSize: callLogs.audioFileSize,
        audioRetrievedAt: callLogs.audioRetrievedAt,
        lastPolledAt: callLogs.lastPolledAt,
        usageRecordedAt: callLogs.usageRecordedAt,
        summary: callLogs.summary,
        summaryTitle: callLogs.summaryTitle,
        toolCallsJson: callLogs.toolCallsJson,
        transferredToHuman: callLogs.transferredToHuman,
        mainLanguage: callLogs.mainLanguage,
        createdAt: callLogs.createdAt,
        agentName: restaurants.name,
      })
      .from(callLogs)
      .innerJoin(restaurants, eq(callLogs.restaurantId, restaurants.id))
      .where(eq(callLogs.id, conversationId));

    if (!conversation) {
      return undefined;
    }

    // Check authorization
    if (userRole === 'super_user') {
      // Check if super user has access to this agent
      const hasAccess = await this.userHasAccessToRestaurant(userId, conversation.restaurantId);
      if (!hasAccess) {
        return undefined;
      }
    }
    // Admins have access to all conversations

    // Get transcript messages
    const transcripts = await this.getTranscriptMessagesByCallLogId(conversationId);

    return {
      ...conversation,
      transcripts,
    };
  }

  async userHasAccessToRestaurant(userId: string, restaurantId: string): Promise<boolean> {
    // Check if user has access to any agent in this restaurant
    const agentConfigs = await db
      .select()
      .from(agentConfigurations)
      .where(eq(agentConfigurations.restaurantId, restaurantId));
    
    if (agentConfigs.length === 0) {
      return false;
    }

    for (const config of agentConfigs) {
      const hasAccess = await this.hasUserAgentAccess(userId, config.id);
      if (hasAccess) {
        return true;
      }
    }
    
    return false;
  }

  // Skills CRUD operations
  async getAllSkills(): Promise<Skill[]> {
    return await db.select().from(skills).orderBy(skills.name);
  }

  async getSkill(id: string): Promise<Skill | undefined> {
    const [skill] = await db.select().from(skills).where(eq(skills.id, id));
    return skill || undefined;
  }

  async createSkill(skill: InsertSkill): Promise<Skill> {
    const [created] = await db.insert(skills).values(skill).returning();
    return created;
  }

  async updateSkill(id: string, skill: UpdateSkill): Promise<Skill | undefined> {
    const [updated] = await db.update(skills).set(skill).where(eq(skills.id, id)).returning();
    return updated || undefined;
  }

  async deleteSkill(id: string): Promise<boolean> {
    // First delete all methods for this skill (cascade)
    await db.delete(methods).where(eq(methods.skillId, id));
    // Then delete the skill itself
    const result = await db.delete(skills).where(eq(skills.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // Methods CRUD operations
  async getMethodsBySkillId(skillId: string): Promise<Array<Method & { agentCount: number }>> {
    const methodsData = await db.select().from(methods).where(eq(methods.skillId, skillId)).orderBy(methods.name);
    
    // For each method, count how many agents are using it
    const methodsWithAgentCount = await Promise.all(
      methodsData.map(async (method) => {
        const agentCount = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(agentSkills)
          .where(eq(agentSkills.methodId, method.id));
        
        return {
          ...method,
          agentCount: agentCount[0]?.count || 0,
        };
      })
    );
    
    return methodsWithAgentCount;
  }

  async getMethod(id: string): Promise<Method | undefined> {
    const [method] = await db.select().from(methods).where(eq(methods.id, id));
    return method || undefined;
  }

  async createMethod(method: InsertMethod): Promise<Method> {
    const [created] = await db.insert(methods).values(method).returning();
    return created;
  }

  async updateMethod(id: string, method: UpdateMethod): Promise<Method | undefined> {
    const [updated] = await db.update(methods).set(method).where(eq(methods.id, id)).returning();
    return updated || undefined;
  }

  async deleteMethod(id: string): Promise<boolean> {
    const result = await db.delete(methods).where(eq(methods.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // Agent Skills CRUD operations
  async getAgentSkillsByAgentConfigurationId(agentConfigurationId: string): Promise<Array<AgentSkill & { skillName: string; methodName: string }>> {
    const result = await db
      .select({
        id: agentSkills.id,
        agentConfigurationId: agentSkills.agentConfigurationId,
        skillId: agentSkills.skillId,
        methodId: agentSkills.methodId,
        createdAt: agentSkills.createdAt,
        skillName: skills.name,
        methodName: methods.name,
      })
      .from(agentSkills)
      .innerJoin(skills, eq(agentSkills.skillId, skills.id))
      .innerJoin(methods, eq(agentSkills.methodId, methods.id))
      .where(eq(agentSkills.agentConfigurationId, agentConfigurationId));
    
    return result;
  }

  async createAgentSkill(agentSkill: InsertAgentSkill): Promise<AgentSkill> {
    const [created] = await db.insert(agentSkills).values(agentSkill).returning();
    return created;
  }

  async updateAgentSkill(id: string, agentSkill: UpdateAgentSkill): Promise<AgentSkill | undefined> {
    const [updated] = await db.update(agentSkills).set(agentSkill).where(eq(agentSkills.id, id)).returning();
    return updated || undefined;
  }

  async deleteAgentSkill(id: string): Promise<boolean> {
    const result = await db.delete(agentSkills).where(eq(agentSkills.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async deleteAgentSkillBySkillId(agentConfigurationId: string, skillId: string): Promise<boolean> {
    const result = await db
      .delete(agentSkills)
      .where(
        and(
          eq(agentSkills.agentConfigurationId, agentConfigurationId),
          eq(agentSkills.skillId, skillId)
        )
      );
    return (result.rowCount ?? 0) > 0;
  }

  async getAgentSkillsByAgentId(agentId: string): Promise<AgentSkill[]> {
    return await db
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.agentConfigurationId, agentId));
  }

  async deleteAgentSkillsByAgentId(agentId: string): Promise<boolean> {
    const result = await db
      .delete(agentSkills)
      .where(eq(agentSkills.agentConfigurationId, agentId));
    return (result.rowCount ?? 0) > 0;
  }

  async getActiveSkillsWithMethods(): Promise<Array<Skill & { methods: Method[] }>> {
    // Get all active skills
    const activeSkills = await db
      .select()
      .from(skills)
      .where(eq(skills.status, "Active"))
      .orderBy(skills.name);

    // For each skill, get its active methods
    const skillsWithMethods = await Promise.all(
      activeSkills.map(async (skill) => {
        const activeMethods = await db
          .select()
          .from(methods)
          .where(
            and(
              eq(methods.skillId, skill.id),
              eq(methods.status, "Active")
            )
          )
          .orderBy(methods.name);
        
        return { ...skill, methods: activeMethods };
      })
    );

    return skillsWithMethods;
  }

  async getAllSkillsWithMethods(): Promise<Array<Skill & { methods: Method[] }>> {
    // Get all skills
    const allSkills = await db
      .select()
      .from(skills)
      .orderBy(skills.name);

    // For each skill, get all its methods
    const skillsWithMethods = await Promise.all(
      allSkills.map(async (skill) => {
        const allMethods = await db
          .select()
          .from(methods)
          .where(eq(methods.skillId, skill.id))
          .orderBy(methods.name);
        
        return { ...skill, methods: allMethods };
      })
    );

    return skillsWithMethods;
  }

  async getAgentSkillsWithMethodDetails(agentConfigurationId: string): Promise<Array<{
    id: string;
    skillId: string;
    skillName: string;
    skillDescription: string | null;
    methodId: string;
    methodName: string;
    methodPrompt: string;
  }>> {
    const result = await db
      .select({
        id: agentSkills.id,
        skillId: agentSkills.skillId,
        skillName: skills.name,
        skillDescription: skills.description,
        methodId: agentSkills.methodId,
        methodName: methods.name,
        methodPrompt: methods.prompt,
      })
      .from(agentSkills)
      .innerJoin(skills, eq(agentSkills.skillId, skills.id))
      .innerJoin(methods, eq(agentSkills.methodId, methods.id))
      .where(eq(agentSkills.agentConfigurationId, agentConfigurationId));
    
    return result;
  }

  // Printers CRUD operations
  async getAllPrinters(): Promise<(Printer & { assignedAgent?: string | null })[]> {
    // Get all printers with their associated agent/restaurant names
    const result = await db
      .select({
        printer: printers,
        restaurantName: restaurants.name,
      })
      .from(printers)
      .leftJoin(agentConfigurations, eq(agentConfigurations.printerId, printers.id))
      .leftJoin(restaurants, eq(restaurants.id, agentConfigurations.restaurantId))
      .orderBy(printers.serialNumber);
    
    // Map the results to include the agent name as a property
    return result.map(row => ({
      ...row.printer,
      assignedAgent: row.restaurantName || null,
    }));
  }

  async getAvailablePrinters(currentPrinterId?: string): Promise<Printer[]> {
    // Get all printers that are not linked to any agent configuration
    // BUT include the current printer if provided (for editing scenarios)
    const linkedPrinters = await db
      .select({ printerId: agentConfigurations.printerId })
      .from(agentConfigurations)
      .where(sql`${agentConfigurations.printerId} IS NOT NULL`);
    
    let linkedPrinterIds = linkedPrinters.map(p => p.printerId).filter(id => id !== null);
    
    // Remove current printer from the linked list so it appears as available
    if (currentPrinterId) {
      linkedPrinterIds = linkedPrinterIds.filter(id => id !== currentPrinterId);
    }
    
    if (linkedPrinterIds.length === 0) {
      // If no printers are linked (or only current is linked), return all printers
      return await db.select().from(printers).orderBy(printers.serialNumber);
    }
    
    // Return printers that are not in the linked list
    return await db
      .select()
      .from(printers)
      .where(sql`${printers.id} NOT IN (${sql.join(linkedPrinterIds.map(id => sql`${id}`), sql`, `)})`)
      .orderBy(printers.serialNumber);
  }

  async getPrinter(id: string): Promise<Printer | undefined> {
    const [printer] = await db.select().from(printers).where(eq(printers.id, id));
    return printer || undefined;
  }

  async createPrinter(printer: InsertPrinter): Promise<Printer> {
    const [created] = await db.insert(printers).values(printer).returning();
    return created;
  }

  async updatePrinter(id: string, printer: UpdatePrinter): Promise<Printer | undefined> {
    const [updated] = await db.update(printers).set(printer).where(eq(printers.id, id)).returning();
    return updated || undefined;
  }

  async deletePrinter(id: string): Promise<boolean> {
    const result = await db.delete(printers).where(eq(printers.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // Phone Numbers implementation
  async getAllPhoneNumbers(): Promise<(PhoneNumber & { linkedAgentName?: string | null })[]> {
    const result = await db
      .select({
        id: phoneNumbers.id,
        phoneNumber: phoneNumbers.phoneNumber,
        friendlyName: phoneNumbers.friendlyName,
        twilioSid: phoneNumbers.twilioSid,
        voiceUrl: phoneNumbers.voiceUrl,
        statusUrl: phoneNumbers.statusUrl,
        capabilities: phoneNumbers.capabilities,
        status: phoneNumbers.status,
        areaCode: phoneNumbers.areaCode,
        locality: phoneNumbers.locality,
        region: phoneNumbers.region,
        country: phoneNumbers.country,
        assignedRestaurantId: phoneNumbers.assignedRestaurantId,
        createdAt: phoneNumbers.createdAt,
        updatedAt: phoneNumbers.updatedAt,
        linkedAgentName: restaurants.name,
      })
      .from(phoneNumbers)
      .leftJoin(agentConfigurations, eq(phoneNumbers.id, agentConfigurations.phoneNumberId))
      .leftJoin(restaurants, eq(agentConfigurations.restaurantId, restaurants.id))
      .orderBy(phoneNumbers.createdAt);

    return result.map(row => ({
      ...row,
      linkedAgentName: row.linkedAgentName || null
    }));
  }

  async getAvailablePhoneNumbers(currentPhoneNumberId?: string): Promise<PhoneNumber[]> {
    // Get all phone numbers that are not linked to any agent configuration
    // BUT include the current phone number if provided (for editing scenarios)
    const linkedPhoneNumbers = await db
      .select({ phoneNumberId: agentConfigurations.phoneNumberId })
      .from(agentConfigurations)
      .where(sql`${agentConfigurations.phoneNumberId} IS NOT NULL`);
    
    let linkedPhoneNumberIds = linkedPhoneNumbers.map(p => p.phoneNumberId).filter((id): id is string => id !== null);
    
    // Remove current phone number from the linked list so it appears as available
    if (currentPhoneNumberId) {
      linkedPhoneNumberIds = linkedPhoneNumberIds.filter(id => id !== currentPhoneNumberId);
    }
    
    if (linkedPhoneNumberIds.length === 0) {
      // If no phone numbers are linked (or only current is linked), return all phone numbers
      return await db.select().from(phoneNumbers).orderBy(phoneNumbers.phoneNumber);
    }
    
    // Return phone numbers that are not in the linked list using proper parameter binding
    const { notInArray } = await import("drizzle-orm");
    return await db
      .select()
      .from(phoneNumbers)
      .where(notInArray(phoneNumbers.id, linkedPhoneNumberIds))
      .orderBy(phoneNumbers.phoneNumber);
  }

  async getPhoneNumber(id: string): Promise<PhoneNumber | undefined> {
    const [phoneNumber] = await db.select().from(phoneNumbers).where(eq(phoneNumbers.id, id));
    return phoneNumber || undefined;
  }

  async getPhoneNumberByNumber(phoneNumber: string): Promise<PhoneNumber | undefined> {
    const [number] = await db.select().from(phoneNumbers).where(eq(phoneNumbers.phoneNumber, phoneNumber));
    return number || undefined;
  }

  async createPhoneNumber(phoneNumber: InsertPhoneNumber): Promise<PhoneNumber> {
    const [created] = await db.insert(phoneNumbers).values(phoneNumber).returning();
    return created;
  }

  async updatePhoneNumber(id: string, phoneNumber: UpdatePhoneNumber): Promise<PhoneNumber | undefined> {
    const [updated] = await db.update(phoneNumbers).set(phoneNumber).where(eq(phoneNumbers.id, id)).returning();
    return updated || undefined;
  }

  async deletePhoneNumber(id: string): Promise<boolean> {
    const result = await db.delete(phoneNumbers).where(eq(phoneNumbers.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async getPlatformSettings(): Promise<PlatformSettings | undefined> {
    const [settings] = await db.select().from(platformSettings).limit(1);
    return settings || undefined;
  }

  async createPlatformSettings(settings: InsertPlatformSettings): Promise<PlatformSettings> {
    const [created] = await db.insert(platformSettings).values(settings).returning();
    return created;
  }

  async updatePlatformSettings(id: string, settings: UpdatePlatformSettings): Promise<PlatformSettings | undefined> {
    const [updated] = await db.update(platformSettings).set(settings).where(eq(platformSettings.id, id)).returning();
    return updated || undefined;
  }

  async getAgentsNeedingWaitTimeReset(): Promise<AgentConfiguration[]> {
    const now = new Date();
    return await db
      .select()
      .from(agentConfigurations)
      .where(
        and(
          sql`${agentConfigurations.resetWaitTimeAt} IS NOT NULL`,
          sql`${agentConfigurations.resetWaitTimeAt} <= ${now}`
        )
      );
  }

  async createMenuOverride(override: InsertMenuOverride): Promise<MenuOverride> {
    const [created] = await db.insert(menuOverrides).values(override).returning();
    return created;
  }

  async getActiveOverridesByAgentId(agentConfigurationId: string): Promise<Array<MenuOverride & { modifiedByName: string }>> {
    const result = await db
      .select({
        id: menuOverrides.id,
        agentConfigurationId: menuOverrides.agentConfigurationId,
        content: menuOverrides.content,
        resetAt: menuOverrides.resetAt,
        status: menuOverrides.status,
        lastModifiedBy: menuOverrides.lastModifiedBy,
        lastModifiedAt: menuOverrides.lastModifiedAt,
        createdAt: menuOverrides.createdAt,
        modifiedByName: sql<string>`${users.firstName} || ' ' || ${users.lastName}`.as('modifiedByName'),
      })
      .from(menuOverrides)
      .leftJoin(users, eq(menuOverrides.lastModifiedBy, users.id))
      .where(
        and(
          eq(menuOverrides.agentConfigurationId, agentConfigurationId),
          eq(menuOverrides.status, 'active')
        )
      )
      .orderBy(desc(menuOverrides.createdAt));
    
    return result;
  }

  async getMenuOverrideById(id: string): Promise<MenuOverride | undefined> {
    const [override] = await db.select().from(menuOverrides).where(eq(menuOverrides.id, id));
    return override || undefined;
  }

  async updateMenuOverride(id: string, content: string, resetAt: Date | null, lastModifiedBy: string): Promise<MenuOverride | undefined> {
    const [updated] = await db
      .update(menuOverrides)
      .set({ 
        content, 
        resetAt, 
        lastModifiedBy, 
        lastModifiedAt: new Date() 
      })
      .where(eq(menuOverrides.id, id))
      .returning();
    return updated || undefined;
  }

  async softDeleteMenuOverride(id: string): Promise<boolean> {
    const result = await db
      .update(menuOverrides)
      .set({ status: 'deleted' })
      .where(eq(menuOverrides.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async getOverridesNeedingAutoDelete(): Promise<MenuOverride[]> {
    const now = new Date();
    return await db
      .select()
      .from(menuOverrides)
      .where(
        and(
          eq(menuOverrides.status, 'active'),
          sql`${menuOverrides.resetAt} IS NOT NULL`,
          sql`${menuOverrides.resetAt} <= ${now}`
        )
      );
  }
}

export const storage = new DatabaseStorage();
