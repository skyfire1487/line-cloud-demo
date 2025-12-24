// // 使用 Node 內建 http/https，不靠額外套件，最穩最少坑
const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;

// // 從Render的Environment Variables讀取LINE的Channel access token
// // Why：token不能寫死在程式碼，避免外洩；Render用環境變數最安全也最方便
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

// // 記住最後一筆指令（存在記憶體即可，free方案夠用demo）
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

// // 超簡單指令解析：先用關鍵字，之後再進化成按鈕/選單
function parseCommand(text) {
  const t = (text || "").trim();
  if (t.includes("轉圈")) return "spin";
  if (t.includes("跟隨")) return "follow";
  if (t.includes("停止")) return "stop";
  if (t.includes("提醒")) return "remind";
  return "chat";
}

// // 呼叫LINE Reply API：用replyToken回覆使用者
// // Why：LINE webhook事件會帶replyToken，只能用它回覆該次訊息（有效期很短）
function lineReply(replyToken, messages, cb) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    return cb(new Error("Missing LINE_CHANNEL_ACCESS_TOKEN"));
  }

  const postData = JSON.stringify({
    replyToken,
    messages, // 例：[{ type:"text", text:"收到" }]
  });

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
      // // 200通常代表成功；不是200就把LINE回傳的錯誤印出來
      if (resp.statusCode >= 200 && resp.statusCode < 300) {
        return cb(null, { statusCode: resp.statusCode, body: data });
      }
      return cb(new Error(`LINE reply failed: ${resp.statusCode} ${data}`));
    });
  });

  req.on("error", (e) => cb(e));
  req.write(postData);
  req.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // // 健康檢查：用來喚醒Render free（避免demo時第一次等很久）
  if (req.method === "GET" && url.pathname === "/health") {
    return sendText(res, 200, "OK");
  }

  // // 讀取最後一筆指令（給Android/Zenbo或你自己測試）
  if (req.method === "GET" && url.pathname === "/last") {
    return sendJson(res, 200, lastCommand);
  }

  // // 你手動送指令（完全不靠LINE）
  if (req.method === "POST" && url.pathname === "/command") {
    return readBody(req, (raw) => {
      let obj = {};
      try {
        obj = JSON.parse(raw || "{}");
      } catch (e) {
        obj = { text: raw };
      }

      const text = obj.text || obj.command || "";
      const cmd = parseCommand(text);

      lastCommand = { command: cmd, source: "manual", raw: text, ts: Date.now() };
      console.log("[/command] set lastCommand =", lastCommand);

      return sendJson(res, 200, { ok: true, lastCommand });
    });
  }

  // // LINE webhook 入口：解析events → 更新lastCommand → 回覆LINE
  if (req.method === "POST" && url.pathname === "/webhook") {
    return readBody(req, (raw) => {
      let body = null;

      // // 1) 先把LINE送來的JSON解析出來
      // // Why：raw是一大串JSON字串，不解析就拿不到使用者文字與replyToken
      try {
        body = JSON.parse(raw || "{}");
      } catch (e) {
        console.log("[/webhook] JSON parse failed, raw =", raw.slice(0, 200));
        // // 依規格回200，避免LINE一直重送
        return sendJson(res, 200, { ok: true });
      }

      // // 2) LINE的事件通常在 body.events 陣列
      const evt = body.events && body.events[0];
      if (!evt) {
        return sendJson(res, 200, { ok: true });
      }

      // // 3) 只處理「文字訊息」
      const replyToken = evt.replyToken;
      const userText = evt.message && evt.message.type === "text" ? evt.message.text : "";

      const cmd = parseCommand(userText);

      lastCommand = {
        command: cmd,
        source: "line",
        raw: userText,
        ts: Date.now(),
      };

      console.log("[/webhook] userText =", userText);
      console.log("[/webhook] set lastCommand =", lastCommand);

      // // 4) 立刻回200給LINE（重要）
      // // Why：LINE要求你快速回應，慢了可能當作失敗
      sendJson(res, 200, { ok: true });

      // // 5) 再用Reply API回覆使用者（非阻塞，失敗也不影響webhook 200）
      // // 先做最簡單：回「收到指令：xxx」
      if (replyToken) {
        const replyText =
          cmd === "chat"
            ? `收到：${userText}\n（目前先不接AI，之後可改成轉給RAG回覆）`
            : `收到指令：${cmd}`;

        lineReply(
          replyToken,
          [{ type: "text", text: replyText }],
          (err, info) => {
            if (err) console.log("[LINE reply] error =", err.message);
            else console.log("[LINE reply] ok =", info.statusCode);
          }
        );
      }

      return;
    });
  }

  return sendText(res, 404, "Not Found");
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
