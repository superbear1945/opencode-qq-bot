import type { Config } from "./config.js"
import type { MessageContext } from "./qq/types.js"
import { getAccessToken } from "./qq/token.js"
import { replyToQQ } from "./qq/sender.js"
import type { OpencodeClient } from "./opencode/client.js"
import { promptAsync } from "./opencode/adapter.js"
import { EventRouter } from "./opencode/events.js"
import { SessionManager } from "./opencode/sessions.js"
import type { Event } from "@opencode-ai/sdk"
import {
  buildHelpText,
  handleCommand,
  handlePendingSelection,
  isCommand,
  type CommandContext,
  type PendingSelection,
} from "./commands/index.js"

const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000

interface Bridge {
  handleMessage: (ctx: MessageContext) => Promise<void>
}

export function createBridge(
  config: Config,
  client: OpencodeClient,
  router: EventRouter,
  sessions: SessionManager,
): Bridge {
  const busyUsers = new Set<string>()
  const greeted = new Set<string>()
  const pendingSelections = new Map<string, PendingSelection>()
  const commandContext: CommandContext = {
    config,
    client,
    sessions,
    getAccessToken: () => getAccessToken(config.qq.appId, config.qq.clientSecret),
    pendingSelections,
  }

  const handleMessage = async (ctx: MessageContext): Promise<void> => {
    try {
      if (!isAllowedUser(ctx.userId, config.allowedUsers)) {
        await sendReply(ctx, "你不在允许使用的名单里")
        return
      }

      const content = ctx.content.trim()
      if (!content) {
        return
      }

      if (!greeted.has(ctx.userId)) {
        greeted.add(ctx.userId)
        await sendReply(ctx, buildHelpText())
      }

      if (isCommand(content)) {
        const reply = await handleCommand(ctx, commandContext)
        await sendReply(ctx, reply)
        return
      }

      const pendingReply = await maybeHandlePendingSelection(ctx, commandContext)
      if (pendingReply !== null) {
        await sendReply(ctx, pendingReply)
        return
      }

      if (busyUsers.has(ctx.userId)) {
        await sendReply(ctx, "上一条消息还在处理中，请稍候再试")
        return
      }

      busyUsers.add(ctx.userId)

      try {
        const session = await sessions.getOrCreate(ctx.userId)
        const model = sessions.getModel(ctx.userId)
        const agent = sessions.getAgent(ctx.userId)

        const replyText = await waitForSessionReply(router, session.sessionId, () => {
          void promptAsync(client, {
            sessionId: session.sessionId,
            text: content,
            model: model.providerId && model.modelId
              ? { providerID: model.providerId, modelID: model.modelId }
              : undefined,
            agent,
          })
        })

        if (replyText.trim()) {
          await sendReply(ctx, replyText)
        }
      } catch (error) {
        await sendReply(ctx, `处理失败：${toErrorMessage(error)}`)
      } finally {
        busyUsers.delete(ctx.userId)
      }
    } catch (error) {
      console.error("[bridge] handleMessage failed:", error)
      try {
        await sendReply(ctx, `处理消息失败：${toErrorMessage(error)}`)
      } catch (replyError) {
        console.error("[bridge] failed to send error reply:", replyError)
      }
    }
  }

  async function sendReply(ctx: MessageContext, text: string): Promise<void> {
    const accessToken = await getAccessToken(config.qq.appId, config.qq.clientSecret)
    await replyToQQ(accessToken, ctx, text, config.maxReplyLength)
  }

  return { handleMessage }
}

async function maybeHandlePendingSelection(
  ctx: MessageContext,
  commandContext: CommandContext,
): Promise<string | null> {
  const pending = commandContext.pendingSelections.get(ctx.userId)
  if (!pending) {
    return null
  }

  if (pending.expiresAt <= Date.now()) {
    commandContext.pendingSelections.delete(ctx.userId)
    return null
  }

  if (!/^\d+$/.test(ctx.content.trim())) {
    commandContext.pendingSelections.delete(ctx.userId)
    return null
  }

  return handlePendingSelection(ctx.userId, Number(ctx.content.trim()), commandContext)
}

function isAllowedUser(userId: string, allowedUsers: string[]): boolean {
  return allowedUsers.length === 0 || allowedUsers.includes(userId)
}

function waitForSessionReply(
  router: EventRouter,
  sessionId: string,
  startPrompt: () => void,
): Promise<string> {
  let settled = false
  let latestText = ""
  // Newer OpenCode builds can stream assistant text as multiple
  // `message.part.delta` events for the same logical text part.
  // We keep the partial text keyed by partID so reviewers can see
  // exactly how the final reply is reconstructed before `session.idle`.
  const textByPartId = new Map<string, string>()

  return new Promise<string>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      finish(() => reject(new Error("AI 响应超时（5 分钟）")))
    }, RESPONSE_TIMEOUT_MS)

    const finish = (done: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeoutId)
      router.unregister(sessionId)
      done()
    }

    router.unregister(sessionId)
    router.register(sessionId, (event: Event) => {
      // Prefer delta handling first. On newer servers this is the only
      // text event we receive, so without this branch the bot would reach
      // `session.idle` with an empty `latestText` and reply with
      // `(AI 未返回内容)` even though the model did generate output.
      const deltaEvent = getMessagePartDelta(event)
      if (deltaEvent) {
        // Delta events can be emitted for non-text fields as well.
        // We only append text content here because that is what should
        // be sent back to QQ as the assistant reply.
        if (deltaEvent.properties.field !== "text") {
          return
        }

        const current = textByPartId.get(deltaEvent.properties.partID) ?? ""
        textByPartId.set(deltaEvent.properties.partID, current + deltaEvent.properties.delta)
        latestText = Array.from(textByPartId.values()).join("\n\n")
        return
      }

      if (event.type === "message.part.updated") {
        const part = event.properties.part
        if (part.type === "text") {
          // Keep compatibility with older OpenCode versions that still
          // emit the fully materialized text part instead of delta events.
          textByPartId.set(part.id, part.text)
          latestText = Array.from(textByPartId.values()).join("\n\n")
        }
        return
      }

      if (event.type === "session.idle") {
        finish(() => resolve(latestText || "(AI 未返回内容)"))
        return
      }

      if (event.type === "session.error") {
        finish(() => reject(new Error(toErrorMessage(event.properties.error) || "未知错误")))
      }
    })

    try {
      startPrompt()
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))))
    }
  })
}

interface MessagePartDeltaEvent {
  type: "message.part.delta"
  properties: {
    sessionID: string
    partID: string
    field: string
    delta: string
  }
}

function getMessagePartDelta(event: unknown): MessagePartDeltaEvent | null {
  // The SDK Event union in this project version does not model
  // `message.part.delta`, so we narrow the shape manually instead of
  // relying on a typed discriminated union.
  if (typeof event !== "object" || event === null) {
    return null
  }

  if (Reflect.get(event, "type") !== "message.part.delta") {
    return null
  }

  const properties = Reflect.get(event, "properties")
  if (typeof properties !== "object" || properties === null) {
    return null
  }

  const partID = Reflect.get(properties, "partID")
  const field = Reflect.get(properties, "field")
  const delta = Reflect.get(properties, "delta")
  const sessionID = Reflect.get(properties, "sessionID")
  if (typeof partID !== "string" || typeof field !== "string" || typeof delta !== "string") {
    return null
  }

  return {
    type: "message.part.delta",
    properties: {
      sessionID: typeof sessionID === "string" ? sessionID : "",
      partID,
      field,
      delta,
    },
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
