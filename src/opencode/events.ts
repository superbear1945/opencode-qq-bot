// @input:  @opencode-ai/sdk (Event, SSE stream), ./client (OpencodeClient)
// @output: EventRouter, EventCallback
// @pos:    opencode层 - 全局 SSE 事件订阅 + 按 sessionId 分发
import type { OpencodeClient } from "./client.js"
import type { Event } from "@opencode-ai/sdk"

export type EventCallback = (event: Event) => void

export class EventRouter {
  private listeners = new Map<string, EventCallback>()
  private running = false
  private client: OpencodeClient

  constructor(client: OpencodeClient) {
    this.client = client
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.consume()
  }

  stop(): void {
    this.running = false
  }

  register(sessionId: string, callback: EventCallback): void {
    this.listeners.set(sessionId, callback)
  }

  unregister(sessionId: string): void {
    this.listeners.delete(sessionId)
  }

  private async consume(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.client.event.subscribe()

        for await (const event of result.stream) {
          if (!this.running) break
          const sessionId = this.extractSessionId(event)
          if (sessionId) {
            const cb = this.listeners.get(sessionId)
            if (cb) cb(event)
          }
        }
        // 成功消费流后重置重连延迟
        this.resetBackoff()
      } catch (err) {
        if (!this.running) break
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[events] SSE connection error: ${msg}`)
        await this.backoff()
      }
    }
  }

  private extractSessionId(event: Event): string | undefined {
    // `message.part.delta` 不适合走下面旧分支的类型结构，但它仍然会在
    // `properties` 里携带 `sessionID`。这里先特判提取，确保新版流式文本
    // 事件也能被路由到正确的会话监听器。
    const deltaSessionId = extractDeltaSessionId(event)
    if (deltaSessionId) {
      return deltaSessionId
    }

    switch (event.type) {
      case "message.part.updated":
        return event.properties.part.sessionID
      case "message.updated":
        return event.properties.info.sessionID
      case "session.idle":
      case "session.compacted":
        return event.properties.sessionID
      case "session.status":
        return event.properties.sessionID
      case "session.error":
        return event.properties.sessionID
      case "message.removed":
        return event.properties.sessionID
      default:
        return undefined
    }
  }

  private reconnectDelay = 1000
  private async backoff(): Promise<void> {
    await new Promise((r) => setTimeout(r, this.reconnectDelay))
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
  }

  resetBackoff(): void {
    this.reconnectDelay = 1000
  }
}

function extractDeltaSessionId(event: Event): string | undefined {
  // 这里故意使用基于运行时结构的判断，而不是依赖 SDK 当前的类型定义，
  // 这样即使本地安装的 SDK 类型还没跟上运行时事件集合，也能正常工作。
  const properties = (event as { properties?: unknown }).properties
  if (typeof properties !== "object" || properties === null) {
    return undefined
  }

  const sessionId = Reflect.get(properties, "sessionID")
  return typeof sessionId === "string" ? sessionId : undefined
}
