/**
 * Claude Agent Manager
 *
 * Manages multiple Claude Agent SDK sessions — one per office agent.
 * Follows the same pattern as ClinkCode's ClaudeManager:
 *   - Uses `query()` from @anthropic-ai/claude-agent-sdk
 *   - AsyncQueue-based streaming
 *   - Session resumption via `resume: sessionId`
 *   - Tool permission handling
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// ─── AsyncQueue (ported from ClinkCode) ─────────────────────────────
class AsyncQueue {
  constructor() {
    this.queue = [];
    this.resolvers = [];
    this.rejectors = [];
    this._closed = false;
  }

  enqueue(item) {
    if (this._closed) return;
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift();
      resolve(item);
    } else {
      this.queue.push(item);
    }
  }

  async dequeue() {
    if (this._closed && this.queue.length === 0) {
      throw new Error("Queue is closed and empty");
    }
    return new Promise((resolve, reject) => {
      if (this.queue.length > 0) {
        resolve(this.queue.shift());
      } else if (this._closed) {
        reject(new Error("Queue is closed and empty"));
      } else {
        this.resolvers.push(resolve);
        this.rejectors.push(reject);
      }
    });
  }

  close() {
    this._closed = true;
    while (this.rejectors.length > 0) {
      const reject = this.rejectors.shift();
      reject(new Error("Queue is closed"));
    }
    this.resolvers.length = 0;
  }

  get isClosed() {
    return this._closed;
  }

  get size() {
    return this.queue.length;
  }
}

// ─── StreamManager (ported from ClinkCode) ──────────────────────────
class StreamManager {
  constructor() {
    this.streams = new Map();
  }

  getOrCreateStream(key) {
    if (!this.streams.has(key)) {
      const controller = new AbortController();
      const messageQueue = new AsyncQueue();
      this.streams.set(key, { controller, messageQueue });
    }
    const info = this.streams.get(key);
    return this._createPersistentIterable(key, info.messageQueue, info.controller);
  }

  addMessage(key, message) {
    const stream = this.streams.get(key);
    if (stream && !stream.controller.signal.aborted && !stream.messageQueue.isClosed) {
      stream.messageQueue.enqueue(message);
    }
  }

  getController(key) {
    return this.streams.get(key)?.controller;
  }

  abortStream(key) {
    const stream = this.streams.get(key);
    if (stream) {
      stream.controller.abort();
      stream.messageQueue.close();
      this.streams.delete(key);
      return true;
    }
    return false;
  }

  isStreamActive(key) {
    const stream = this.streams.get(key);
    return stream ? !stream.controller.signal.aborted && !stream.messageQueue.isClosed : false;
  }

  shutdown() {
    for (const [key] of this.streams) {
      this.abortStream(key);
    }
  }

  async *_createPersistentIterable(key, queue, controller) {
    try {
      while (!controller.signal.aborted) {
        try {
          const message = await queue.dequeue();
          yield message;
        } catch {
          if (controller.signal.aborted || queue.isClosed) break;
          throw new Error(`Stream error for ${key}`);
        }
      }
    } finally {
      // stream ended
    }
  }
}

// ─── Agent Manager ──────────────────────────────────────────────────
class ClaudeAgentManager {
  constructor(config = {}) {
    this.agents = new Map();
    this.sessions = new Map(); // sessionKey → { sessionId, history[] }
    this.streamManager = new StreamManager();
    this.activeQueries = new Map(); // sessionKey → { abort, running }
    this.binaryPath = config.binaryPath || undefined;
    this.defaultModel = config.defaultModel || "claude-haiku-4-5-20251001";
    this.workDir = config.workDir || process.cwd();
    this.sessionsDir = config.sessionsDir || path.join(os.homedir(), ".claw3d-claude", "sessions");

    // Ensure sessions directory exists
    fs.mkdirSync(this.sessionsDir, { recursive: true });

    // SDK loaded lazily (ESM)
    this._sdk = null;
    this._sdkLoading = null;
  }

  async _loadSdk() {
    if (this._sdk) return this._sdk;
    if (this._sdkLoading) return this._sdkLoading;
    this._sdkLoading = import("@anthropic-ai/claude-agent-sdk").then((mod) => {
      this._sdk = mod;
      return mod;
    });
    return this._sdkLoading;
  }

  // ─── Agent Registration ───────────────────────────────────────────

  registerAgent(agentDef) {
    const sessionKey = `agent:${agentDef.id}:main`;
    const agent = {
      agentId: agentDef.id,
      name: agentDef.name,
      sessionKey,
      role: agentDef.role || "Assistant",
      systemPrompt: agentDef.systemPrompt || null,
      model: agentDef.model || this.defaultModel,
      status: "idle",
      isDefault: agentDef.isDefault || false,
      lastActivityAt: null,
      lastPreview: null,
      thinkingLevel: agentDef.thinkingLevel || null,
      sessionExecHost: agentDef.execHost || null,
      sessionExecSecurity: agentDef.execSecurity || "full",
      sessionExecAsk: agentDef.execAsk || "off",
    };
    this.agents.set(agentDef.id, agent);

    // Load persisted session if available
    const savedSession = this._loadSession(sessionKey);
    this.sessions.set(sessionKey, savedSession || { sessionId: null, history: [] });

    console.log(`[agent-manager] Registered agent: ${agent.name} (${agent.agentId})`);
    return agent;
  }

  getAgents() {
    return Array.from(this.agents.values());
  }

  getAgentBySessionKey(sessionKey) {
    return Array.from(this.agents.values()).find((a) => a.sessionKey === sessionKey) || null;
  }

  // ─── Session Management ───────────────────────────────────────────

  patchSession(sessionKey, patch) {
    const agent = this.getAgentBySessionKey(sessionKey);
    if (!agent) return;
    if (patch.model) agent.model = patch.model.replace("anthropic/", "");
    if (patch.thinkingLevel) agent.thinkingLevel = patch.thinkingLevel;
    if (patch.execHost) agent.sessionExecHost = patch.execHost;
    if (patch.execSecurity) agent.sessionExecSecurity = patch.execSecurity;
    if (patch.execAsk) agent.sessionExecAsk = patch.execAsk;
  }

  getHistory(sessionKey, limit = 50) {
    const session = this.sessions.get(sessionKey);
    if (!session) return [];
    return session.history.slice(-limit);
  }

  // ─── Send Message (ClinkCode pattern) ─────────────────────────────

  async sendMessage({ sessionKey, message, runId, onDelta, onThinking, onToolUse, onToolResult, onFinal, onError, onLifecycleStart }) {
    const sdk = await this._loadSdk();
    const agent = this.getAgentBySessionKey(sessionKey);
    if (!agent) {
      onError?.("Agent not found for session: " + sessionKey);
      return;
    }

    const session = this.sessions.get(sessionKey) || { sessionId: null, history: [] };

    // Signal lifecycle start
    onLifecycleStart?.();
    agent.status = "running";
    agent.lastActivityAt = Date.now();

    // Add user message to history
    session.history.push({
      role: "user",
      content: message,
      timestamp: Date.now(),
    });

    // Build user message in SDK format (same as ClinkCode)
    const userMessage = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: message }],
      },
      parent_tool_use_id: null,
      session_id: "",
    };

    // Create stream and enqueue message
    const stream = this.streamManager.getOrCreateStream(sessionKey);
    this.streamManager.addMessage(sessionKey, userMessage);

    // Build SDK options (same as ClinkCode's startNewQuery)
    const controller = this.streamManager.getController(sessionKey);
    const options = {
      cwd: this.workDir,
      model: agent.model,
      ...(session.sessionId ? { resume: session.sessionId } : {}),
      ...(this.binaryPath ? { pathToClaudeCodeExecutable: this.binaryPath } : {}),
      abortController: controller,
      permissionMode: "bypassPermissions",
      systemPrompt: agent.systemPrompt || undefined,
      settingSources: ["user", "project", "local"],
    };

    let fullText = "";
    let seq = 0;

    try {
      for await (const msg of sdk.query({ prompt: stream, options })) {
        // Persist session ID (same as ClinkCode)
        if (msg.session_id && session.sessionId !== msg.session_id) {
          session.sessionId = msg.session_id;
          this._saveSession(sessionKey, session);
        }

        // Process message types
        if (msg.type === "assistant") {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                fullText += block.text;
                seq++;
                onDelta?.(fullText, seq);
              } else if (block.type === "thinking" && block.thinking) {
                onThinking?.(block.thinking);
              } else if (block.type === "tool_use") {
                onToolUse?.(block.name, block.input, block.id);
              }
            }
          }
        } else if (msg.type === "user") {
          // Tool results come back as user messages
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result") {
                const resultText =
                  typeof block.content === "string"
                    ? block.content
                    : JSON.stringify(block.content ?? "");
                onToolResult?.(block.tool_use_id, resultText);
              }
            }
          }
        }
      }
    } catch (err) {
      if (err.name === "AbortError" || err.message?.includes("abort")) {
        // Clean abort — don't report as error
      } else {
        onError?.(err.message || "Claude query failed");
      }
    } finally {
      // Clean up stream
      this.streamManager.abortStream(sessionKey);
    }

    // Store result in history
    if (fullText) {
      session.history.push({
        role: "assistant",
        content: fullText,
        timestamp: Date.now(),
      });
      agent.lastPreview = fullText.slice(0, 200);
      this._saveSession(sessionKey, session);
    }

    agent.status = "idle";
    agent.lastActivityAt = Date.now();

    // Signal completion
    onFinal?.(fullText);
  }

  // ─── Abort ────────────────────────────────────────────────────────

  abortQuery(sessionKey) {
    const aborted = this.streamManager.abortStream(sessionKey);
    const agent = this.getAgentBySessionKey(sessionKey);
    if (agent) {
      agent.status = "idle";
    }
    return aborted;
  }

  // ─── Session Persistence ──────────────────────────────────────────

  _sessionFilePath(sessionKey) {
    const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.sessionsDir, `${safe}.json`);
  }

  _loadSession(sessionKey) {
    try {
      const filePath = this._sessionFilePath(sessionKey);
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  _saveSession(sessionKey, session) {
    try {
      const filePath = this._sessionFilePath(sessionKey);
      // Keep only last 100 history entries to prevent unbounded growth
      const trimmed = {
        ...session,
        history: session.history.slice(-100),
      };
      fs.writeFileSync(filePath, JSON.stringify(trimmed, null, 2));
    } catch (err) {
      console.error(`[agent-manager] Failed to save session ${sessionKey}:`, err.message);
    }
  }

  // ─── Agent Config Persistence ───────────────────────────────────

  _saveAgentConfig(agentId, patch) {
    try {
      const configPath = path.join(os.homedir(), ".claw3d-claude", "agents.json");
      if (!fs.existsSync(configPath)) return;
      const raw = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      if (!Array.isArray(config.agents)) return;
      const agent = config.agents.find((a) => a.id === agentId);
      if (agent) {
        Object.assign(agent, patch);
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      }
    } catch (err) {
      console.error(`[agent-manager] Failed to save agent config for ${agentId}:`, err.message);
    }
  }

  // ─── Shutdown ─────────────────────────────────────────────────────

  shutdown() {
    this.streamManager.shutdown();
    // Save all sessions
    for (const [key, session] of this.sessions) {
      this._saveSession(key, session);
    }
    console.log("[agent-manager] Shutdown complete.");
  }
}

module.exports = { ClaudeAgentManager };
