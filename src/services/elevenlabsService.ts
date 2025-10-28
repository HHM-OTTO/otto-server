import { storage } from "../storage";
import { CallLog } from "@shared/schema";
import * as fs from "fs";
import * as path from "path";
import { pipeline } from "stream/promises";

class ElevenLabsService {
  private apiKey: string | undefined;

  constructor() {
    this.apiKey = process.env.ELEVENLABS_API_KEY;
  }

  // Retrieve conversation audio from ElevenLabs API and save locally
  async retrieveConversationAudio(callLogId: string, conversationId: string): Promise<{ 
    audioUrl: string | null;
    localAudioPath: string | null;
    fileSize: number | null;
    success: boolean;
    error?: string;
  }> {
    try {
      if (!this.apiKey) {
        console.error("[ElevenLabsService] No API key configured");
        return { audioUrl: null, localAudioPath: null, fileSize: null, success: false, error: "ElevenLabs API key not configured" };
      }

      console.log(`[ElevenLabsService] Retrieving audio for conversation ${conversationId}`);

      // ElevenLabs API endpoint to get conversation details
      const conversationUrl = `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`;
      
      const response = await fetch(conversationUrl, {
        method: 'GET',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[ElevenLabsService] Failed to get conversation: ${response.status} - ${errorText}`);
        return { 
          audioUrl: null, 
          localAudioPath: null,
          fileSize: null, 
          success: false, 
          error: `Failed to retrieve conversation: ${response.status}`
        };
      }

      const conversationData = await response.json();
      
      // Log the conversation data structure to debug field names
      console.log(`[ElevenLabsService] Conversation data keys:`, Object.keys(conversationData));
      console.log(`[ElevenLabsService] Has audio flag:`, conversationData.has_audio);
      
      // Check if conversation has audio
      if (!conversationData.has_audio) {
        console.log(`[ElevenLabsService] Conversation indicates no audio available`);
        return { audioUrl: null, localAudioPath: null, fileSize: null, success: false, error: "Conversation has no audio" };
      }
      
      // Try to get audio URL - ElevenLabs might require a separate call to get signed URL
      let audioUrl = conversationData.audio_url || 
                    conversationData.audio || 
                    conversationData.recording_url || 
                    conversationData.recording ||
                    conversationData.signed_url ||
                    conversationData.download_url ||
                    conversationData.url ||
                    null;
      
      // If no direct audio URL, try to get it from a separate endpoint
      if (!audioUrl && conversationData.has_audio) {
        console.log(`[ElevenLabsService] No direct audio URL found, checking audio endpoint`);
        
        // The audio endpoint URL IS the audio URL - it directly returns the MP3 file
        // We just need to verify it exists with a HEAD request
        const audioEndpoint = `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}/audio`;
        
        // Test if the audio endpoint exists with a HEAD request
        const headResponse = await fetch(audioEndpoint, {
          method: 'HEAD',
          headers: {
            'xi-api-key': this.apiKey
          }
        });
        
        if (headResponse.ok) {
          console.log(`[ElevenLabsService] Audio endpoint exists, using it as audio URL`);
          audioUrl = audioEndpoint;
          
          // Try to get file size from headers
          const contentLength = headResponse.headers.get('content-length');
          if (contentLength) {
            conversationData.audio_file_size = parseInt(contentLength);
            console.log(`[ElevenLabsService] Got file size from HEAD request: ${contentLength} bytes`);
          }
        } else {
          console.log(`[ElevenLabsService] Audio endpoint HEAD request failed: ${headResponse.status}`);
          // Still try to use the endpoint as the URL
          audioUrl = audioEndpoint;
        }
      }
      
      if (!audioUrl) {
        console.log(`[ElevenLabsService] No audio URL found after all attempts`);
        return { audioUrl: null, localAudioPath: null, fileSize: null, success: false, error: "No audio URL found" };
      }

      // Get file size if available (may need separate HEAD request)
      let fileSize = null;
      if (conversationData.audio_file_size) {
        fileSize = conversationData.audio_file_size;
      } else {
        // Try to get file size with HEAD request
        try {
          const headResponse = await fetch(audioUrl, {
            method: 'HEAD',
            headers: {
              'xi-api-key': this.apiKey
            }
          });
          
          if (headResponse.ok) {
            const contentLength = headResponse.headers.get('content-length');
            if (contentLength) {
              fileSize = parseInt(contentLength);
            }
          }
        } catch (error) {
          console.log(`[ElevenLabsService] Could not determine file size: ${error}`);
        }
      }

      // Now download and save the audio file to object storage
      let localAudioPath: string | null = null;
      
      // Get the restaurant ID and agent ID for ACL
      const callLog = await storage.getCallLogById(callLogId);
      if (!callLog) {
        console.error(`[ElevenLabsService] Call log not found: ${callLogId}`);
        return { audioUrl, localAudioPath: null, fileSize, success: false, error: "Call log not found" };
      }

      // Get the agent configuration to set ACL policy
      const agentConfig = await storage.getAgentConfiguration(callLog.restaurantId);
      
      console.log(`[ElevenLabsService] Downloading audio for call ${callLogId}`);
      
      // Download the audio file
      const audioResponse = await fetch(audioUrl, {
        method: 'GET',
        headers: {
          'xi-api-key': this.apiKey
        }
      });
      
      if (!audioResponse.ok) {
        console.error(`[ElevenLabsService] Failed to download audio: ${audioResponse.status}`);
        // Still save the URL even if download failed
        await storage.updateCallLog(callLogId, {
          elevenlabsAudioUrl: audioUrl,
          audioFileSize: fileSize,
          audioRetrievedAt: new Date(),
        });
        return { audioUrl, localAudioPath: null, fileSize, success: false, error: "Failed to download audio" };
      }
      
      // Get actual file size from response if not already known
      if (!fileSize) {
        const contentLength = audioResponse.headers.get('content-length');
        if (contentLength) {
          fileSize = parseInt(contentLength);
        }
      }
      
      // Save the audio file to object storage
      const buffer = Buffer.from(await audioResponse.arrayBuffer());
      
      // Import object storage service
      const { ObjectStorageService } = await import('../objectStorage');
      const objectStorage = new ObjectStorageService();
      
      // Save audio file to object storage with ACL policy
      if (agentConfig) {
        localAudioPath = await objectStorage.saveAudioFile(
          buffer, 
          callLog.restaurantId, 
          callLogId,
          agentConfig.billingUserId, // owner
          agentConfig.id // agent config ID for ACL
        );
        console.log(`[ElevenLabsService] Audio file saved to object storage: ${localAudioPath}`);
      } else {
        console.error(`[ElevenLabsService] No agent config found, cannot save audio with ACL`);
        return { audioUrl, localAudioPath: null, fileSize: fileSize || buffer.length, success: false, error: "No agent config found" };
      }
      
      // Update the call log with both the URL and local path
      await storage.updateCallLog(callLogId, {
        elevenlabsAudioUrl: audioUrl,
        localAudioPath: localAudioPath,
        audioFileSize: fileSize || buffer.length,
        audioRetrievedAt: new Date(),
      });

      console.log(`[ElevenLabsService] Successfully retrieved and saved audio for conversation ${conversationId}`);
      console.log(`[ElevenLabsService] Audio URL: ${audioUrl}`);
      console.log(`[ElevenLabsService] Local path: ${localAudioPath}`);
      console.log(`[ElevenLabsService] File size: ${fileSize || buffer.length} bytes`);

      return { audioUrl, localAudioPath, fileSize: fileSize || buffer.length, success: true };
    } catch (error: any) {
      console.error(`[ElevenLabsService] Error retrieving conversation audio:`, error);
      return { 
        audioUrl: null, 
        localAudioPath: null,
        fileSize: null, 
        success: false, 
        error: error.message 
      };
    }
  }

  // Process conversations that have conversation_id but no audio URL yet
  async processUnretrievedAudio(): Promise<{
    processed: number;
    successful: number;
    failed: number;
  }> {
    try {
      console.log(`[ElevenLabsService] Starting to process unretrieved audio`);
      
      // Get all call logs with conversation_id but no audio URL
      const callLogs = await storage.getAllCallLogs(1000);
      const unprocessed = callLogs.filter(log => 
        log.elevenlabsConversationId && !log.elevenlabsAudioUrl
      );
      
      console.log(`[ElevenLabsService] Found ${unprocessed.length} conversations without audio`);
      
      let successful = 0;
      let failed = 0;
      
      for (const log of unprocessed) {
        if (!log.elevenlabsConversationId) continue;
        
        const result = await this.retrieveConversationAudio(log.id, log.elevenlabsConversationId);
        if (result.success) {
          successful++;
        } else {
          failed++;
        }
        
        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      console.log(`[ElevenLabsService] Processed ${unprocessed.length} conversations`);
      console.log(`[ElevenLabsService] Successful: ${successful}, Failed: ${failed}`);
      
      return {
        processed: unprocessed.length,
        successful,
        failed
      };
    } catch (error) {
      console.error(`[ElevenLabsService] Error processing unretrieved audio:`, error);
      return { processed: 0, successful: 0, failed: 0 };
    }
  }

  // Retrieve audio for a specific call log if needed
  async ensureAudioRetrieved(callLogId: string): Promise<boolean> {
    try {
      const callLog = await storage.getCallLogById(callLogId);
      if (!callLog) {
        console.error(`[ElevenLabsService] Call log not found: ${callLogId}`);
        return false;
      }

      // If already has audio URL, nothing to do
      if (callLog.elevenlabsAudioUrl) {
        return true;
      }

      // If no conversation ID, can't retrieve audio
      if (!callLog.elevenlabsConversationId) {
        console.log(`[ElevenLabsService] No conversation ID for call log: ${callLogId}`);
        return false;
      }

      // Retrieve the audio
      const result = await this.retrieveConversationAudio(callLogId, callLog.elevenlabsConversationId);
      return result.success;
    } catch (error) {
      console.error(`[ElevenLabsService] Error ensuring audio retrieved:`, error);
      return false;
    }
  }

  // Migrate legacy audio and missing audio to object storage
  async migrateAudioToObjectStorage(): Promise<{
    processed: number;
    successful: number;
    failed: number;
  }> {
    try {
      console.log(`[ElevenLabsService] Starting audio migration to object storage`);
      
      // Get all call logs with ElevenLabs conversation IDs
      const callLogs = await storage.getAllCallLogs(1000);
      const needsMigration = callLogs.filter(log => 
        log.elevenlabsConversationId && (
          // Missing audio entirely
          !log.localAudioPath ||
          // Legacy filesystem storage
          log.localAudioPath.startsWith('server/storage/')
        )
      );
      
      console.log(`[ElevenLabsService] Found ${needsMigration.length} recordings to migrate`);
      
      let successful = 0;
      let failed = 0;
      
      for (const log of needsMigration) {
        if (!log.elevenlabsConversationId) continue;
        
        // Re-download and save to object storage
        const result = await this.retrieveConversationAudio(log.id, log.elevenlabsConversationId);
        if (result.success) {
          successful++;
          console.log(`[ElevenLabsService] Migrated audio for call ${log.id}`);
        } else {
          failed++;
          console.error(`[ElevenLabsService] Failed to migrate audio for call ${log.id}`);
        }
        
        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      console.log(`[ElevenLabsService] Migration complete: ${successful} successful, ${failed} failed`);
      
      return {
        processed: needsMigration.length,
        successful,
        failed
      };
    } catch (error) {
      console.error(`[ElevenLabsService] Error migrating audio:`, error);
      return { processed: 0, successful: 0, failed: 0 };
    }
  }
}

// Export singleton instance
export const elevenlabsService = new ElevenLabsService();