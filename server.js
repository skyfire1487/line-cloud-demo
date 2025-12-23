const http = require("http");

const PORT = process.env.PORT || 3000;

// 記住最後一筆指令（先用記憶體，免費方案夠 demo）
let lastCommand = {
  command: "none",
  source: "init",
  raw: "",
  ts: Date.now(),
};

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readBody(req, cb) {
  let data = "";
  req.on("data", (chunk) => (data += chunk));
  req.on("end", () => cb(data));
}

// 超簡單指令解析：你之後要改成按鈕/格式也可以
function parseCommand(text) {
  const t = (text || "").trim();
  if (t.includes("轉圈")) return "spin";
  if (t.includes("跟隨")) return "follow";
  if (t.includes("停止")) return "stop";
  if (t.includes("提醒")) return "remind";
  return "chat"; // 其他都當聊天（可交給RAG）
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 健康檢查
  if (req.method === "GET" && url.pathname === "/health") {
    return sendText(res, 200, "OK");
  }

  // 讀取最後一筆指令（給 Android / 你自己測試）
  if (req.method === "GET" && url.pathname === "/last") {
    return sendJson(res, 200, lastCommand);
  }

  // 你自己手動送指令（完全不靠 LINE）
  if (req.method === "POST" && url.pathname === "/command") {
    return readBody(req, (raw) => {
      let obj = {};
      try {
        obj = JSON.parse(raw || "{}");
      } catch (e) {
        // JSON 壞掉也不讓你卡住
        obj = { text: raw };
      }
      const text = obj.text || obj.command || "";
      const cmd = parseCommand(text);

      lastCommand = {
        command: cmd,
        source: "manual",
        raw: text,
        ts: Date.now(),
      };

      console.log("[/command] set lastCommand =", lastCommand);
      return sendJson(res, 200, { ok: true, lastCommand });
    });
  }

  // LINE webhook 入口：先只做「收進來→更新 lastCommand → 回 200」
  if (req.method === "POST" && url.pathname === "/webhook") {
    return readBody(req, (raw) => {
      // 先不依賴 LINE 解析：只要能收到就成功
      const cmd = parseCommand(raw);

      lastCommand = {
        command: cmd,
        source: "line",
        raw: raw.slice(0, 300), // 避免 log 太大
        ts: Date.now(),
      };

      console.log("[/webhook] received raw =", raw.slice(0, 200));
      console.log("[/webhook] set lastCommand =", lastCommand);

      // LINE 只要你回 200 就算成功
      return sendJson(res, 200, { ok: true });
    });
  }

  return sendText(res, 404, "Not Found");
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
