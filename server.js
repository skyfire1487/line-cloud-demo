// // 使用 Node 內建 http/https，不靠額外套件，最穩最少坑
const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;

// // 從Render的Environment Variables讀取LINE的Channel access token
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

// ★ 新增：從Render的Environment Variables讀取RAG的Base URL
// 1️⃣ 這是什麼：RAG服務的「根網址」(例如https://rag-agent-903v.onrender.com)
// 2️⃣ 為什麼現在要做：chat/remind要轉送到RAG的POST/chat，不能寫死在程式碼
// 3️⃣ 做了會改變什麼：LINE聊天訊息會被轉送到RAG，拿到reply後再回覆LINE
const RAG_BASE_URL = process.env.RAG_BASE_URL || "";

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

// ★ 新增：呼叫RAG的POST/chat，拿回reply文字
// 1️⃣ 這是什麼：用HTTP把使用者文字送到RAG服務
// 2️⃣ 為什麼現在要做：你不做AI，只做「轉送」與「回傳結果」
// 3️⃣ 做了會改變什麼：cmd=chat或remind時，LINE收到的是RAG的回覆而不是「收到：xxx」
function callRagChat(userId, text, cb) {
  if (!RAG_BASE_URL) {
    return cb(new Error("Missing RAG_BASE_URL"));
  }

  // 把Base URL組成真正的API URL：{RAG_BASE_URL}/chat
  let u;
  try {
    u = new URL(RAG_BASE_URL.replace(/\/+$/, "") + "/chat");
  } catch (e) {
    return cb(new Error("Invalid RAG_BASE_URL"));
  }

  // 依你RAG服務顯示的routes: POST/chat，常見格式是user_id+text
  const postData = JSON.stringify({
    user_id: userId,
    text: text,
  });

  const isHttps = u.protocol === "https:";
  const lib = isHttps ? https : http;

  const options = {
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + (u.search || ""),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData),
    },
  };

  const req = lib.request(options, (resp) => {
    let data = "";
    resp.on("data", (chunk) => (data += chunk));
    resp.on("end", () => {
      // 不是2xx就當作失敗，把回傳內容帶回去方便你看錯誤
      if (!(resp.statusCode >= 200 && resp.statusCode < 300)) {
        return cb(new Error(`RAG HTTP ${resp.statusCode}: ${data}`));
      }

      // 預期RAG回傳JSON，例如{ "reply": "..." }
      let obj = {};
      try {
        obj = JSON.parse(data || "{}");
      } catch (e) {
        obj = {};
      }

      const reply = (obj.reply || "").toString();
      return cb(null, reply);
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

    // 這裡回204的意思：
    // 1️⃣ 這是什麼：HTTP 204=No Content，代表「目前沒有新控制指令給你」
    // 2️⃣ 為什麼要做：Zenbo一直poll時，沒新指令就不用回JSON，省流量也清楚
    // 3️⃣ 做了會改變什麼：Android端看到204就知道「不用做事，等下次再問」
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

      // 先回200給LINE，避免LINE重送
      sendJson(res, 200, { ok: true });

      // 沒有replyToken就不能回覆LINE
      if (!replyToken) return;

      // 控制類：維持你原本行為（回收到指令）
      if (cmd === "spin" || cmd === "follow" || cmd === "stop") {
        return lineReply(replyToken, [{ type: "text", text: `收到指令：${cmd}` }], () => {});
      }

      // ★ 新增：chat/remind轉送RAG
      // 1️⃣ 這是什麼：把userText送到RAG的POST/chat，拿reply回覆LINE
      // 2️⃣ 為什麼現在要做：你要把聊天交給RAG同學處理，不在你這層做AI
      // 3️⃣ 做了會改變什麼：LINE使用者輸入一般句子或「提醒」，會收到RAG的回答
      if (cmd === "chat" || cmd === "remind") {
        // 用LINE的userId當user_id，讓RAG可以分辨不同使用者
        const userId = (evt.source && evt.source.userId) ? evt.source.userId : "line_user";

        return callRagChat(userId, userText, (err, reply) => {
          // RAG失敗時給保底訊息，避免demo看起來像整個壞掉
          if (err) {
            const fallback = `（RAG暫時無法使用）\n${err.message}`;
            return lineReply(replyToken, [{ type: "text", text: fallback }], () => {});
          }

          const text = reply && reply.trim() ? reply : "（RAG沒有回傳reply）";
          return lineReply(replyToken, [{ type: "text", text }], () => {});
        });
      }

      // 其他：維持原本行為
      const replyText =
        cmd === "chat"
          ? `收到：${userText}`
          : `收到指令：${cmd}`;

      return lineReply(replyToken, [{ type: "text", text: replyText }], () => {});
    });
  }

  return sendText(res, 404, "Not Found");
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
