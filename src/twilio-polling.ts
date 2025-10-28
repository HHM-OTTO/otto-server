import twilio from 'twilio';
import { storage } from './storage';

// Initialize Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export class TwilioPollingService {
  /**
   * Poll Twilio for status updates on in-progress calls older than specified minutes
   * @param ageMinutes - Minimum age in minutes for calls to poll (default: 15)
   * @returns Number of calls updated
   */
  static async pollStaleInProgressCalls(ageMinutes: number = 15): Promise<number> {
    console.log(`Polling Twilio for in-progress calls older than ${ageMinutes} minutes...`);
    
    try {
      // Get in-progress calls older than the specified time
      const staleCalls = await storage.getInProgressCallsOlderThan(ageMinutes);
      
      if (staleCalls.length === 0) {
        console.log('No stale in-progress calls found');
        return 0;
      }

      console.log(`Found ${staleCalls.length} stale in-progress calls to check`);
      let updatedCount = 0;

      // Check each call with Twilio
      for (const callLog of staleCalls) {
        if (!callLog.twilioCallSid) {
          console.log(`Skipping call ${callLog.id} - no Twilio CallSid available`);
          continue;
        }

        try {
          // Fetch call status from Twilio
          const twilioCall = await twilioClient.calls(callLog.twilioCallSid).fetch();
          
          console.log(`Twilio call ${callLog.twilioCallSid} status: ${twilioCall.status}`);

          // Update call log if status has changed
          if (this.shouldUpdateCallStatus(callLog.status, twilioCall.status)) {
            const updates: any = {
              lastPolledAt: new Date(),
            };

            // Map Twilio status to our status
            if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(twilioCall.status)) {
              updates.status = twilioCall.status === 'completed' ? 'completed' : 'failed';
              
              // Add duration if available and not already set
              if (twilioCall.duration && !callLog.duration) {
                updates.duration = parseInt(twilioCall.duration);
              }
            }

            await storage.updateCallLog(callLog.id, updates);
            updatedCount++;
            console.log(`Updated call ${callLog.id} with status: ${updates.status || 'in-progress'}`);
          } else {
            // Just update the poll timestamp even if status didn't change
            await storage.updateCallLog(callLog.id, {
              lastPolledAt: new Date(),
            });
            console.log(`Polled call ${callLog.id} - status unchanged: ${twilioCall.status}`);
          }

        } catch (error: any) {
          console.error(`Error polling Twilio for call ${callLog.twilioCallSid}:`, error.message);
          
          // Update poll timestamp even on error to avoid rapid retries
          await storage.updateCallLog(callLog.id, {
            lastPolledAt: new Date(),
          });
          
          // If call not found, mark as failed
          if (error.status === 404) {
            await storage.updateCallLog(callLog.id, {
              status: 'failed',
              lastPolledAt: new Date(),
            });
            updatedCount++;
            console.log(`Call ${callLog.id} not found in Twilio - marked as failed`);
          }
        }
      }

      console.log(`Polling complete. Updated ${updatedCount} calls.`);
      return updatedCount;

    } catch (error) {
      console.error('Error during Twilio polling:', error);
      throw error;
    }
  }

  /**
   * Determine if call status should be updated based on current and new status
   */
  private static shouldUpdateCallStatus(currentStatus: string, twilioStatus: string): boolean {
    // Always update if Twilio shows call is complete
    if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(twilioStatus)) {
      return currentStatus !== 'completed' && currentStatus !== 'failed';
    }

    // Update from in-progress to other in-progress states if needed
    if (currentStatus === 'in-progress' && ['queued', 'ringing', 'in-progress'].includes(twilioStatus)) {
      return false; // Keep as in-progress for now
    }

    return false;
  }

  /**
   * Get status of a specific call by Twilio CallSid
   */
  static async getCallStatus(twilioCallSid: string): Promise<any> {
    try {
      const twilioCall = await twilioClient.calls(twilioCallSid).fetch();
      return {
        sid: twilioCall.sid,
        status: twilioCall.status,
        duration: twilioCall.duration,
        startTime: twilioCall.startTime,
        endTime: twilioCall.endTime,
        direction: twilioCall.direction,
        from: twilioCall.from,
        to: twilioCall.to,
      };
    } catch (error) {
      console.error(`Error fetching call ${twilioCallSid} from Twilio:`, error);
      throw error;
    }
  }
}