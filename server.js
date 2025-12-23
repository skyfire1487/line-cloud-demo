// 使用 Node.js 內建的 http 模組（不需要安裝任何套件）
const http = require("http");

// Render 會提供 PORT，沒提供時才用 3000（本機用）
const PORT = process.env.PORT || 3000;

// 建立一個 server
const server = http.createServer((req, res) => {
  // 不管使用者打什麼網址，都回 OK
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
});

// 讓 server 在指定的 PORT 啟動
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
