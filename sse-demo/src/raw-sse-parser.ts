/**
 * SSE 解析器 —— 从原始字节到 EventSource 事件的完整过程
 *
 * 这个文件不依赖任何服务端，直接用硬编码的原始字节来演示解析过程。
 * 适合单独运行来理解 SSE 协议。
 */

// ============================================================
// SSE 规范定义的解析算法
// 参考: https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
// ============================================================

interface ParsedEvent {
  type: string; // event type, 默认 "message"
  data: string;
  lastEventId: string;
}

class SSEParser {
  private buffer = "";
  private eventType = "";
  private data: string[] = [];
  private lastEventId = "";
  private events: ParsedEvent[] = [];

  /**
   * 模拟接收一个 chunk（可能包含不完整的行）
   */
  feed(chunk: string): ParsedEvent[] {
    this.buffer += chunk;
    const newEvents: ParsedEvent[] = [];

    // 按行处理（SSE 以 \n, \r, 或 \r\n 作为行结束符）
    while (true) {
      const lineEnd = this.buffer.indexOf("\n");
      if (lineEnd === -1) break;

      const line = this.buffer.slice(0, lineEnd).replace(/\r$/, "");
      this.buffer = this.buffer.slice(lineEnd + 1);

      const event = this.processLine(line);
      if (event) {
        newEvents.push(event);
      }
    }

    return newEvents;
  }

  /**
   * SSE 规范的逐行处理逻辑
   */
  private processLine(line: string): ParsedEvent | null {
    // 空行 → 触发事件分发
    if (line === "") {
      return this.dispatchEvent();
    }

    // 注释行（以 : 开头）→ 忽略
    if (line.startsWith(":")) {
      return null;
    }

    // 解析 field: value
    let field: string;
    let value: string;

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      // 整行作为 field，value 为空
      field = line;
      value = "";
    } else {
      field = line.slice(0, colonIndex);
      value = line.slice(colonIndex + 1);
      // 规范：如果 value 以空格开头，去掉第一个空格
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }
    }

    // 处理已知字段
    switch (field) {
      case "event":
        this.eventType = value;
        break;
      case "data":
        this.data.push(value);
        break;
      case "id":
        // 规范：如果 id 包含 \0 则忽略
        if (!value.includes("\0")) {
          this.lastEventId = value;
        }
        break;
      case "retry":
        // 规范：如果全是数字，更新重连时间
        if (/^\d+$/.test(value)) {
          // 实际的 EventSource 会更新 reconnection time
          // 这里只做记录
        }
        break;
      // 未知字段 → 忽略
    }

    return null;
  }

  /**
   * 分发事件（空行触发）
   */
  private dispatchEvent(): ParsedEvent | null {
    if (this.data.length === 0) {
      // 没有 data → 不产生事件，只重置
      this.eventType = "";
      return null;
    }

    const event: ParsedEvent = {
      type: this.eventType || "message", // 默认类型是 "message"
      data: this.data.join("\n"), // 多行 data 用 \n 拼接
      lastEventId: this.lastEventId,
    };

    // 重置（注意：lastEventId 不重置，它是持久的）
    this.eventType = "";
    this.data = [];

    this.events.push(event);
    return event;
  }
}

// ============================================================
// 演示：硬编码的原始 SSE 字节流
// ============================================================

console.log("=".repeat(60));
console.log("SSE 原始字节 → 解析事件 演示");
console.log("=".repeat(60));

// 这就是服务端通过 HTTP 发送的原始文本（text/event-stream）
// 你可以用 curl -N http://example.com/sse 看到完全一样的内容
const rawSSEBytes = `: 这是一条注释，客户端会忽略
retry: 3000

id: 1
event: message
data: {"text":"hello world"}

id: 2
event: update
data: first line
data: second line

id: 3
data: default event type (message)

event: ping
data: keepalive

`;

console.log("\n原始 SSE 文本 (服务端发送的字节):");
console.log("┌─────────────────────────────────────────");
for (const line of rawSSEBytes.split("\n")) {
  console.log(`│ ${line}`);
}
console.log("└─────────────────────────────────────────");

