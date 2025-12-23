// 使用 Node.js 內建的 http 模組（不需要安裝任何套件）
const http = require("http");

// 建立一個 server
const server = http.createServer((req, res) => {
  // 不管使用者打什麼網址，都回 OK
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
});

// 讓 server 在 3000 port 啟動
server.listen(3000, () => {
  console.log("Server is running at http://localhost:3000");
});
