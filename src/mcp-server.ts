import { z } from "zod";
import type { Request, Response } from "express";
import { storage } from "./storage";

// MCP Protocol Configuration
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "otto-admin-mcp";
const SERVER_VERSION = "1.0.0";

// Define input schemas for MCP tools
const getAgentDetailsSchema = z.object({
  agentId: z.string(),
});

const updateWaitTimeSchema = z.object({
  agentId: z.string(),
  waitTimeMinutes: z.number().min(0).max(120),
  resetWaitTimeAt: z.string().optional(), // ISO 8601 timestamp
});

const updateMenuOverridesSchema = z.object({
  agentId: z.string(),
  content: z.string(),
  resetAt: z.string().optional(), // ISO 8601 timestamp for auto-delete
});

const getOverridesSchema = z.object({
  agentId: z.string(),
});

const updateAgentModeSchema = z.object({
  agentId: z.string(),
  mode: z.enum(["agent", "forward", "offline"]),
});

const updateForwardingPhoneSchema = z.object({
  agentId: z.string(),
  phoneNumber: z.string(),
});

const updateSkillsWorkflowsSchema = z.object({
  agentId: z.string(),
  skillWorkflowIds: z.array(z.string()),
});

// Main MCP JSON-RPC 2.0 handler
export async function handleMCPConnection(req: Request, res: Response) {
  // Validate API key
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace("Bearer ", "");
  
  if (!token || token !== process.env.MCP_SERVER_API_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }

  const { jsonrpc, method, params, id } = req.body;
  const safeParams = params || {};

  // Validate JSON-RPC version
  if (jsonrpc !== "2.0") {
    return res.json({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32600,
        message: "Invalid Request - only JSON-RPC 2.0 supported",
      },
    });
  }

  try {
    switch (method) {
      case "initialize":
        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: SERVER_NAME,
              version: SERVER_VERSION,
            },
          },
        });

      case "initialized":
        // Notification - no response needed
        return res.status(200).end();

      case "tools/list":
        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "list_agents",
                description: "List all restaurant phone agents with their IDs and names",
                inputSchema: {
                  type: "object",
                  properties: {},
                },
              },
              {
                name: "get_agent_details",
                description: "Get complete details of a specific agent including configuration, assigned skills, and current settings",
                inputSchema: {
                  type: "object",
                  properties: {
                    agentId: {
                      type: "string",
                      description: "The unique identifier of the agent",
                    },
                  },
                  required: ["agentId"],
                },
              },
              {
                name: "update_wait_time",
                description: "Update the current wait time for an agent and optionally schedule when it should reset to default. Use this to temporarily adjust wait times with automatic resets.",
                inputSchema: {
                  type: "object",
                  properties: {
                    agentId: {
                      type: "string",
                      description: "The unique identifier of the agent",
                    },
                    waitTimeMinutes: {
                      type: "number",
                      description: "Current wait time in minutes (0-120)",
                      minimum: 0,
                      maximum: 120,
                    },
                    resetWaitTimeAt: {
                      type: "string",
                      description: "Optional ISO 8601 timestamp when wait time should reset to default (e.g., '2025-10-17T15:30:00Z'). Omit to keep current wait time indefinitely.",
                    },
                  },
                  required: ["agentId", "waitTimeMinutes"],
                },
              },
              {
                name: "get_overrides",
                description: "Get all active menu overrides for an agent",
                inputSchema: {
                  type: "object",
                  properties: {
                    agentId: {
                      type: "string",
                      description: "The unique identifier of the agent",
                    },
                  },
                  required: ["agentId"],
                },
              },
              {
                name: "update_menu_overrides",
                description: "Add a temporary menu override for an agent (e.g., items out of stock, daily specials) with optional auto-delete scheduling",
                inputSchema: {
                  type: "object",
                  properties: {
                    agentId: {
                      type: "string",
                      description: "The unique identifier of the agent",
                    },
                    content: {
                      type: "string",
                      description: "Menu override content in markdown format",
                    },
                    resetAt: {
                      type: "string",
                      description: "Optional ISO 8601 timestamp when override should be automatically deleted (e.g., '2025-10-17T15:30:00Z'). Omit to keep indefinitely.",
                    },
                  },
                  required: ["agentId", "content"],
                },
              },
              {
                name: "update_agent_mode",
                description: "Change the operating mode of an agent (agent: AI-powered, forward: redirect to phone, offline: unavailable)",
                inputSchema: {
                  type: "object",
                  properties: {
                    agentId: {
                      type: "string",
                      description: "The unique identifier of the agent",
                    },
                    mode: {
                      type: "string",
                      enum: ["agent", "forward", "offline"],
                      description: "Agent mode: 'agent' (AI-powered), 'forward' (redirect to phone number), or 'offline' (unavailable)",
                    },
                  },
                  required: ["agentId", "mode"],
                },
              },
              {
                name: "update_forwarding_phone",
                description: "Set the phone number to forward calls to when agent is in 'forward' mode",
                inputSchema: {
                  type: "object",
                  properties: {
                    agentId: {
                      type: "string",
                      description: "The unique identifier of the agent",
                    },
                    phoneNumber: {
                      type: "string",
                      description: "Phone number to forward calls to (E.164 format, e.g., +12025551234)",
                    },
                  },
                  required: ["agentId", "phoneNumber"],
                },
              },
              {
                name: "list_skills_workflows",
                description: "List all available skills and workflows that can be assigned to agents",
                inputSchema: {
                  type: "object",
                  properties: {},
                },
              },
              {
                name: "update_skills_workflows",
                description: "Update the skills and workflows assigned to an agent",
                inputSchema: {
                  type: "object",
                  properties: {
                    agentId: {
                      type: "string",
                      description: "The unique identifier of the agent",
                    },
                    skillWorkflowIds: {
                      type: "array",
                      items: {
                        type: "string",
                      },
                      description: "Array of skill/workflow IDs to assign to the agent",
                    },
                  },
                  required: ["agentId", "skillWorkflowIds"],
                },
              },
            ],
          },
        });

      case "tools/call":
        return await handleToolCall(req, res, safeParams, id);

      case "ping":
        return res.json({
          jsonrpc: "2.0",
          id,
          result: {},
        });

      default:
        return res.json({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: "Method not found",
          },
        });
    }
  } catch (error: any) {
    console.error("MCP error:", error);
    return res.json({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: "Internal error",
        data: error.message,
      },
    });
  }
}