// ============================================================
// 模拟网络分片：把完整文本拆成多个 chunk（模拟 TCP 分片）
// ============================================================

console.log("\n--- 模拟网络传输：拆分为多个 TCP chunk ---\n");

const chunks = [
  rawSSEBytes.slice(0, 30), // chunk 1: 可能在行中间截断
  rawSSEBytes.slice(30, 80), // chunk 2
  rawSSEBytes.slice(80, 150), // chunk 3
  rawSSEBytes.slice(150), // chunk 4: 剩余部分
];

const parser = new SSEParser();

for (let i = 0; i < chunks.length; i++) {
  console.log(`[TCP Chunk ${i + 1}] ${chunks[i].length} 字节: ${JSON.stringify(chunks[i])}`);
  const events = parser.feed(chunks[i]);
  if (events.length > 0) {
    for (const event of events) {
      console.log(`  → 触发事件: type="${event.type}" data=${JSON.stringify(event.data)} id="${event.lastEventId}"`);
    }
  } else {
    console.log("  → (无完整事件)");
  }
  console.log();
}

// ============================================================
// 演示 2: OpenAI 格式的原始 SSE
// ============================================================

console.log("\n" + "=".repeat(60));
console.log("OpenAI 流式响应的原始 SSE 格式");
console.log("=".repeat(60));

const openaiRawSSE = `data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" How"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

`;

console.log("\n原始 SSE 文本:");
console.log("┌─────────────────────────────────────────");
for (const line of openaiRawSSE.split("\n")) {
  console.log(`│ ${line}`);
}
console.log("└─────────────────────────────────────────");

console.log("\n--- 解析 OpenAI SSE ---\n");

const openaiParser = new SSEParser();
const openaiEvents = openaiParser.feed(openaiRawSSE);

let assembledContent = "";

for (let i = 0; i < openaiEvents.length; i++) {
  const event = openaiEvents[i];
  console.log(`Event[${i}]: type="${event.type}"`);
  console.log(`  data: ${event.data}`);

  if (event.data === "[DONE]") {
    console.log("  → 流结束标记");
    continue;
  }

  try {
    const chunk = JSON.parse(event.data);
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) {
      assembledContent += delta.content;
      console.log(`  → content token: "${delta.content}" → 累计: "${assembledContent}"`);
    } else if (delta?.role) {
      console.log(`  → role: "${delta.role}"`);
    }
    if (chunk.choices?.[0]?.finish_reason) {
      console.log(`  → finish_reason: "${chunk.choices[0].finish_reason}"`);
    }
  } catch {}
  console.log();
}

console.log("=".repeat(60));
console.log(`最终组装的完整回复: "${assembledContent}"`);
console.log("=".repeat(60));

// ============================================================
// 关键概念总结
// ============================================================

console.log(`
==========================================================
SSE 协议关键点总结
==========================================================

1. HTTP 层面:
   - Content-Type: text/event-stream
   - 普通 HTTP 响应，只是 body 持续发送不关闭
   - 不需要 WebSocket，纯 HTTP/1.1 就能工作

2. 数据格式 (每个事件):
   ┌──────────────────────────────────────┐
   │ [id: <事件ID>]         ← 可选        │
   │ [event: <事件类型>]    ← 可选        │
   │ [retry: <毫秒>]       ← 可选        │
   │ data: <第1行数据>      ← 至少一行    │
   │ [data: <第2行数据>]    ← 可选多行    │
   │                        ← 空行=结束   │
   └──────────────────────────────────────┘

3. 特殊行:
   - : 开头 → 注释，客户端忽略（可用作心跳）
   - 空行 → 事件分隔符

4. 浏览器 EventSource API:
   - new EventSource("/sse") 自动处理连接
   - .onmessage → 接收 type="message" 的事件
   - .addEventListener("custom", ...) → 自定义事件
   - 自动重连（使用 Last-Event-ID 头）

5. OpenAI 特殊约定:
   - 只使用 data: 字段（不用 event/id）
   - 每个 data 是一行 JSON（chat.completion.chunk）
   - 流结束发送 "data: [DONE]"
   - delta 对象逐步拼出完整的 assistant 消息
`);
