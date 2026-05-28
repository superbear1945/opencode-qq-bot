# openqq 与 opencode 兼容性修复说明

## 文档目的

本文档记录本次 `openqq` 修复的完整信息，包括：

- 问题现象与复现方式
- 问题代码来源与运行路径
- 根因分析
- 修改了哪些代码
- 每处修改的目的是什么
- 验证过程与结果
- 对上游仓库和版本情况的判断

本文档对应的本地运行环境为：

- `openqq` 通过 Bun 全局安装
- `openqq` 配置文件位于 `~/.openqq/.env`
- `opencode serve` 运行在 `http://localhost:4096`

## 相关安装与源码位置

### openqq 命令入口

当前系统中 `openqq` 命令路径为：

```bash
/home/azureuser/.bun/bin/openqq
```

其实际加载的源码入口为：

```bash
/home/azureuser/.bun/install/global/node_modules/opencode-qq-bot/bin/openqq.js
```

内容为：

```js
#!/usr/bin/env bun
import "../src/index.ts"
```

因此，实际运行源码目录为：

```bash
/home/azureuser/.bun/install/global/node_modules/opencode-qq-bot
```

核心源码文件包括：

- `/home/azureuser/.bun/install/global/node_modules/opencode-qq-bot/src/index.ts`
- `/home/azureuser/.bun/install/global/node_modules/opencode-qq-bot/src/commands.ts`
- `/home/azureuser/.bun/install/global/node_modules/opencode-qq-bot/src/bridge.ts`
- `/home/azureuser/.bun/install/global/node_modules/opencode-qq-bot/src/opencode/events.ts`

### openqq 配置文件

本机实际配置文件：

```bash
/home/azureuser/.openqq/.env
```

其中关键配置为：

```env
OPENCODE_BASE_URL=http://localhost:4096
```

说明 `openqq` 是连接外部已启动的 `opencode serve`，而不是自己内嵌启动服务。

## 问题现象

用户报告的现象有两个：

1. 给 QQ 机器人发送普通消息时，机器人回复：

```text
(AI 未返回内容)
```

2. 输入 `/model` 时，机器人回复：

```text
当前没有可用模型
```

3. 输入 `/status` 时却显示连接正常。

这说明：

- QQ 鉴权正常
- `openqq` 到 `opencode serve` 的基础连接正常
- 问题出在更细的接口兼容层，而不是整体启动失败

## 问题复现方式

### 复现前提

1. 启动 `opencode serve`
2. 启动 `openqq`
3. 确保 `~/.openqq/.env` 中 `OPENCODE_BASE_URL=http://localhost:4096`

### 复现步骤 1：模型列表为空

向机器人发送：

```text
/model
```

复现结果：

```text
当前没有可用模型
```

### 复现步骤 2：AI 回复为空

向机器人发送任意普通消息，例如：

```text
你好
```

复现结果：

```text
(AI 未返回内容)
```

## 问题代码来源

### 1. `/model` 相关代码来源

问题代码位于：

```bash
/home/azureuser/.bun/install/global/node_modules/opencode-qq-bot/src/commands.ts
```

修复前该文件的模型列表逻辑依赖 `client.config.providers()`，但只兼容旧结构，无法正确处理当前 `opencode` 的响应形状。

### 2. AI 文本回复相关代码来源

问题代码位于：

```bash
/home/azureuser/.bun/install/global/node_modules/opencode-qq-bot/src/bridge.ts
```

以及事件分发逻辑：

```bash
/home/azureuser/.bun/install/global/node_modules/opencode-qq-bot/src/opencode/events.ts
```

修复前逻辑只监听 `message.part.updated`，没有兼容当前 `opencode` 已实际使用的 `message.part.delta`。

## 根因分析

本次问题本质上是：

```text
opencode-qq-bot 与当前 opencode serve 的接口和事件结构不兼容
```

具体分为两个问题。

### 根因一：模型列表接口结构变化

当前 `opencode serve` 的 `/config/providers` 返回中，模型信息位于：

```json
{
  "providers": [
    {
      "id": "openai",
      "models": {
        "gpt-5.4": { ... },
        "gpt-5.5": { ... }
      }
    }
  ]
}
```

也就是说：

1. providers 可能嵌套在 `response.data.providers`
2. `models` 是对象字典，而不是数组

