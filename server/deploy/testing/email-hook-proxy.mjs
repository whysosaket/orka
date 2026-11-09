// Test-only loopback bridge: GoTrue permits plain HTTP hooks only on localhost.
// Production uses the public HTTPS origin; never deploy this fixture there.
import { createServer, request } from 'node:http';
createServer((incoming, outgoing) => {
  const upstream = request('http://api:8080/auth/hooks/send-email', {
    method: incoming.method,
    headers: incoming.headers,
  }, response => {
    outgoing.writeHead(response.statusCode, response.headers);
    response.pipe(outgoing);
  });
  upstream.on('error', () => outgoing.writeHead(502).end());
  incoming.pipe(upstream);
}).listen(8081, '127.0.0.1');
