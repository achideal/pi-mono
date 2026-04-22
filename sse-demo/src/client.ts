/**
 * SSE 客户端示例
 *
 * 演示：
 * 1. 接收 HTTP 响应的原始字节流
 * 2. 打印原始字节（hex + text）
 * 3. 手动解析为 SSE 事件
 */

// ============================================================
// 第一步：展示原始 HTTP 响应字节
// ============================================================
async function showRawBytes(endpoint: string) {
  console.log("=".repeat(60));
  console.log(`请求: http://localhost:3456${endpoint}`);
  console.log("=".repeat(60));

  const response = await fetch(`http://localhost:3456${endpoint}`);

  console.log("\n--- HTTP 响应头 ---");
  for (const [key, value] of response.headers.entries()) {
    console.log(`  ${key}: ${value}`);
  }

  console.log("\n--- 原始字节流（逐 chunk 到达） ---\n");

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let chunkIndex = 0;
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value, { stream: true });
    fullText += text;
    chunkIndex++;

    console.log(`  [Chunk #${chunkIndex}] ${value.byteLength} bytes`);
    console.log(`  Hex: ${Buffer.from(value).toString("hex").match(/../g)!.join(" ")}`);
    console.log(`  Text: ${JSON.stringify(text)}`);
    console.log();
  }

  return fullText;
}

// ============================================================
// 第二步：手动实现 SSE 解析器（展示解析逻辑）
// ============================================================
interface SSEEvent {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}

function parseSSEStream(rawText: string): SSEEvent[] {
  const events: SSEEvent[] = [];

  // SSE 规范：事件之间用空行（\n\n）分隔
  // 每个事件由若干 "field: value\n" 行组成
  const blocks = rawText.split("\n\n");

  console.log("--- SSE 解析过程 ---\n");
  console.log(`原始文本被 "\\n\\n" 分割为 ${blocks.length} 个块:\n`);

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim();
    if (!block) {
      console.log(`  块[${i}]: (空块, 跳过)`);
      continue;
    }

    console.log(`  块[${i}]:`);
    console.log(`    原始: ${JSON.stringify(block)}`);

    const event: SSEEvent = { data: "" };
    const lines = block.split("\n");
    const dataLines: string[] = [];

    for (const line of lines) {
      // 注释行：以 : 开头
      if (line.startsWith(":")) {
        console.log(`    行: ${JSON.stringify(line)} → 注释, 忽略`);
        continue;
      }

      // 解析 "field: value" 或 "field:value"
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) {
        console.log(`    行: ${JSON.stringify(line)} → 无冒号, 忽略`);
        continue;
      }

      const field = line.slice(0, colonIndex);
      // 冒号后的第一个空格是可选的，规范要求跳过
      let value = line.slice(colonIndex + 1);
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }

      switch (field) {
        case "data":
          dataLines.push(value);
          console.log(`    行: ${JSON.stringify(line)} → data="${value}"`);
          break;
        case "event":
          event.event = value;
          console.log(`    行: ${JSON.stringify(line)} → event="${value}"`);
          break;
        case "id":
          event.id = value;
          console.log(`    行: ${JSON.stringify(line)} → id="${value}"`);
          break;
        case "retry":
          event.retry = Number.parseInt(value, 10);
          console.log(`    行: ${JSON.stringify(line)} → retry=${value}`);
          break;
        default:
          console.log(`    行: ${JSON.stringify(line)} → 未知字段 "${field}", 忽略`);
      }
    }

    // 多行 data 用 \n 拼接
    if (dataLines.length > 0) {
      event.data = dataLines.join("\n");
      events.push(event);
      console.log(`    → 解析结果: ${JSON.stringify(event)}`);
    }
    console.log();
  }

  return events;
}

// ============================================================
// 运行
// ============================================================
async function main() {
  const endpoint = process.argv[2] || "/full-format";

  try {
    const rawText = await showRawBytes(endpoint);
    console.log("\n" + "=".repeat(60));
    console.log("解析原始文本为 SSE 事件");
    console.log("=".repeat(60) + "\n");

    const events = parseSSEStream(rawText);

    console.log("--- 最终解析出的事件列表 ---\n");
    for (let i = 0; i < events.length; i++) {
      console.log(`Event[${i}]:`, JSON.stringify(events[i], null, 2));
    }
  } catch (e) {
    console.error("连接失败，请先运行: npm run server");
    console.error(e);
  }
}

main();
