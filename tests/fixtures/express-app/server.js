const http = require("http");

const port = Number(process.env.PORT || "3000");
const host = "0.0.0.0";

const responseBody = "e2e-app";

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(responseBody);
});

server.listen(port, host, () => {
  console.log(`listening ${host}:${port}`);
});
