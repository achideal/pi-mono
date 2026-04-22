/**
 * 模拟 OpenAI Chat Completions 流式响应的 SSE 服务端
 *
 * 真实的 OpenAI API 返回的原始字节流就是这个格式。
 * 这里模拟 POST /v1/chat/completions (stream: true) 的响应。
 */

import http from "node:http";

// ============================================================
// OpenAI 流式响应的原始 SSE 数据
// 注意：OpenAI 不使用 event: 或 id: 字段，只使用 data: 字段
// ============================================================

function createOpenAIChatCompletionChunks(): string[] {
  const id = "chatcmpl-abc123def456";
  const created = Math.floor(Date.now() / 1000);

  // 模拟回答 "Hello! How can I help you today?"
  // OpenAI 把回答拆成多个 token 逐个发送
  const tokens = ["Hello", "!", " How", " can", " I", " help", " you", " today", "?"];

  const chunks: string[] = [];

  // --- Chunk 0: 角色声明（role chunk）---
  // 第一个 chunk 包含 role 但 content 为空
  chunks.push(
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: "gpt-4o-2024-05-13",
      system_fingerprint: "fp_abc123",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: "",
          },
          logprobs: null,
          finish_reason: null,
        },
      ],
    }),
  );

  // --- Chunk 1~N: 内容 token ---
  for (const token of tokens) {
    chunks.push(
      JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: "gpt-4o-2024-05-13",
        system_fingerprint: "fp_abc123",
        choices: [
          {
            index: 0,
            delta: {
              content: token,
            },
            logprobs: null,
            finish_reason: null,
          },
        ],
      }),
    );
  }

  // --- 最后一个 Chunk: finish_reason ---
  chunks.push(
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: "gpt-4o-2024-05-13",
      system_fingerprint: "fp_abc123",
      choices: [
        {
          index: 0,
          delta: {},
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 9,
        completion_tokens: 9,
        total_tokens: 18,
      },
    }),
  );

  return chunks;
}

// ============================================================
// OpenAI Tool Call 流式响应
// ============================================================

function createOpenAIToolCallChunks(): string[] {
  const id = "chatcmpl-tool789";
  const created = Math.floor(Date.now() / 1000);

  const chunks: string[] = [];

  // --- Chunk 0: 角色 + tool_calls 开始 ---
  chunks.push(
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                index: 0,
                id: "call_abc123",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: "",
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
  );

  // --- Chunk 1~N: tool_call arguments 逐步流出 ---
  const argParts = ['{"', "location", '":"', "San ", "Fran", "cisco", '"}'];
  for (const part of argParts) {
    chunks.push(
      JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: part,
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
  }

  // --- 最后: finish_reason = "tool_calls" ---
  chunks.push(
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "tool_calls",
        },
      ],
    }),
  );

  return chunks;
}

// ============================================================
// HTTP Server
// ============================================================

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    // 读取请求体判断是否请求 tool_calls
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    let useToolCalls = false;
    try {
      const parsed = JSON.parse(body);
      useToolCalls = parsed.tools && parsed.tools.length > 0;
    } catch {}

    // 设置 SSE 响应头（和 OpenAI 真实响应一致）
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const chunks = useToolCalls ? createOpenAIToolCallChunks() : createOpenAIChatCompletionChunks();

    console.log("\n========== OpenAI SSE 原始响应 ==========\n");

    // 逐个发送 chunk
    for (let i = 0; i < chunks.length; i++) {
      // OpenAI 格式: "data: {json}\n\n"
      // 注意：没有 event: 字段，没有 id: 字段
      const sseFrame = `data: ${chunks[i]}\n\n`;

      console.log(`[Chunk ${i}] 发送 ${sseFrame.length} 字节:`);
      console.log(sseFrame);

      res.write(sseFrame);
      // 模拟 token 生成延迟
      await new Promise((r) => setTimeout(r, 100));
    }

    // OpenAI 流结束标记: "data: [DONE]\n\n"
    const doneFrame = "data: [DONE]\n\n";
    console.log(`[DONE] 发送结束标记:`);
    console.log(doneFrame);
    res.write(doneFrame);
    res.end();
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <h1>OpenAI Mock SSE Server</h1>
      <p>POST /v1/chat/completions</p>
      <p>用 <code>npm run openai-client</code> 来测试</p>
    `);
  }
});

const PORT = 3457;
server.listen(PORT, () => {
  console.log(`OpenAI Mock Server running at http://localhost:${PORT}`);
  console.log("Endpoint: POST http://localhost:${PORT}/v1/chat/completions");
});
