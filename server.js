// // 使用 Node 內建 http/https，不靠額外套件，最穩最少坑
const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;

// // 從Render的Environment Variables讀取LINE的Channel access token
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

// // 記住最後一筆指令
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

function parseCommand(text) {
  const t = (text || "").trim();
  if (t.includes("轉圈")) return "spin";
  if (t.includes("跟隨")) return "follow";
  if (t.includes("停止")) return "stop";
  if (t.includes("提醒")) return "remind";
  return "chat";
}

function lineReply(replyToken, messages, cb) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    return cb(new Error("Missing LINE_CHANNEL_ACCESS_TOKEN"));
  }

  const postData = JSON.stringify({ replyToken, messages });

  const options = {
    hostname: "api.line.me",
    path: "/v2/bot/message/reply",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Length": Buffer.byteLength(postData),
    },
  };

  const req = https.request(options, (resp) => {
    let data = "";
    resp.on("data", (chunk) => (data += chunk));
    resp.on("end", () => {
      if (resp.statusCode >= 200 && resp.statusCode < 300) {
        return cb(null, { statusCode: resp.statusCode });
      }
      return cb(new Error(`LINE reply failed`));
    });
  });

  req.on("error", (e) => cb(e));
  req.write(postData);
  req.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 健康檢查
  if (req.method === "GET" && url.pathname === "/health") {
    return sendText(res, 200, "OK");
  }

  // 讀取最後一筆（保留原功能）
  if (req.method === "GET" && url.pathname === "/last") {
    return sendJson(res, 200, lastCommand);
  }

  // ★ 新增：給 Android / Zenbo 拉取「控制指令」
  if (req.method === "GET" && url.pathname === "/pull") {
    const since = Number(url.searchParams.get("since") || 0);

    const isNew = lastCommand.ts > since;
    const isControl =
      lastCommand.command === "spin" ||
      lastCommand.command === "follow" ||
      lastCommand.command === "stop";

    if (!isNew || !isControl) {
      res.writeHead(204);
      return res.end();
    }

    return sendJson(res, 200, {
      id: `cmd_${lastCommand.ts}`,
      type: "control",
      command: lastCommand.command,
      text: lastCommand.raw,
      ts: lastCommand.ts,
    });
  }

  // 手動指令
  if (req.method === "POST" && url.pathname === "/command") {
    return readBody(req, (raw) => {
      let obj = {};
      try {
        obj = JSON.parse(raw || "{}");
      } catch {
        obj = { text: raw };
      }

      const text = obj.text || "";
      const cmd = parseCommand(text);

      lastCommand = {
        command: cmd,
        source: "manual",
        raw: text,
        ts: Date.now(),
      };

      return sendJson(res, 200, { ok: true, lastCommand });
    });
  }

  // LINE webhook
  if (req.method === "POST" && url.pathname === "/webhook") {
    return readBody(req, (raw) => {
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return sendJson(res, 200, { ok: true });
      }

      const evt = body.events && body.events[0];
      if (!evt) return sendJson(res, 200, { ok: true });

      const replyToken = evt.replyToken;
      const userText =
        evt.message && evt.message.type === "text" ? evt.message.text : "";

      const cmd = parseCommand(userText);

      lastCommand = {
        command: cmd,
        source: "line",
        raw: userText,
        ts: Date.now(),
      };

      sendJson(res, 200, { ok: true });

      if (replyToken) {
        const replyText =
          cmd === "chat"
            ? `收到：${userText}`
            : `收到指令：${cmd}`;

        lineReply(replyToken, [{ type: "text", text: replyText }], () => {});
      }
    });
  }

  return sendText(res, 404, "Not Found");
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