// Handle tool execution
async function handleToolCall(req: Request, res: Response, params: any, id: any) {
  const { name, arguments: args } = params;

  try {
    switch (name) {
      case "list_agents": {
        const agents = await storage.getAllAgentConfigurations();
        const agentsList = await Promise.all(
          agents.map(async (agent) => {
            const restaurant = await storage.getRestaurant(agent.restaurantId);
            return {
              id: agent.id,
              name: restaurant?.name || "Unknown Restaurant",
            };
          })
        );
        
        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(agentsList, null, 2),
              },
            ],
          },
        });
      }

      case "get_agent_details": {
        const { agentId } = getAgentDetailsSchema.parse(args);
        const agent = await storage.getAgentConfigurationById(agentId);
        
        if (!agent) {
          return res.json({
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ error: "Agent not found" }),
                },
              ],
              isError: true,
            },
          });
        }

        const restaurant = await storage.getRestaurant(agent.restaurantId);
        const agentSkills = await storage.getAgentSkillsByAgentConfigurationId(agentId);
        
        const skillDetails = agentSkills.map(as => ({
          id: as.skillId,
          name: as.skillName,
          method: as.methodName,
        }));

        const result = {
          id: agent.id,
          restaurantName: restaurant?.name || "Unknown",
          mode: agent.mode,
          waitTimeMinutes: agent.waitTimeMinutes,
          menuOverrides: agent.menuOverrides,
          redirectPhoneNumber: agent.redirectPhoneNumber,
          assignedSkills: skillDetails,
        };

        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          },
        });
      }

      case "update_wait_time": {
        const { agentId, waitTimeMinutes, resetWaitTimeAt } = updateWaitTimeSchema.parse(args);
        
        // Build update object with proper UTC normalization
        const updateData: any = { waitTimeMinutes };
        if (resetWaitTimeAt !== undefined) {
          if (resetWaitTimeAt) {
            // Parse and validate the timestamp
            const resetDate = new Date(resetWaitTimeAt);
            if (isNaN(resetDate.getTime())) {
              throw new Error("Invalid resetWaitTimeAt timestamp");
            }
            // Validate it's a future time
            if (resetDate <= new Date()) {
              throw new Error("resetWaitTimeAt must be a future time");
            }
            // Store as Date object for Drizzle
            updateData.resetWaitTimeAt = resetDate;
          } else {
            updateData.resetWaitTimeAt = null;
          }
        }
        
        await storage.updateAgentConfigurationById(agentId, updateData);
        
        // Get updated agent details to return all wait time related fields
        const agent = await storage.getAgentConfigurationById(agentId);
        const restaurant = await storage.getRestaurant(agent!.restaurantId);
        
        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ 
                  success: true, 
                  agentName: restaurant?.name || "Unknown Agent",
                  waitTimeMinutes: agent!.waitTimeMinutes,
                  defaultWaitTimeMinutes: agent!.defaultWaitTimeMinutes,
                  resetWaitTimeAt: agent!.resetWaitTimeAt || null,
                  message: `Wait time for ${restaurant?.name || "agent"} updated to ${waitTimeMinutes} minutes${resetWaitTimeAt ? ` (will reset at ${new Date(resetWaitTimeAt).toLocaleString()})` : ""}` 
                }),
              },
            ],
          },
        });
      }

      case "get_overrides": {
        const { agentId } = getOverridesSchema.parse(args);
        const overrides = await storage.getActiveOverridesByAgentId(agentId);
        
        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  overrides: overrides.map(o => ({
                    id: o.id,
                    content: o.content,
                    resetAt: o.resetAt,
                    lastModifiedBy: o.modifiedByName,
                    lastModifiedAt: o.lastModifiedAt,
                  })),
                }),
              },
            ],
          },
        });
      }

      case "update_menu_overrides": {
        const { agentId, content, resetAt } = updateMenuOverridesSchema.parse(args);
        
        // Normalize resetAt to Date if provided
        const normalizedResetAt = resetAt ? new Date(resetAt) : null;
        
        // Get current user (MCP operations are done as the admin)
        const mcpUser = await storage.getUserByEmail("admin@otto.com");
        if (!mcpUser) {
          throw new Error("MCP admin user not found");
        }
        
        // Create the override
        const override = await storage.createMenuOverride({
          agentConfigurationId: agentId,
          content,
          resetAt: normalizedResetAt,
          lastModifiedBy: mcpUser.id,
          status: 'active',
        });
        
        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  overrideId: override.id,
                  resetAt: override.resetAt,
                  message: "Menu override created successfully",
                }),
              },
            ],
          },
        });
      }

      case "update_agent_mode": {
        const { agentId, mode } = updateAgentModeSchema.parse(args);
        await storage.updateAgentConfigurationById(agentId, { mode });
        
        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ success: true, message: `Agent mode changed to ${mode}` }),
              },
            ],
          },
        });
      }

      case "update_forwarding_phone": {
        const { agentId, phoneNumber } = updateForwardingPhoneSchema.parse(args);
        await storage.updateAgentConfigurationById(agentId, { redirectPhoneNumber: phoneNumber });
        
        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ success: true, message: `Forwarding phone updated to ${phoneNumber}` }),
              },
            ],
          },
        });
      }

      case "list_skills_workflows": {
        const skills = await storage.getAllSkills();
        const skillsList = skills.map(skill => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          status: skill.status,
        }));
        
        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(skillsList, null, 2),
              },
            ],
          },
        });
      }

      case "update_skills_workflows": {
        const { agentId, skillWorkflowIds } = updateSkillsWorkflowsSchema.parse(args);
        
        // Get existing agent skills
        const existingSkills = await storage.getAgentSkillsByAgentConfigurationId(agentId);
        
        // Remove skills not in the new list
        for (const existing of existingSkills) {
          if (!skillWorkflowIds.includes(existing.skillId)) {
            await storage.deleteAgentSkill(existing.id);
          }
        }
        
        // Add new skills
        for (const skillId of skillWorkflowIds) {
          const exists = existingSkills.find(s => s.skillId === skillId);
          if (!exists) {
            // Get the first method for this skill
            const methods = await storage.getMethodsBySkillId(skillId);
            if (methods.length === 0) {
              continue; // Skip if no methods available
            }
            
            await storage.createAgentSkill({
              agentConfigurationId: agentId,
              skillId: skillId,
              methodId: methods[0].id,
            });
          }
        }
        
        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ success: true, message: "Skills and workflows updated successfully" }),
              },
            ],
          },
        });
      }

      default:
        return res.json({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Unknown tool: ${name}`,
          },
        });
    }
  } catch (error: any) {
    console.error("Tool execution error:", error);
    
    // Return validation errors as -32602 (Invalid params)
    if (error.name === "ZodError") {
      return res.json({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: "Invalid params",
          data: error.errors,
        },
      });
    }
    
    // Return other errors as tool results (visible to LLM)
    return res.json({
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: error.message || "Tool execution failed" }),
          },
        ],
        isError: true,
      },
    });
  }
}
