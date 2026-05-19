import http from 'node:http';
import { ProxyAgent, request } from 'undici';

const listenHost = process.env.FORWARDER_HOST || '127.0.0.1';
const listenPort = Number(process.env.FORWARDER_PORT || 9001);
const upstream = process.env.OPENAI_UPSTREAM || 'https://api.openai.com';
const proxy = process.env.OUTBOUND_PROXY || 'http://127.0.0.1:10809';
const agent = new ProxyAgent(proxy);

function copyHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (['host', 'connection', 'content-length'].includes(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const upstreamRes = await request(`${upstream}${req.url}`, {
      method: req.method,
      headers: copyHeaders(req.headers),
      body,
      dispatcher: agent,
      bodyTimeout: 0,
      headersTimeout: 120_000,
    });

    res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
    for await (const chunk of upstreamRes.body) res.write(chunk);
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `forwarder upstream failed: ${message}`, type: 'api_error' } }));
  }
});

server.listen(listenPort, listenHost, () => {
  console.log(`OpenAI forwarder listening on http://${listenHost}:${listenPort}`);
  console.log(`Upstream: ${upstream}`);
  console.log(`Proxy: ${proxy}`);
});
