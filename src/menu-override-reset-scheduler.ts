import cron, { ScheduledTask } from 'node-cron';
import { storage } from './storage';
import { db } from './db';
import { menuOverrides } from '@shared/schema';
import { eq, and, isNull, sql } from 'drizzle-orm';

export class MenuOverrideResetScheduler {
  private static task: ScheduledTask | null = null;

  /**
   * Start the cron job to check and auto-delete expired menu overrides every minute
   */
  static start() {
    if (this.task) {
      console.log('Menu override reset scheduler is already running');
      return;
    }

    // Run every minute
    this.task = cron.schedule('* * * * *', async () => {
      await this.checkAndDeleteExpiredOverrides();
    });

    console.log('Menu override reset scheduler started (runs every minute)');
  }

  /**
   * Stop the cron job
   */
  static stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
      console.log('Menu override reset scheduler stopped');
    }
  }

  /**
   * Check for menu overrides that need to be auto-deleted and perform the soft delete
   * Uses conditional update to prevent race conditions when concurrent updates occur
   */
  static async checkAndDeleteExpiredOverrides(): Promise<number> {
    try {
      const overridesToDelete = await storage.getOverridesNeedingAutoDelete();
      
      if (overridesToDelete.length === 0) {
        return 0;
      }

      console.log(`Found ${overridesToDelete.length} menu override(s) needing auto-deletion`);
      let deletedCount = 0;

      for (const override of overridesToDelete) {
        try {
          // Store the original values for logging
          const originalResetAt = override.resetAt;
          const originalStatus = override.status;
          
          // Conditional update: only update if status is still 'active' and resetAt hasn't changed
          // This prevents race conditions when users update/delete overrides while cron is running
          const result = await db
            .update(menuOverrides)
            .set({
              status: 'deleted',
            })
            .where(
              and(
                eq(menuOverrides.id, override.id),
                eq(menuOverrides.status, originalStatus),
                originalResetAt 
                  ? eq(menuOverrides.resetAt, originalResetAt)
                  : sql`${menuOverrides.resetAt} IS NULL`
              )
            )
            .returning();

          if (result.length > 0) {
            console.log(
              `Auto-deleted menu override ${override.id} for agent ${override.agentConfigurationId} (was scheduled for ${originalResetAt})`
            );
            deletedCount++;
          } else {
            console.log(
              `Override ${override.id} deletion was skipped - status or resetAt was modified concurrently`
            );
          }
        } catch (error: any) {
          console.error(`Error deleting menu override ${override.id}:`, error.message);
        }
      }

      return deletedCount;
    } catch (error: any) {
      console.error('Error in menu override reset scheduler:', error.message);
      return 0;
    }
  }
}
