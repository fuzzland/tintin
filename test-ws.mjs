import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:9393/api/ws/chat');

ws.on('open', () => {
  console.log('✅ Connected');
  ws.send(JSON.stringify({ type: 'auth' }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('📥 Received:', JSON.stringify(msg, null, 2));

  if (msg.type === 'auth_ok') {
    console.log('✅ Auth OK, testing ping...');
    ws.send(JSON.stringify({ type: 'ping' }));
  }

  if (msg.type === 'pong') {
    console.log('✅ Pong received, sending chat...');
    // Use the configured project ID "tintin"
    ws.send(JSON.stringify({
      type: 'chat',
      projectId: 'tintin',
      messages: [{ role: 'user', content: 'list files in current directory' }]
    }));
  }

  if (msg.type === 'session_started') {
    console.log('✅ Session started:', msg.sessionId);
  }

  if (msg.type === 'done') {
    console.log('✅ Session complete');
    ws.close();
  }

  if (msg.type === 'error' && msg.code !== 'INVALID_MESSAGE') {
    console.log('⚠️ Error:', msg.message);
  }
});

ws.on('error', (err) => console.error('❌ Error:', err.message));
ws.on('close', (code, reason) => console.log('🔌 Closed:', code, reason.toString()));
