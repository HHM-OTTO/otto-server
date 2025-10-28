import Stripe from "stripe";
import { db } from "./db";
import { 
  users, 
  paymentMethods, 
  invoices, 
  usageRecords,
  subscriptionPrices,
  platformSettings,
  type User,
  type SubscriptionPrice
} from "@shared/schema";
import { eq, and, gte, lte, sql, inArray } from "drizzle-orm";

// Use production keys in production deployment, testing keys in development
const isProduction = process.env.REPLIT_DEPLOYMENT === '1';
const STRIPE_KEY = isProduction 
  ? process.env.STRIPE_SECRET_KEY 
  : (process.env.TESTING_STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY);

if (!STRIPE_KEY) {
  throw new Error("Missing required Stripe secret key");
}

const stripe = new Stripe(STRIPE_KEY, {
  apiVersion: "2025-09-30.clover",
});

// Helper function to get the correct base URL for redirects
function getBaseUrl(): string {
  if (isProduction) {
    // In production, use admin.callotto.ai domain
    return 'https://admin.callotto.ai';
  } else {
    // In development, use REPLIT_DEV_DOMAIN
    if (process.env.REPLIT_DEV_DOMAIN) {
      return `https://${process.env.REPLIT_DEV_DOMAIN}`;
    }
  }
  // Fallback to localhost for local development
  const port = process.env.PORT || '5001';
  return `http://localhost:${port}`;
}

