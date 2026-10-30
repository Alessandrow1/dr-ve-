// Barramento de eventos em tempo real (Server-Sent Events). Em produção: Redis pub/sub + WebSocket/SSE.
const channels = new Map();

export function subscribe(channel, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  if (!channels.has(channel)) channels.set(channel, new Set());
  channels.get(channel).add(res);
  const beat = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => {
    clearInterval(beat);
    const set = channels.get(channel);
    if (set) {
      set.delete(res);
      if (!set.size) channels.delete(channel);
    }
  });
}

export function publish(channel, event, data) {
  const set = channels.get(channel);
  if (!set) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(msg);
}

export function closeAll() {
  for (const set of channels.values()) for (const res of set) res.end();
  channels.clear();
}
