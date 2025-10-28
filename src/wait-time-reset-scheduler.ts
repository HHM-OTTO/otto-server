import cron, { ScheduledTask } from 'node-cron';
import { storage } from './storage';
import { db } from './db';
import { agentConfigurations } from '@shared/schema';
import { eq, and, lte, sql } from 'drizzle-orm';

export class WaitTimeResetScheduler {
  private static task: ScheduledTask | null = null;

  /**
   * Start the cron job to check and reset wait times every minute
   */
  static start() {
    if (this.task) {
      console.log('Wait time reset scheduler is already running');
      return;
    }

    // Run every minute
    this.task = cron.schedule('* * * * *', async () => {
      await this.checkAndResetWaitTimes();
    });

    console.log('Wait time reset scheduler started (runs every minute)');
  }

  /**
   * Stop the cron job
   */
  static stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
      console.log('Wait time reset scheduler stopped');
    }
  }

  /**
   * Check for agents that need their wait time reset and perform the reset
   * Uses conditional update to prevent race conditions when concurrent updates occur
   */
  static async checkAndResetWaitTimes(): Promise<number> {
    try {
      const agentsToReset = await storage.getAgentsNeedingWaitTimeReset();
      
      if (agentsToReset.length === 0) {
        return 0;
      }

      console.log(`Found ${agentsToReset.length} agent(s) needing wait time reset`);
      let resetCount = 0;

      for (const agent of agentsToReset) {
        try {
          // Store the original values for logging
          const originalWaitTime = agent.waitTimeMinutes;
          const originalResetTime = agent.resetWaitTimeAt;
          
          // Conditional update: only update if resetWaitTimeAt hasn't changed
          // This prevents race conditions when users update resetWaitTimeAt while cron is running
          const result = await db
            .update(agentConfigurations)
            .set({
              waitTimeMinutes: agent.defaultWaitTimeMinutes,
              resetWaitTimeAt: null,
            })
            .where(
              and(
                eq(agentConfigurations.id, agent.id),
                originalResetTime 
                  ? eq(agentConfigurations.resetWaitTimeAt, originalResetTime)
                  : sql`${agentConfigurations.resetWaitTimeAt} IS NULL`
              )
            )
            .returning();

          if (result.length > 0) {
            console.log(
              `Reset wait time for agent ${agent.id}: ${originalWaitTime} → ${agent.defaultWaitTimeMinutes} minutes (was scheduled for ${originalResetTime})`
            );
            resetCount++;
          } else {
            console.log(
              `Agent ${agent.id} reset was skipped - resetWaitTimeAt was modified concurrently`
            );
          }
        } catch (error: any) {
          console.error(`Error resetting wait time for agent ${agent.id}:`, error.message);
        }
      }

      return resetCount;
    } catch (error: any) {
      console.error('Error in wait time reset scheduler:', error.message);
      return 0;
    }
  }
}