// Helper function to send webhook notification for new user subscription
async function sendNewUserWebhook(user: { name: string; email: string }, plan: string): Promise<void> {
  try {
    // Fetch the webhook URL from platform settings
    const [settings] = await db.select().from(platformSettings).limit(1);
    
    if (!settings?.newUserNotificationWebhook) {
      console.log('No new user notification webhook configured, skipping notification');
      return;
    }

    const webhookUrl = settings.newUserNotificationWebhook;
    
    // Send webhook notification
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: user.name,
        email: user.email,
        plan: plan,
        timestamp: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      console.error('Failed to send new user webhook notification', {
        webhookUrl,
        status: response.status,
        statusText: response.statusText,
      });
    } else {
      console.log('Successfully sent new user webhook notification', {
        webhookUrl,
        userEmail: user.email,
        plan,
      });
    }
  } catch (error) {
    // Log error but don't throw - webhook failures shouldn't break subscription process
    console.error('Error sending new user webhook notification', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// Plan configurations
export const PLAN_CONFIG = {
  starter: {
    name: "Starter",
    monthlyPrice: 0,
    includedCalls: 20,
    includedMinutes: 0,
    perCallOverage: 100, // $1.00 per call after 20 free
    perMinuteOverage: null,
    features: {
      sms: false,
      coreAI: true,
      kds: true,
      printer: false,
      callTranscripts: false,
      languages: 1,
      advancedAI: false,
      customerMemory: false,
      analytics: null,
      support: null,
    },
  },
  growth: {
    name: "Growth",
    monthlyPrice: 29900, // $299 in cents
    includedCalls: null,
    includedMinutes: 750,
    perCallOverage: null,
    perMinuteOverage: 27, // $0.27 per extra minute
    features: {
      sms: true,
      coreAI: true,
      kds: true,
      printer: true,
      callTranscripts: true,
      languages: 3,
      advancedAI: false,
      customerMemory: false,
      analytics: "basic",
      support: null,
    },
  },
  pro: {
    name: "Pro",
    monthlyPrice: 59900, // $599 in cents
    includedCalls: null,
    includedMinutes: 1800,
    perCallOverage: null,
    perMinuteOverage: 25, // $0.25 per extra minute
    features: {
      sms: true,
      coreAI: true,
      kds: true,
      printer: true,
      callTranscripts: true,
      languages: 10,
      advancedAI: true,
      customerMemory: true,
      analytics: "advanced",
      support: "priority",
    },
  },
  unlimited: {
    name: "Unlimited",
    monthlyPrice: 99900, // $999 in cents
    includedCalls: null,
    includedMinutes: null, // Truly unlimited
    perCallOverage: null,
    perMinuteOverage: null,
    features: {
      sms: true,
      coreAI: true,
      kds: true,
      printer: true,
      callTranscripts: true,
      languages: -1, // Unlimited
      advancedAI: true,
      customerMemory: true,
      analytics: "advanced_plus",
      support: "sla",
    },
  },
};

export class StripeService {
  // Create or get customer
  async getOrCreateCustomer(user: User): Promise<string> {
    if (user.stripeCustomerId) {
      return user.stripeCustomerId;
    }

    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name,
      metadata: {
        userId: user.id,
        firebaseUid: user.firebaseUid,
      },
    });

    // Update user with Stripe customer ID
    await db
      .update(users)
      .set({ stripeCustomerId: customer.id })
      .where(eq(users.id, user.id));

    return customer.id;
  }

  // Create Stripe Checkout session for subscription
  async createCheckoutSession(
    userId: string,
    plan: "starter" | "growth" | "pro" | "unlimited",
    context: "signup" | "billing" = "signup"
  ) {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new Error("User not found");

    const customerId = await this.getOrCreateCustomer(user);
    
    // Get the price IDs for the plan (capitalize first letter to match database)
    const planName = plan.charAt(0).toUpperCase() + plan.slice(1);
    const [priceConfig] = await db
      .select()
      .from(subscriptionPrices)
      .where(eq(subscriptionPrices.plan, planName as any));
    
    if (!priceConfig) {
      throw new Error(`Price configuration not found for plan: ${plan}. Please configure Stripe price IDs.`);
    }

    // Create line items for the subscription
    const lineItems: any[] = [
      {
        price: priceConfig.stripePriceId,
        quantity: 1,
      }
    ];
    
    // Add metered price if applicable (without quantity for metered items)
    if (priceConfig.stripeMeteredPriceId) {
      lineItems.push({
        price: priceConfig.stripeMeteredPriceId,
        // No quantity for metered prices
      });
    }

    // Create checkout session with context-aware URLs
    const baseUrl = getBaseUrl();
    const successUrl = context === "billing" 
      ? `${baseUrl}/billing?session_id={CHECKOUT_SESSION_ID}` 
      : `${baseUrl}/signup-success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = context === "billing" 
      ? `${baseUrl}/billing` 
      : `${baseUrl}/signup`;
    
    const sessionParams = {
      customer: customerId,
      line_items: lineItems,
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      metadata: {
        userId,
        plan,
      },
      subscription_data: {
        metadata: {
          userId,
          plan,
        },
      },
    };

    console.log('[Stripe Checkout] Creating session with params:', JSON.stringify({
      ...sessionParams,
      line_items: lineItems.map(item => ({ price: item.price, quantity: item.quantity })),
      allow_promotion_codes: sessionParams.allow_promotion_codes,
      mode: sessionParams.mode
    }, null, 2));

    const session = await stripe.checkout.sessions.create(sessionParams as any);

    console.log('[Stripe Checkout] Session created:', {
      id: session.id,
      url: session.url,
      allow_promotion_codes: session.allow_promotion_codes,
      mode: session.mode,
      customer: session.customer
    });

    return {
      url: session.url,
      sessionId: session.id,
    };
  }

  // Create billing portal session for customer to manage subscription and view invoices
  async createBillingPortalSession(userId: string) {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user || !user.stripeCustomerId) {
      throw new Error("No customer found for this user");
    }

    const baseUrl = getBaseUrl();
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${baseUrl}/billing`,
    });

    return {
      url: session.url,
    };
  }

  // Process checkout session and update user subscription data
  async processCheckoutSession(sessionId: string, authenticatedFirebaseUid?: string) {
    // Retrieve the checkout session from Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription', 'subscription.default_payment_method'],
    });

    if (!session.subscription) {
      throw new Error('No subscription found in checkout session');
    }

    const subscription = typeof session.subscription === 'string' 
      ? await stripe.subscriptions.retrieve(session.subscription)
      : session.subscription;

    // Get the userId from Stripe metadata (the source of truth)
    const userIdFromMetadata = subscription.metadata?.userId || session.metadata?.userId;
    if (!userIdFromMetadata) {
      console.error('No userId in checkout session metadata', {
        sessionId: session.id,
        subscriptionId: subscription.id,
        sessionMetadata: session.metadata,
        subscriptionMetadata: subscription.metadata
      });
      throw new Error('No userId found in checkout session metadata');
    }

    // Get the user from database
    const [user] = await db.select().from(users).where(eq(users.id, userIdFromMetadata));
    if (!user) {
      console.error('User not found for checkout session', {
        userIdFromMetadata,
        sessionId: session.id
      });
      throw new Error('User not found');
    }

    console.log('Processing checkout session', {
      sessionId: session.id,
      userId: user.id,
      userEmail: user.email,
      userFirebaseUid: user.firebaseUid,
      authenticatedFirebaseUid: authenticatedFirebaseUid,
      customerId: subscription.customer
    });

    // Security check: if Firebase auth is provided, verify it matches the user
    // However, allow signup flows where the user doesn't have a subscription yet
    const isNewSignup = !user.stripeSubscriptionId;
    
    if (authenticatedFirebaseUid && user.firebaseUid !== authenticatedFirebaseUid) {
      if (isNewSignup) {
        // For new signups, log warning but allow (Firebase auth might not be stable during redirect)
        console.warn('Firebase UID mismatch during new signup - allowing', {
          authenticatedUid: authenticatedFirebaseUid,
          userFirebaseUid: user.firebaseUid,
          userId: user.id,
          userEmail: user.email,
          sessionId: session.id,
          subscriptionId: subscription.id,
          note: 'This is a new signup, allowing to complete'
        });
      } else {
        // For existing users, this is a real security violation
        console.error('Security violation: Authenticated Firebase UID does not match user in checkout session', {
          authenticatedUid: authenticatedFirebaseUid,
          userFirebaseUid: user.firebaseUid,
          userId: user.id,
          userEmail: user.email,
          sessionId: session.id,
          subscriptionId: subscription.id,
          hasExistingSubscription: !!user.stripeSubscriptionId
        });
        throw new Error('Authentication mismatch');
      }
    }

    // Defensive check: if the user already has a different Stripe customer, something is wrong
    const customerId = subscription.customer as string;
    if (user.stripeCustomerId && user.stripeCustomerId !== customerId) {
      console.error('Attempted to reassign Stripe customer', {
        userId: user.id,
        existingCustomerId: user.stripeCustomerId,
        newCustomerId: customerId
      });
      throw new Error('Cannot reassign Stripe customer to user');
    }

    // Check if another user already owns this customer ID
    const [existingCustomerUser] = await db
      .select()
      .from(users)
      .where(eq(users.stripeCustomerId, customerId));
    
    if (existingCustomerUser && existingCustomerUser.id !== user.id) {
      console.error('Stripe customer already owned by different user', {
        customerId,
        existingUserId: existingCustomerUser.id,
        attemptedUserId: user.id
      });
      throw new Error('Stripe customer already assigned to another user');
    }

    // Get the plan from metadata
    const plan = (subscription.metadata?.plan || session.metadata?.plan) as any;
    
    // Update user subscription data in database
    await db
      .update(users)
      .set({
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
        subscriptionPlan: plan,
        subscriptionStatus: subscription.status as any,
        billingCycleStart: (subscription as any).current_period_start ? new Date((subscription as any).current_period_start * 1000) : null,
        billingCycleEnd: (subscription as any).current_period_end ? new Date((subscription as any).current_period_end * 1000) : null,
      })
      .where(eq(users.id, user.id));

    // Send webhook notification for new user subscription (non-blocking)
    if (isNewSignup) {
      sendNewUserWebhook(
        { name: user.name, email: user.email },
        plan
      ).catch(error => {
        console.error('Failed to send new user webhook (non-blocking)', error);
      });
    }

    return {
      success: true,
      subscription: {
        id: subscription.id,
        status: subscription.status,
        plan,
      },
    };
  }

  // Update subscription plan
  async updateSubscriptionPlan(
    userId: string,
    newPlan: "starter" | "growth" | "pro" | "unlimited"
  ) {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user || !user.stripeSubscriptionId) {
      throw new Error("User or subscription not found");
    }

    // Get the new price ID (capitalize first letter to match database)
    const planName = newPlan.charAt(0).toUpperCase() + newPlan.slice(1);
    const [newPriceConfig] = await db
      .select()
      .from(subscriptionPrices)
      .where(eq(subscriptionPrices.plan, planName as any));
    
    if (!newPriceConfig) {
      throw new Error(`Price configuration not found for plan: ${newPlan}`);
    }

    // Get current subscription with items
    const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId, {
      expand: ['items'],
    });
    
    // Prepare the new subscription items
    // First, we need to remove all existing items and add the new ones
    const itemsToUpdate: any[] = [];
    
    // Mark all existing items for deletion
    subscription.items.data.forEach((item) => {
      itemsToUpdate.push({
        id: item.id,
        deleted: true,
      });
    });
    
    // Add the new base price
    itemsToUpdate.push({
      price: newPriceConfig.stripePriceId,
      quantity: 1,
    });
    
    // Add the new metered price if applicable
    if (newPriceConfig.stripeMeteredPriceId) {
      itemsToUpdate.push({
        price: newPriceConfig.stripeMeteredPriceId,
        // No quantity for metered items
      });
    }
    
    // Update subscription with new items
    const updatedSubscription = await stripe.subscriptions.update(user.stripeSubscriptionId, {
      items: itemsToUpdate,
      proration_behavior: "always_invoice", // Create prorated charges/credits
      metadata: {
        userId,
        plan: newPlan,
      },
    });

    // Update user record
    await db
      .update(users)
      .set({
        subscriptionPlan: newPlan,
        subscriptionStatus: updatedSubscription.status as any,
      })
      .where(eq(users.id, userId));

    return updatedSubscription;
  }

  // Cancel subscription
  async cancelSubscription(userId: string) {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user || !user.stripeSubscriptionId) {
      throw new Error("User or subscription not found");
    }

    const subscription = await stripe.subscriptions.update(user.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    await db
      .update(users)
      .set({
        subscriptionStatus: "canceled",
      })
      .where(eq(users.id, userId));

    return subscription;
  }

  // Record usage for metered billing
  async recordUsage(
    userId: string,
    restaurantId: string,
    type: "call" | "minute",
    quantity: number
  ) {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new Error("User not found");

    // Create usage record in our database
    await db.insert(usageRecords).values({
      userId,
      restaurantId,
      type,
      quantity,
      billingPeriod: user.billingCycleStart || new Date(),
    });

    // Update monthly usage counters
    if (type === "call") {
      await db
        .update(users)
        .set({
          monthlyCallsUsed: sql`${users.monthlyCallsUsed} + ${quantity}`,
        })
        .where(eq(users.id, userId));
    } else {
      await db
        .update(users)
        .set({
          monthlyMinutesUsed: sql`${users.monthlyMinutesUsed} + ${quantity}`,
        })
        .where(eq(users.id, userId));
    }

    // Report to Stripe if there are overages
    await this.reportOveragesToStripe(userId);
  }

  // Get and sync subscription details from Stripe
  async getAndSyncSubscriptionDetails(userId: string) {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user || !user.stripeSubscriptionId) {
      return null;
    }

    try {
      // Retrieve the subscription from Stripe
      const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
      
      let periodStart: Date;
      let periodEnd: Date;
      
      // Check if it's a flexible billing subscription (usage-based)
      if ((subscription as any).billing_mode?.type === 'flexible') {
        // For flexible billing, use billing_cycle_anchor and calculate monthly period
        const billingCycleAnchor = (subscription as any).billing_cycle_anchor;
        
        if (!billingCycleAnchor) {
          return null;
        }
        
        const anchorDate = new Date(billingCycleAnchor * 1000);
        const now = new Date();
        
        // Calculate current billing period based on anchor date
        // Find the most recent billing period start
        periodStart = new Date(anchorDate);
        while (periodStart < now) {
          const nextMonth = new Date(periodStart);
          nextMonth.setMonth(nextMonth.getMonth() + 1);
          if (nextMonth > now) {
            break;
          }
          periodStart = nextMonth;
        }
        
        // Period end is one month after period start
        periodEnd = new Date(periodStart);
        periodEnd.setMonth(periodEnd.getMonth() + 1);
      } else {
        // Standard subscription with current_period_start and current_period_end
        const currentPeriodStart = (subscription as any).current_period_start;
        const currentPeriodEnd = (subscription as any).current_period_end;
        
        if (!currentPeriodStart || !currentPeriodEnd) {
          return null;
        }
        
        periodStart = new Date(currentPeriodStart * 1000);
        periodEnd = new Date(currentPeriodEnd * 1000);
      }
      
      // Update the user record with current billing period dates
      await db
        .update(users)
        .set({
          billingCycleStart: periodStart,
          billingCycleEnd: periodEnd,
          subscriptionStatus: subscription.status as any,
        })
        .where(eq(users.id, userId));

      return {
        subscription,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        status: subscription.status,
      };
    } catch (error) {
      console.error('Failed to sync subscription details:', error);
      return null;
    }
  }

  // Report usage overages to Stripe
  async reportOveragesToStripe(userId: string) {
    try {
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      if (!user || !user.stripeSubscriptionId || !user.subscriptionPlan) return;

      // Get plan configuration from database (capitalize first letter to match database)
      const planName = user.subscriptionPlan.charAt(0).toUpperCase() + user.subscriptionPlan.slice(1);
      const [priceConfig] = await db
        .select()
        .from(subscriptionPrices)
        .where(eq(subscriptionPrices.plan, planName as any));

      if (!priceConfig) return;
    
    // Calculate overages based on plan limits from database
    let overageQuantity = 0;
    let overageType: "call" | "minute" | null = null;

    if (user.subscriptionPlan === "starter") {
      // Starter: charge per call after included calls
      const callsOverage = Math.max(0, (user.monthlyCallsUsed || 0) - (priceConfig.includedCalls || 0));
      if (callsOverage > 0) {
        overageQuantity = callsOverage;
        overageType = "call";
      }
    } else if (user.subscriptionPlan === "growth" || user.subscriptionPlan === "pro") {
      // Growth/Pro: charge per minute after included minutes
      const minutesOverage = Math.max(0, (user.monthlyMinutesUsed || 0) - (priceConfig.includedMinutes || 0));
      if (minutesOverage > 0) {
        overageQuantity = minutesOverage;
        overageType = "minute";
      }
    }
    // Unlimited plan has no overages

    if (overageType && overageQuantity > 0) {
      console.log(`Overage detected for user ${userId}: ${overageQuantity} ${overageType}(s) over plan limit`);
      
      // Get unreported usage records (filter by reportedToStripe only, not billing cycle)
      const unreportedRecords = await db
        .select()
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.userId, userId),
            eq(usageRecords.type, overageType),
            eq(usageRecords.reportedToStripe, false)
          )
        );

      console.log(`Found ${unreportedRecords.length} unreported ${overageType} records for user ${userId}`);

      if (unreportedRecords.length === 0) {
        console.log(`No unreported records found for user ${userId}`);
        return;
      }

      if (!priceConfig?.stripeMeteredPriceId) {
        console.log(`No metered price ID found for plan ${user.subscriptionPlan}`);
        return;
      }

      // Get subscription item for metered billing
      const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId, {
        expand: ["items"],
      });

      const meteredItem = subscription.items.data.find(
        item => item.price.id === priceConfig.stripeMeteredPriceId
      );

      if (!meteredItem) return;

      // Report usage to Stripe  
      const totalQuantity = unreportedRecords.reduce((sum, record) => sum + record.quantity, 0);
      
      console.log(`Sending ${totalQuantity} ${overageType}(s) to Stripe for user ${userId} (customer: ${user.stripeCustomerId})`);
      
      // Using the correct API method for usage records
      try {
        const usageRecord = await stripe.billing.meterEvents.create({
          event_name: overageType === "call" ? "otto_calls" : "otto_minutes",
          payload: {
            value: String(totalQuantity),
            stripe_customer_id: user.stripeCustomerId!,
          },
          identifier: `${userId}_${Date.now()}`,
        });

        console.log(`Successfully sent meter event to Stripe: ${JSON.stringify(usageRecord)}`);

        // Mark records as reported
        const recordIds = unreportedRecords.map(r => r.id);
        const meterEventData = usageRecord as any;
        await db
          .update(usageRecords)
          .set({
            reportedToStripe: true,
            stripeUsageRecordId: meterEventData.id || meterEventData.identifier,
          })
          .where(inArray(usageRecords.id, recordIds));
        
        console.log(`Marked ${recordIds.length} usage records as reported to Stripe`);
      } catch (meterError: any) {
        // Log detailed error information for debugging
        console.error(`[CRITICAL] Failed to send meter event to Stripe for user ${userId}:`, {
          error: meterError.message,
          type: meterError.type,
          code: meterError.code,
          statusCode: meterError.statusCode,
          eventName: overageType === "call" ? "otto_calls" : "otto_minutes",
          customerId: user.stripeCustomerId,
          quantity: totalQuantity,
          isProduction: isProduction ? 'true' : 'false'
        });
        
        // Re-throw to prevent marking as reported
        throw meterError;
      }
    }
    } catch (error) {
      console.error(`[reportOveragesToStripe] Error:`, error);
    }
  }

  // Get payment methods for a user
  async getPaymentMethods(userId: string) {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user || !user.stripeCustomerId) return [];

    const paymentMethodsList = await stripe.paymentMethods.list({
      customer: user.stripeCustomerId,
      type: "card",
    });

    return paymentMethodsList.data;
  }

  // Create a SetupIntent for SCA-compliant payment method collection
  async createSetupIntent(userId: string) {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user || !user.stripeCustomerId) {
      throw new Error("User or customer not found");
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: user.stripeCustomerId,
      payment_method_types: ["card"],
      usage: "off_session",
      metadata: {
        userId,
      },
    });

    return {
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
    };
  }

  // Add a payment method
  async addPaymentMethod(userId: string, paymentMethodId: string, setAsDefault = false) {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user || !user.stripeCustomerId) {
      throw new Error("User or customer not found");
    }

    // Attach payment method to customer
    await stripe.paymentMethods.attach(paymentMethodId, {
      customer: user.stripeCustomerId,
    });

    // Set as default if requested
    if (setAsDefault) {
      await stripe.customers.update(user.stripeCustomerId, {
        invoice_settings: {
          default_payment_method: paymentMethodId,
        },
      });
    }

    // Save to database
    const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
    await db.insert(paymentMethods).values({
      userId,
      stripePaymentMethodId: paymentMethodId,
      type: paymentMethod.type,
      last4: paymentMethod.card?.last4,
      brand: paymentMethod.card?.brand,
      expiryMonth: paymentMethod.card?.exp_month,
      expiryYear: paymentMethod.card?.exp_year,
      isDefault: setAsDefault,
    });

    return paymentMethod;
  }

  // Remove a payment method
  async removePaymentMethod(userId: string, paymentMethodId: string) {
    await stripe.paymentMethods.detach(paymentMethodId);
    await db
      .delete(paymentMethods)
      .where(
        and(
          eq(paymentMethods.userId, userId),
          eq(paymentMethods.stripePaymentMethodId, paymentMethodId)
        )
      );
  }

  // Get invoices for a user
  async getInvoices(userId: string, limit = 10) {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user || !user.stripeCustomerId) return [];

    const invoicesList = await stripe.invoices.list({
      customer: user.stripeCustomerId,
      limit,
    });

    return invoicesList.data;
  }

  // Sync invoice from Stripe to database
  async syncInvoice(stripeInvoice: Stripe.Invoice) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.stripeCustomerId, stripeInvoice.customer as string));
    
    if (!user) return;

    const invoiceData = {
      userId: user.id,
      stripeInvoiceId: stripeInvoice.id,
      invoiceNumber: stripeInvoice.number,
      status: stripeInvoice.status as any,
      amountDue: stripeInvoice.amount_due,
      amountPaid: stripeInvoice.amount_paid,
      currency: stripeInvoice.currency,
      billingPeriodStart: stripeInvoice.period_start 
        ? new Date(stripeInvoice.period_start * 1000) 
        : null,
      billingPeriodEnd: stripeInvoice.period_end 
        ? new Date(stripeInvoice.period_end * 1000) 
        : null,
      pdfUrl: stripeInvoice.invoice_pdf,
      hostedInvoiceUrl: stripeInvoice.hosted_invoice_url,
    };

    // Upsert invoice
    await db
      .insert(invoices)
      .values(invoiceData)
      .onConflictDoUpdate({
        target: invoices.stripeInvoiceId,
        set: invoiceData,
      });
  }

  // Reset monthly usage counters (called by webhook at billing cycle end)
  async resetMonthlyUsage(userId: string) {
    await db
      .update(users)
      .set({
        monthlyCallsUsed: 0,
        monthlyMinutesUsed: 0,
      })
      .where(eq(users.id, userId));
  }
}

export const stripeService = new StripeService();