修复前代码没有兼容这两点，因此最终解析结果为空，导致 `/model` 返回“当前没有可用模型”。

### 根因二：文本事件由 `message.part.updated` 变为 `message.part.delta`

当前 `opencode` 实际会发送流式文本事件：

```text
message.part.delta
```

而修复前 `openqq` 只等待：

```text
message.part.updated
```

所以执行链路变成：

1. `openqq` 发送 prompt 成功
2. `opencode` 实际开始流式生成文本
3. 文本通过 `message.part.delta` 事件送出
4. `openqq` 没监听这个事件，导致 `latestText` 为空
5. 收到 `session.idle` 后，最终回退成：

```text
(AI 未返回内容)
```

## 修改内容总览

本次仅修改本机全局安装的 `opencode-qq-bot` 源码，未改动用户项目代码。

修改文件：

1. `/home/azureuser/.bun/install/global/node_modules/opencode-qq-bot/src/commands.ts`
2. `/home/azureuser/.bun/install/global/node_modules/opencode-qq-bot/src/bridge.ts`
3. `/home/azureuser/.bun/install/global/node_modules/opencode-qq-bot/src/opencode/events.ts`

## 详细修改说明

### 一、修改 `src/commands.ts`

#### 修改位置

文件：

```bash
/home/azureuser/.bun/install/global/node_modules/opencode-qq-bot/src/commands.ts
```

相关代码现在为：

```ts
async function listModels(client: OpencodeClient): Promise<ListedModel[]> {
  const configApi = extractProperty(client, "config")
  const providersFn = typeof configApi === "object" && configApi !== null ? Reflect.get(configApi, "providers") : undefined
  const response = typeof providersFn === "function" ? await Promise.resolve(providersFn.call(configApi)) : []

  const providers = extractProviders(response)
  const models: ListedModel[] = []

  for (const provider of providers) {
    const providerId = getString(provider, "id") ?? getString(provider, "providerID")
    const rawModels = extractEntries(extractProperty(provider, "models"))
    for (const model of rawModels) {
      const modelId = model.key ?? getString(model.value, "id") ?? getString(model.value, "modelID")
      if (!providerId || !modelId) {
        continue
      }
      models.push({
        id: `${providerId}/${modelId}`,
        label: `${providerId} / ${modelId}`,
      })
    }
  }

  return models
}
```

#### 额外新增的辅助函数

本次新增了两个辅助函数：

- `extractProviders()`
- `extractEntries()`

#### 修改目的

本次修改的目标是让模型列表逻辑兼容当前实际返回结构：

1. 兼容 `response.data.providers`
2. 兼容 `provider.models` 是对象字典
3. 兼容旧结构和新结构并存时仍可工作

#### 直接解决的问题

修复 `/model` 返回：

```text
当前没有可用模型
```

的误判问题。

## 二、修改 `src/bridge.ts`

### 修改位置

文件：

```bash
/home/azureuser/.bun/install/global/node_modules/opencode-qq-bot/src/bridge.ts
```

关键修复片段：

```ts
const textByPartId = new Map<string, string>()

if (event.type === "message.part.delta") {
  if (event.properties.field !== "text") {
    return
  }

  const current = textByPartId.get(event.properties.partID) ?? ""
  const next = current + event.properties.delta
  textByPartId.set(event.properties.partID, next)
  latestText = Array.from(textByPartId.values()).join("\n\n")
  return
}

if (event.type === "message.part.updated") {
  const part = event.properties.part
  if (part.type === "text") {
    textByPartId.set(part.id, part.text)
    latestText = Array.from(textByPartId.values()).join("\n\n")
  }
  return
}
```

### 修改目的

本次修改的目的有三点：

1. 兼容当前 `opencode` 实际发送的 `message.part.delta`
2. 保留对旧事件 `message.part.updated` 的兼容
3. 用 `partID` 聚合分片文本，确保最终回复内容完整

### 为什么要按 `partID` 聚合

因为 `message.part.delta` 是增量流式事件，不一定一次给出完整文本，必须把同一个 part 的多次 delta 拼接起来，否则最终文本会缺失或错乱。

### 直接解决的问题

修复普通消息被回复为：

```text
(AI 未返回内容)
```

的问题。

## 三、修改 `src/opencode/events.ts`

### 修改位置

文件：

