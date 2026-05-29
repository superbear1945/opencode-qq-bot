import type { OpencodeClient } from "./client.js"
import type { Event } from "@opencode-ai/sdk"

export interface AdapterSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface AdapterModel {
  id: string
  providerId: string
  modelId: string
  label: string
}

export interface AdapterAgent {
  id: string
  label: string
}

export interface PromptParams {
  sessionId: string
  text: string
  model?: { providerID: string; modelID: string }
  agent?: string
}

export interface SSEStream {
  stream: AsyncIterable<Event>
}

function toAdapterSession(raw: Record<string, unknown>): AdapterSession | null {
  const id = typeof raw.id === "string" ? raw.id : undefined
  if (!id) return null
  return {
    id,
    title: typeof raw.title === "string" ? raw.title : id,
    createdAt: typeof raw.time === "object" && raw.time !== null
      ? Number((raw.time as Record<string, unknown>).created ?? 0)
      : 0,
    updatedAt: typeof raw.time === "object" && raw.time !== null
      ? Number((raw.time as Record<string, unknown>).updated ?? 0)
      : 0,
  }
}

export async function createSession(client: OpencodeClient): Promise<AdapterSession> {
  const result = await client.session.create({})
  const raw = (result.data ?? result) as unknown as Record<string, unknown>
  const session = toAdapterSession(raw)
  if (!session) throw new Error("session.create returned invalid data")
  return session
}

export async function listSessions(client: OpencodeClient): Promise<AdapterSession[]> {
  const result = await client.session.list()
  const arr = Array.isArray(result.data) ? result.data : Array.isArray(result) ? result : []
  return (arr as Record<string, unknown>[])
    .map(toAdapterSession)
    .filter((s): s is AdapterSession => s !== null)
}

export async function abortSession(client: OpencodeClient, sessionId: string): Promise<void> {
  await client.session.abort({ path: { id: sessionId } })
}

export async function updateSessionTitle(client: OpencodeClient, sessionId: string, title: string): Promise<AdapterSession> {
  const result = await client.session.update({ path: { id: sessionId }, body: { title } })
  const raw = (result.data ?? result) as unknown as Record<string, unknown>
  const session = toAdapterSession(raw)
  if (!session) throw new Error("session.update returned invalid data")
  return session
}

export async function promptAsync(client: OpencodeClient, params: PromptParams): Promise<void> {
  await client.session.promptAsync({
    path: { id: params.sessionId },
    body: {
      parts: [{ type: "text", text: params.text }],
      ...(params.model ? { model: params.model } : {}),
      ...(params.agent ? { agent: params.agent } : {}),
    },
  })
}

export async function listProviderModels(client: OpencodeClient): Promise<AdapterModel[]> {
  try {
    const result = await client.provider.list()
    // 优先使用专门的 provider API。较新的 OpenCode 版本通常会在这里
    // 提供更标准化的 provider / model 元数据。
    const models = collectProviderModels(result)
    if (models.length > 0) {
      return models
    }
  } catch {
    // 一些旧版 OpenCode / server 组合根本不暴露 `/provider`，
    // 或者 SDK 在调用这里时会直接抛错。这里故意继续往下走
    // `config.providers()` 的兜底逻辑，保证不同版本混用时 `/model`
    // 仍然尽量可用。
  }

  const configApi = getProperty(client, "config")
  const providersFn = isRecord(configApi) ? Reflect.get(configApi, "providers") : undefined
  if (typeof providersFn !== "function") {
    return []
  }

  // 兜底兼容旧版 SDK / server：当 `provider.list()` 不存在、
  // 返回不完整，或者返回结构与当前预期不一致时，仍然尝试从
  // `config.providers()` 中提取 `/model` 需要的数据。
  return collectProviderModels(await Promise.resolve(providersFn.call(configApi)))
}

function collectProviderModels(response: unknown): AdapterModel[] {
  const providers = extractProviders(response)
  const models: AdapterModel[] = []

  for (const provider of providers) {
    const providerId = getString(provider, "id") ?? getString(provider, "providerID")
    if (!providerId) continue

    for (const model of extractModelEntries(getProperty(provider, "models"))) {
      const modelId = model.key ?? getString(model.value, "id") ?? getString(model.value, "modelID")
      if (!modelId) continue
      const modelName = getString(model.value, "name") ?? modelId
      models.push({ id: `${providerId}/${modelId}`, providerId, modelId, label: `${providerId} / ${modelName}` })
    }
  }

  return models
}

function extractProviders(response: unknown): Record<string, unknown>[] {
  const data = getProperty(response, "data") ?? response
  // 不同 OpenCode / SDK 版本把 providers 放在不同位置：
  // - provider.list() 常见于 data.all
  // - config.providers() 可能暴露在 data.providers
  // - 某些包装层可能直接把 providers 放在顶层
  // 这里按优先顺序检查这些已知位置，拿到第一个可用数组即可。
  const candidates = [
    data,
    getProperty(data, "all"),
    getProperty(data, "providers"),
    getProperty(response, "providers"),
  ]

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord)
    }
  }

  return []
}

function extractModelEntries(models: unknown): Array<{ key?: string; value: unknown }> {
  // 新版响应经常把 models 表示为以 model id 为 key 的对象字典，
  // 而旧代码路径里仍可能是数组。这里统一转换成 `{ key, value }`
  // 序列，简化后续解析逻辑。
  if (Array.isArray(models)) {
    return models.map((value) => ({ value }))
  }
  if (isRecord(models)) {
    return Object.entries(models).map(([key, value]) => ({ key, value }))
  }
  return []
}

function getProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? Reflect.get(value, key) : undefined
}

function getString(value: unknown, key: string): string | undefined {
  const property = getProperty(value, key)
  return typeof property === "string" ? property : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export async function listAgents(client: OpencodeClient): Promise<AdapterAgent[]> {
  const result = await client.app.agents()
  const arr = Array.isArray(result.data) ? result.data : Array.isArray(result) ? result : []
  return (arr as Record<string, unknown>[])
    .map((a) => {
      const id = typeof a.id === "string" ? a.id : typeof a.name === "string" ? a.name : undefined
      if (!id) return null
      const desc = typeof a.description === "string" ? a.description : undefined
      return { id, label: desc ? `${id} - ${desc}` : id }
    })
    .filter((a): a is AdapterAgent => a !== null)
}

export async function subscribeEvents(client: OpencodeClient): Promise<SSEStream> {
  const result = await client.event.subscribe()
  return { stream: result.stream as AsyncIterable<Event> }
}

export async function healthCheck(client: OpencodeClient): Promise<void> {
  try {
    await client.session.list()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`OpenCode server unreachable: ${msg}`)
  }
}
