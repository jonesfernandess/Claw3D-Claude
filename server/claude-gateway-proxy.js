/**
 * Claude Gateway Proxy
 *
 * Replaces the OpenClaw upstream WebSocket with the Claude Agent SDK.
 * Speaks the same Claw3D frame protocol (req/res/event) so the frontend
 * needs zero changes.
 *
 * Follows the same SDK pattern as ClinkCode:
 *   - Uses `query()` from @anthropic-ai/claude-agent-sdk
 *   - Persistent sessions via `resume: sessionId`
 *   - Streaming responses converted to Claw3D event frames
 */

const { WebSocketServer } = require("ws");
const { ClaudeAgentManager } = require("./claude-agent-manager");

const isObject = (value) => Boolean(value && typeof value === "object");

const safeJsonParse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const resolvePathname = (url) => {
  const raw = typeof url === "string" ? url : "";
  const idx = raw.indexOf("?");
  return (idx === -1 ? raw : raw.slice(0, idx)) || "/";
};

const generateUUID = () => {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

function createClaudeGatewayProxy(options) {
  const {
    agentManager,
    allowWs = (req) => resolvePathname(req.url) === "/api/gateway/ws",
    log = (...args) => console.log("[claude-proxy]", ...args),
    logError = (msg, err) => console.error("[claude-proxy]", msg, err),
  } = options || {};

  const { verifyClient } = options || {};

  if (!agentManager) {
    throw new Error("createClaudeGatewayProxy requires an agentManager instance.");
  }

  const wss = new WebSocketServer({ noServer: true, verifyClient });

  wss.on("connection", (browserWs) => {
    let closed = false;
    let connected = false;
    let connectRequestId = null;

    const closeBrowser = (code, reason) => {
      if (closed) return;
      closed = true;
      try {
        browserWs.close(code, reason);
      } catch {}
    };

    const sendToBrowser = (frame) => {
      if (browserWs.readyState !== 1 /* OPEN */) return;
      try {
        browserWs.send(JSON.stringify(frame));
      } catch (err) {
        logError("Failed to send frame to browser", err);
      }
    };

    const sendResponse = (id, ok, payload, error) => {
      const frame = { type: "res", id, ok };
      if (ok) frame.payload = payload || {};
      else frame.error = error || { code: "unknown", message: "Unknown error" };
      sendToBrowser(frame);
    };

    const sendEvent = (event, payload, seq) => {
      const frame = { type: "event", event, payload };
      if (typeof seq === "number") frame.seq = seq;
      sendToBrowser(frame);
    };

    // ─── Handle connect (first frame must be req/connect) ───
    const handleConnect = (parsed) => {
      connectRequestId = parsed.id;
      connected = true;

      // Send successful connect response in GatewayHelloOk format
      // that the GatewayBrowserClient expects
      sendResponse(parsed.id, true, {
        type: "hello-ok",
        protocol: 3,
        features: {
          methods: [
            "chat.send",
            "chat.history",
            "chat.abort",
            "sessions.patch",
            "config.get",
            "summary.status",
            "summary.preview",
          ],
          events: ["chat", "agent", "presence", "heartbeat"],
        },
        auth: {
          role: "owner",
          scopes: ["*"],
        },
        policy: {
          tickIntervalMs: 30000,
        },
      });

      // Send initial presence event with agent list
      const agents = agentManager.getAgents();
      for (const agent of agents) {
        sendEvent("presence", {
          sessionKey: agent.sessionKey,
          agentId: agent.agentId,
          status: agent.status || "idle",
        });
      }

      // Send heartbeat so the frontend loads agent summaries
      sendEvent("heartbeat", {
        ts: Date.now(),
      });

      log(`Connected. ${agents.length} agents available.`);
    };

    // ─── Handle chat.send ───
    const handleChatSend = async (parsed) => {
      const { sessionKey, message, idempotencyKey } = parsed.params || {};
      const runId = idempotencyKey || generateUUID();

      if (!sessionKey) {
        sendResponse(parsed.id, false, null, {
          code: "missing_session_key",
          message: "sessionKey is required",
        });
        return;
      }

      // Acknowledge the send immediately
      sendResponse(parsed.id, true, {
        status: "started",
        runId,
      });

      // Extract plain text from the message (strip XML tags from buildAgentInstruction)
      const plainMessage = extractPlainMessage(message);

      try {
        // Stream response from Claude Agent SDK
        await agentManager.sendMessage({
          sessionKey,
          message: plainMessage,
          runId,
          onDelta: (text, seq) => {
            sendEvent("chat", {
              runId,
              sessionKey,
              state: "delta",
              seq,
              message: {
                role: "assistant",
                content: text,
              },
            });
          },
          onThinking: (text) => {
            sendEvent("agent", {
              runId,
              sessionKey: sessionKey,
              stream: "thinking",
              data: { text },
            });
          },
          onToolUse: (toolName, toolInput, toolId) => {
            sendEvent("agent", {
              runId,
              sessionKey,
              stream: "tool",
              data: {
                type: "tool_use",
                id: toolId,
                name: toolName,
                input: toolInput,
              },
            });
          },
          onToolResult: (toolId, result) => {
            sendEvent("agent", {
              runId,
              sessionKey,
              stream: "tool",
              data: {
                type: "tool_result",
                tool_use_id: toolId,
                content: result,
              },
            });
          },
          onFinal: (text) => {
            sendEvent("chat", {
              runId,
              sessionKey,
              state: "final",
              message: {
                role: "assistant",
                content: text,
                timestamp: Date.now(),
              },
            });

            // Lifecycle end
            sendEvent("agent", {
              runId,
              sessionKey,
              stream: "lifecycle",
              data: { phase: "end" },
            });
          },
          onError: (errorMessage) => {
            sendEvent("chat", {
              runId,
              sessionKey,
              state: "error",
              errorMessage,
            });

            sendEvent("agent", {
              runId,
              sessionKey,
              stream: "lifecycle",
              data: { phase: "error", message: errorMessage },
            });
          },
          onLifecycleStart: () => {
            sendEvent("agent", {
              runId,
              sessionKey,
              stream: "lifecycle",
              data: { phase: "start" },
            });
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Claude query failed";
        logError(`chat.send error for ${sessionKey}`, err);
        sendEvent("chat", {
          runId,
          sessionKey,
          state: "error",
          errorMessage: msg,
        });
      }
    };

    // ─── Handle chat.history ───
    const handleChatHistory = (parsed) => {
      const { sessionKey, limit } = parsed.params || {};
      const history = agentManager.getHistory(sessionKey, limit || 50);
      sendResponse(parsed.id, true, {
        sessionKey,
        messages: history,
      });
    };

    // ─── Handle chat.abort ───
    const handleChatAbort = (parsed) => {
      const { sessionKey } = parsed.params || {};
      const aborted = agentManager.abortQuery(sessionKey);
      sendResponse(parsed.id, true, { aborted });
    };

    // ─── Handle sessions.patch ───
    const handleSessionsPatch = (parsed) => {
      const { key, model, thinkingLevel, execHost, execSecurity, execAsk } =
        parsed.params || {};
      agentManager.patchSession(key, { model, thinkingLevel, execHost, execSecurity, execAsk });
      sendResponse(parsed.id, true, { patched: true });
    };

    // ─── Handle config.get ───
    const handleConfigGet = (parsed) => {
      const agents = agentManager.getAgents();
      sendResponse(parsed.id, true, {
        config: {
          agents: {
            list: agents.map((a) => ({
              id: a.agentId,
              name: a.name,
              default: a.isDefault || false,
            })),
            defaults: {
              model: "anthropic/claude-haiku-4-5-20251001",
            },
          },
          studio: {
            reloadMode: "hot",
          },
        },
        hash: "claude-local-" + Date.now(),
        exists: true,
      });
    };

    // ─── Handle config.patch ───
    const handleConfigPatch = (parsed) => {
      // Accept but no-op for now
      sendResponse(parsed.id, true, {
        config: {},
        hash: "claude-local-" + Date.now(),
        exists: true,
      });
    };

    // ─── Handle summary.status ───
    const handleSummaryStatus = (parsed) => {
      const agents = agentManager.getAgents();
      const sessions = agents.map((a) => ({
        key: a.sessionKey,
        updatedAt: a.lastActivityAt || Date.now(),
      }));
      sendResponse(parsed.id, true, {
        sessions: { recent: sessions },
      });
    };

    // ─── Handle summary.preview ───
    const handleSummaryPreview = (parsed) => {
      const agents = agentManager.getAgents();
      const previews = agents.map((a) => ({
        key: a.sessionKey,
        status: "ok",
        items: a.lastPreview
          ? [{ role: "assistant", text: a.lastPreview, timestamp: a.lastActivityAt }]
          : [],
      }));
      sendResponse(parsed.id, true, {
        ts: Date.now(),
        previews,
      });
    };

    // ─── Handle agents.list ───
    const handleAgentsList = (parsed) => {
      const agents = agentManager.getAgents();
      const defaultAgent = agents.find((a) => a.isDefault) || agents[0];
      sendResponse(parsed.id, true, {
        defaultId: defaultAgent?.agentId || "aninha",
        mainKey: "main",
        scope: "local",
        agents: agents.map((a) => ({
          id: a.agentId,
          name: a.name,
          identity: {
            name: a.name,
            theme: a.role || "assistant",
          },
        })),
      });
    };

    // ─── Handle sessions.list ───
    const handleSessionsList = (parsed) => {
      const { agentId, search } = parsed.params || {};
      const agents = agentManager.getAgents();
      const agent = agents.find((a) => a.agentId === agentId);
      const sessionKey = search || (agent ? agent.sessionKey : `agent:${agentId}:main`);
      sendResponse(parsed.id, true, {
        sessions: [
          {
            key: sessionKey,
            agentId: agentId,
            createdAt: Date.now(),
            updatedAt: agent?.lastActivityAt || Date.now(),
          },
        ],
      });
    };

    // ─── Handle exec.approvals.get ───
    const handleExecApprovals = (parsed) => {
      sendResponse(parsed.id, true, {
        mode: "full",
        allowlist: [],
      });
    };

    // ─── Handle agents.create ───
    const handleAgentsCreate = (parsed) => {
      const { id, name } = parsed.params || {};
      if (id && name) {
        agentManager.registerAgent({ id, name, role: "Assistant" });
      }
      sendResponse(parsed.id, true, { created: true });
    };

    // ─── Handle heartbeat.list / heartbeat.wake ───
    const handleHeartbeatList = (parsed) => {
      sendResponse(parsed.id, true, { heartbeats: [] });
    };

    const handleHeartbeatWake = (parsed) => {
      sendResponse(parsed.id, true, { ok: true });
    };

    // ─── Handle agents.files.get ───
    const handleAgentsFilesGet = (parsed) => {
      const { agentId, name } = parsed.params || {};
      const agent = agentManager.getAgents().find((a) => a.agentId === agentId);
      if (!agent) {
        sendResponse(parsed.id, true, { file: { missing: true } });
        return;
      }

      // Map agent config to file content
      const fileContent = {
        "SOUL.md": agent.systemPrompt || "",
        "AGENTS.md": `Role: ${agent.role}\nModel: ${agent.model}\nExec: ${agent.sessionExecSecurity || "full"}`,
        "IDENTITY.md": `Name: ${agent.name}\nRole: ${agent.role}`,
        "USER.md": "",
        "TOOLS.md": "",
        "HEARTBEAT.md": "",
        "MEMORY.md": "",
      };

      const content = fileContent[name];
      if (content !== undefined) {
        sendResponse(parsed.id, true, {
          file: { missing: !content, content: content || "" },
        });
      } else {
        sendResponse(parsed.id, true, { file: { missing: true, content: "" } });
      }
    };

    // ─── Handle agents.files.set ───
    const handleAgentsFilesSet = (parsed) => {
      const { agentId, name, content } = parsed.params || {};
      const agent = agentManager.getAgents().find((a) => a.agentId === agentId);
      if (agent && name === "SOUL.md" && typeof content === "string") {
        agent.systemPrompt = content;
        // Persist to config
        agentManager._saveAgentConfig(agentId, { systemPrompt: content });
      }
      sendResponse(parsed.id, true, { saved: true });
    };

    // ─── Handle agents.rename ───
    const handleAgentsRename = (parsed) => {
      const { agentId, name } = parsed.params || {};
      const agent = agentManager.getAgents().find((a) => a.agentId === agentId);
      if (agent && name) {
        agent.name = name;
      }
      sendResponse(parsed.id, true, { renamed: true });
    };

    // ─── Handle agents.delete ───
    const handleAgentsDelete = (parsed) => {
      sendResponse(parsed.id, true, { deleted: true });
    };

    // ─── Route methods ───
    const METHOD_HANDLERS = {
      "agents.list": handleAgentsList,
      "agents.create": handleAgentsCreate,
      "agents.files.get": handleAgentsFilesGet,
      "agents.files.set": handleAgentsFilesSet,
      "agents.rename": handleAgentsRename,
      "agents.delete": handleAgentsDelete,
      "chat.send": handleChatSend,
      "chat.history": handleChatHistory,
      "chat.abort": handleChatAbort,
      "sessions.list": handleSessionsList,
      "sessions.patch": handleSessionsPatch,
      "exec.approvals.get": handleExecApprovals,
      "config.get": handleConfigGet,
      "config.patch": handleConfigPatch,
      "summary.status": handleSummaryStatus,
      "summary.preview": handleSummaryPreview,
      "heartbeat.list": handleHeartbeatList,
      "heartbeat.wake": handleHeartbeatWake,
    };

    // ─── Browser message handler ───
    browserWs.on("message", async (raw) => {
      const parsed = safeJsonParse(String(raw ?? ""));
      if (!parsed || !isObject(parsed)) {
        closeBrowser(1003, "invalid json");
        return;
      }

      // First frame must be connect
      if (!connected) {
        if (parsed.type !== "req" || parsed.method !== "connect") {
          closeBrowser(1008, "connect required");
          return;
        }
        handleConnect(parsed);
        return;
      }

      // Route request to handler
      if (parsed.type === "req") {
        const handler = METHOD_HANDLERS[parsed.method];
        if (handler) {
          try {
            await handler(parsed);
          } catch (err) {
            logError(`Error handling ${parsed.method}`, err);
            sendResponse(parsed.id, false, null, {
              code: "internal_error",
              message: err instanceof Error ? err.message : "Internal error",
            });
          }
        } else {
          // Unknown method — respond with not_found
          sendResponse(parsed.id, false, null, {
            code: "method_not_found",
            message: `Method ${parsed.method} not supported`,
          });
        }
      }
    });

    browserWs.on("close", () => {
      closed = true;
      log("Browser disconnected");
    });

    browserWs.on("error", (err) => {
      logError("Browser WebSocket error", err);
      closeBrowser(1011, "client error");
    });
  });

  const handleUpgrade = (req, socket, head) => {
    if (!allowWs(req)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  };

  return { wss, handleUpgrade };
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Extract plain text from Claw3D message format.
 * Messages come as `<message>text</message>` from buildAgentInstruction.
 */
function extractPlainMessage(raw) {
  if (!raw || typeof raw !== "string") return String(raw ?? "");
  // Strip XML wrapper if present
  const match = raw.match(/<message>([\s\S]*?)<\/message>/);
  if (match) return match[1].trim();
  return raw.trim();
}

module.exports = { createClaudeGatewayProxy };
