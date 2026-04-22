/**
 * OpenAI 流式响应客户端
 *
 * 演示从原始 SSE 字节流 → 解析出 OpenAI chunk → 组装最终消息的完整过程
 */

// ============================================================
// 第一步：发送请求，接收原始字节流
// ============================================================
async function streamChatCompletion(useTools: boolean) {
  const requestBody: Record<string, unknown> = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello!" }],
    stream: true,
  };

  if (useTools) {
    requestBody.tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather for a location",
          parameters: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
          },
        },
      },
    ];
  }

  console.log("=".repeat(60));
  console.log(useTools ? "OpenAI Tool Call 流式响应" : "OpenAI 文本流式响应");
  console.log("=".repeat(60));
  console.log("\n--- 发送请求 ---");
  console.log(JSON.stringify(requestBody, null, 2));

  const response = await fetch("http://localhost:3457/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer sk-fake-key",
    },
    body: JSON.stringify(requestBody),
  });

  console.log("\n--- HTTP 响应头 ---");
  for (const [key, value] of response.headers.entries()) {
    console.log(`  ${key}: ${value}`);
  }

  // ============================================================
  // 第二步：逐 chunk 读取原始字节流
  // ============================================================
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chunkIndex = 0;

  // 用于组装最终结果
  let fullContent = "";
  let fullRole = "";
  const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

  console.log("\n--- 逐 Chunk 解析过程 ---\n");

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value, { stream: true });
    buffer += text;

    // SSE 以 \n\n 分割事件
    // buffer 中可能包含多个事件，也可能事件被截断
    const parts = buffer.split("\n\n");
    // 最后一个可能是不完整的，留在 buffer 中
    buffer = parts.pop()!;

    for (const part of parts) {
      if (!part.trim()) continue;

      chunkIndex++;
      console.log(`[Chunk #${chunkIndex}]`);
      console.log(`  原始 SSE 帧: ${JSON.stringify(part)}`);

      // 解析 SSE: 每行 "data: ..." 提取 data 部分
      for (const line of part.split("\n")) {
        if (line.startsWith("data: ")) {
          const dataStr = line.slice(6); // 去掉 "data: " 前缀

          // 检查是否是 [DONE] 标记
          if (dataStr === "[DONE]") {
            console.log("  data: [DONE] → 流结束");
            continue;
          }

          // 解析 JSON
          try {
            const chunk = JSON.parse(dataStr);
            const choice = chunk.choices?.[0];

            if (choice?.delta?.role) {
              fullRole = choice.delta.role;
              console.log(`  解析: role="${fullRole}"`);
            }

            if (choice?.delta?.content != null) {
              fullContent += choice.delta.content;
              console.log(`  解析: content="${choice.delta.content}" → 累计: "${fullContent}"`);
            }

            if (choice?.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                if (!toolCalls.has(tc.index)) {
                  toolCalls.set(tc.index, { id: tc.id || "", name: "", arguments: "" });
                }
                const existing = toolCalls.get(tc.index)!;
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                console.log(
                  `  解析: tool_call[${tc.index}] → id="${existing.id}" name="${existing.name}" args="${existing.arguments}"`,
                );
              }
            }

            if (choice?.finish_reason) {
              console.log(`  解析: finish_reason="${choice.finish_reason}"`);
            }

            if (chunk.usage) {
              console.log(
                `  解析: usage → prompt=${chunk.usage.prompt_tokens} completion=${chunk.usage.completion_tokens} total=${chunk.usage.total_tokens}`,
              );
            }
          } catch (e) {
            console.log(`  解析 JSON 失败: ${dataStr}`);
          }
        }
      }
      console.log();
    }
  }

  // ============================================================
  // 第三步：展示最终组装结果
  // ============================================================
  console.log("=".repeat(60));
  console.log("最终组装结果");
  console.log("=".repeat(60));

  if (fullContent) {
    console.log(`\n  role: ${fullRole}`);
    console.log(`  content: "${fullContent}"`);
  }

  if (toolCalls.size > 0) {
    console.log(`\n  role: ${fullRole}`);
    console.log("  tool_calls:");
    for (const [index, tc] of toolCalls) {
      console.log(`    [${index}] id=${tc.id} function=${tc.name}(${tc.arguments})`);
    }
  }
}

// ============================================================
// 运行
// ============================================================
async function main() {
  try {
    // 文本响应
    await streamChatCompletion(false);

    console.log("\n\n");

    // Tool call 响应
    await streamChatCompletion(true);
  } catch (e) {
    console.error("连接失败，请先运行: npm run openai-mock");
    console.error(e);
  }
}

main();
