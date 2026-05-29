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
  // 新版 OpenCode 可能会把同一段文本拆成多条 `message.part.delta`
  // 事件流式返回。这里按 partID 暂存片段内容，确保在 `session.idle`
  // 到来前可以把完整回复重新拼出来。
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
      // 先处理 delta 事件。对较新的服务端来说，这可能是唯一的文本事件。
      // 如果不先兼容这里，流程会在 `session.idle` 时因为 `latestText`
      // 仍然为空而错误回复 `(AI 未返回内容)`。
      const deltaEvent = getMessagePartDelta(event)
      if (deltaEvent) {
        // delta 事件也可能用于非文本字段，这里只拼接文本内容，
        // 因为最终发回 QQ 的只应该是助手生成的文本回复。
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
          // 保留对旧版 OpenCode 的兼容：旧版可能不会发送 delta，
          // 而是直接通过完整的 text part 更新文本内容。
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
  // 当前项目依赖的 SDK 类型里还没有声明 `message.part.delta`，
  // 所以这里改用运行时结构判断，而不是依赖现成的联合类型收窄。
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
