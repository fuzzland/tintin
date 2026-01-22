import WebSocket from 'ws';

// Test: Send chat without auth first (should get AUTH_REQUIRED error)
const ws = new WebSocket('ws://localhost:9393/api/ws/chat');

ws.on('open', () => {
  console.log('✅ Connected');
  console.log('📤 Sending chat without auth...');
  ws.send(JSON.stringify({
    type: 'chat',
    projectId: 'tintin',
    messages: [{ role: 'user', content: 'hello' }]
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('📥 Received:', JSON.stringify(msg, null, 2));

  if (msg.type === 'error' && msg.code === 'AUTH_REQUIRED') {
    console.log('✅ AUTH_REQUIRED error received as expected');
    ws.close();
  }
});

ws.on('error', (err) => console.error('❌ Error:', err.message));
ws.on('close', (code, reason) => console.log('🔌 Closed:', code, reason.toString()));
