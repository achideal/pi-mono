/**
 * SSE 服务端示例
 *
 * 演示 HTTP SSE 的原始数据格式：
 * - Content-Type: text/event-stream
 * - 每个事件由 "data: ...\n\n" 组成
 * - 可选的 event:, id:, retry: 字段
 */

import http from "node:http";

const server = http.createServer((req, res) => {
  // CORS 支持（方便浏览器调试）
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.url === "/basic") {
    // ============================================================
    // 示例 1: 最基础的 SSE —— 只有 data 字段
    // ============================================================
    res.writeHead(200, {
      "Content-Type": "text/event-stream", // 必须是这个 MIME 类型
      "Cache-Control": "no-cache", // 禁止缓存
      Connection: "keep-alive", // 保持长连接
    });

    let count = 0;
    const interval = setInterval(() => {
      count++;
      // 原始格式: "data: <内容>\n\n"
      // 两个换行符 \n\n 表示一个事件的结束
      const raw = `data: Hello ${count}\n\n`;
      console.log(`[发送原始字节] ${JSON.stringify(raw)}`);
      res.write(raw);

      if (count >= 5) {
        clearInterval(interval);
        res.end();
      }
    }, 500);
  } else if (req.url === "/full-format") {
    // ============================================================
    // 示例 2: 完整 SSE 格式 —— 所有字段
    // ============================================================
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // --- 事件 1: 带 id 和 event 类型 ---
    // 原始字节流：
    //   id: 1\n
    //   event: message\n
    //   data: {"text":"first event"}\n
    //   \n
    const event1 = [
      "id: 1", //          事件ID，用于断线重连时的 Last-Event-ID
      "event: message", //  事件类型，客户端用 addEventListener("message", ...) 监听
      'data: {"text":"first event"}', // 事件数据
      "", //                空行，表示事件结束
      "", //                （最后一个空行产生 \n\n）
    ].join("\n");
    console.log("[发送事件1 原始字节]:");
    console.log(event1);
    console.log("---");
    res.write(event1);

    setTimeout(() => {
      // --- 事件 2: 自定义事件类型 ---
      const event2 = [
        "id: 2",
        "event: custom-event", // 自定义类型，客户端需要 addEventListener("custom-event", ...)
        'data: {"type":"custom","value":42}',
        "",
        "",
      ].join("\n");
      console.log("[发送事件2 原始字节]:");
      console.log(event2);
      console.log("---");
      res.write(event2);
    }, 500);

    setTimeout(() => {
      // --- 事件 3: 多行 data ---
      // 多行数据：每行都要加 data: 前缀
      // 客户端收到后会用 \n 拼接各行
      const event3 = [
        "id: 3",
        "event: multiline",
        "data: line 1 of the message",
        "data: line 2 of the message",
        "data: line 3 of the message",
        "",
        "",
      ].join("\n");
      console.log("[发送事件3 多行data 原始字节]:");
      console.log(event3);
      console.log("---");
      res.write(event3);
    }, 1000);

    setTimeout(() => {
      // --- 事件 4: 带 retry 字段 ---
      // retry 告诉客户端断线后多少毫秒重连
      const event4 = [
        "retry: 3000", // 3秒后重连
        "id: 4",
        "event: message",
        'data: {"text":"with retry field"}',
        "",
        "",
      ].join("\n");
      console.log("[发送事件4 带retry 原始字节]:");
      console.log(event4);
      console.log("---");
      res.write(event4);
      res.end();
    }, 1500);
  } else if (req.url === "/comments-and-keepalive") {
    // ============================================================
    // 示例 3: 注释行和心跳保活
    // ============================================================
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // 注释行：以冒号 : 开头，客户端会忽略，常用于心跳保活
    res.write(": this is a comment, client will ignore it\n\n");
    console.log('[发送注释行] ": this is a comment..."');

    let count = 0;
    const interval = setInterval(() => {
      count++;
      if (count % 2 === 0) {
        // 心跳：发送空注释保持连接
        res.write(":\n\n");
        console.log("[发送心跳] :");
      } else {
        res.write(`data: tick ${count}\n\n`);
        console.log(`[发送数据] data: tick ${count}`);
      }
      if (count >= 6) {
        clearInterval(interval);
        res.end();
      }
    }, 500);
  } else {
    // 首页：返回端点列表
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <h1>SSE Demo Server</h1>
      <ul>
        <li><a href="/basic">/basic</a> - 最基础的 SSE</li>
        <li><a href="/full-format">/full-format</a> - 完整 SSE 格式（id, event, data, retry）</li>
        <li><a href="/comments-and-keepalive">/comments-and-keepalive</a> - 注释和心跳</li>
      </ul>
      <p>用 <code>npm run client</code> 或 curl 来查看原始数据</p>
    `);
  }
});

const PORT = 3456;
server.listen(PORT, () => {
  console.log(`SSE Demo Server running at http://localhost:${PORT}`);
  console.log("Endpoints:");
  console.log(`  http://localhost:${PORT}/basic`);
  console.log(`  http://localhost:${PORT}/full-format`);
  console.log(`  http://localhost:${PORT}/comments-and-keepalive`);
});