```bash
/home/azureuser/.bun/install/global/node_modules/opencode-qq-bot/src/opencode/events.ts
```

关键修改：

```ts
case "message.part.delta":
  return event.properties.sessionID
```

### 修改目的

事件路由器需要先能把事件按 `sessionID` 正确分发到对应会话。

如果只在 `bridge.ts` 里监听 `message.part.delta`，但 `EventRouter` 自身无法识别这个事件对应的 `sessionID`，那么事件仍然不会送达桥接层。

因此必须同时修改：

1. `EventRouter.extractSessionId()`
2. `waitForSessionReply()` 中的事件处理逻辑

### 直接解决的问题

确保 `message.part.delta` 事件能从 SSE 总线正确传递到当前 QQ 用户会话的处理器中。

## 验证过程

### 验证 1：确认模型接口本身正常

本地直接访问：

```bash
curl -s "http://localhost:4096/config/providers"
```

确认返回中存在大量 provider 和 model，说明：

- `opencode serve` 模型功能正常
- “无模型可选”不是后端没模型，而是 `openqq` 解析错误

### 验证 2：验证修复后的模型提取逻辑

本地对当前接口结构做同样提取后，成功得到：

- `providers = 9`
- `models = 50`

说明修复后的模型提取逻辑已经能正确识别当前接口结构。

### 验证 3：验证实际文本事件类型

对 `opencode` 新建 session 并发送 prompt：

```text
只回复OK
```

实际观测结果为：

```json
{
  "timeout": false,
  "sawDelta": true,
  "sawUpdated": false,
  "text": "OK"
}
```

这说明：

1. 当前 `opencode` 实际发送的是 `message.part.delta`
2. 没有发送 `message.part.updated`
3. 旧版 `openqq` 只监听 `message.part.updated`，因此必然丢失文本

### 验证 4：端到端最小测试

本地对 `opencode` 发起最小 prompt 测试后成功得到：

```json
{
  "text": "OK"
}
```

说明：

- 事件分发修复生效
- 文本聚合修复生效
- 最终会话文本可以被正确拿到

## 关于上游仓库的调查结论

本次还检查了上游仓库：

```bash
https://github.com/gbwssve/opencode-qq-bot
```

### 结论 1：已发布版本并不比本地更新

npm 已发布版本只有：

- `0.1.0`
- `0.1.1`

本机 Bun 全局安装版本也是：

```text
opencode-qq-bot@0.1.1
```

因此不能简单归因为：

```text
bun 装到的版本过低
```

### 结论 2：GitHub 最新提交仍未完整修复本问题

虽然 GitHub 最新仓库已经把模型列表逻辑改成 `client.provider.list()`，对 `/model` 更友好，但其 `bridge.ts` 仍然只监听：

```ts
if (event.type === "message.part.updated")
```

仍未兼容：

```text
message.part.delta
```

所以即使切到最新提交，`(AI 未返回内容)` 这个问题在当前 `opencode` 上仍有较大概率继续存在。

## 本次修复的目标边界

本次修复只针对当前系统中的全局安装副本：

```bash
/home/azureuser/.bun/install/global/node_modules/opencode-qq-bot
```

没有做的事情：

1. 没有提交 git commit
2. 没有发布 npm 新版本
3. 没有修改上游 GitHub 仓库
4. 没有改动用户其他项目目录

## 后续建议

### 建议 1

如果后续重新执行 `bun add -g opencode-qq-bot`，可能会覆盖本地补丁，需要重新应用修复。

### 建议 2

建议将本次修复整理为上游 PR，至少包括：

1. 兼容 `message.part.delta`
2. 兼容 `config.providers()` 的多种返回结构
3. 补充对不同 `opencode` 版本的兼容测试

### 建议 3

如果后续要长期维护，最好不要直接改 Bun 全局安装目录，而是：

1. clone 上游仓库到固定目录
2. 在本地仓库里维护 patch
3. 用 `bun link` 或直接从本地源码启动

## 本次修复摘要

一句话总结：

```text
本次修复解决了 openqq 在当前 opencode serve 环境下的两个兼容性问题：模型列表解析失败，以及文本事件从 message.part.updated 切换为 message.part.delta 后导致的 AI 空回复问题。
```

---

文档生成位置：

```bash
/home/azureuser/openqq-fix-report.md
```
