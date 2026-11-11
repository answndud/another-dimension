import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, randomBytes } from 'node:crypto';
import { build } from 'esbuild';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
const sockets = new Set();
const published = [];
class FakeWebSocket {
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    sockets.add(this);
    setImmediate(() => { if (this.readyState === 0) { this.readyState = 1; this.emit('open', {}); } });
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  emit(type, event) { for (const fn of this.listeners.get(type) || []) fn(event); }
  send(raw) {
    const packet = JSON.parse(raw);
    if (packet[0] === 'REQ') {
      this.topic = packet[2]['#t'][0];
      setImmediate(() => this.emit('message', { data: JSON.stringify(['EOSE', packet[1]]) }));
    } else if (packet[0] === 'EVENT') {
      const event = packet[1];
      published.push(JSON.stringify(event));
      for (const socket of sockets) {
        if (socket.readyState === 1 && socket.url === this.url && socket.topic === event.tags[0][1]) {
          setImmediate(() => socket.emit('message', { data: JSON.stringify(['EVENT', 'room', event]) }));
        }
      }
    }
  }
  close() { this.readyState = 3; sockets.delete(this); setImmediate(() => this.emit('close', {})); }
}
globalThis.WebSocket = FakeWebSocket;
const result = await build({ entryPoints: ['src/relay-room.js'], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
const { RelayRoom } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));

function makeCode() { return `AD1-${randomBytes(64).toString('base64url')}`; }
function state(history = []) {
  const value = { online: false, statuses: [], messages: [], receipts: [], batches: [], history };
  value.handlers = {
    status: (status) => value.statuses.push(status),
    connected: (online) => { value.online = online; },
    message: (message) => value.messages.push(message),
    receipt: (receipt) => value.receipts.push(receipt),
    historySnapshot: () => ({ floor: null, messages: value.history }),
    historyBatch: (batch) => value.batches.push(batch),
    historyStatus: () => {},
  };
  return value;
}
async function waitFor(condition, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for peer state');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('authenticated peers exchange messages, history and read receipts; a third is rejected', async () => {
  const code = makeCode();
  const oldMessages = Array.from({ length: 45 }, (_, index) => ({
    id: index.toString(16).padStart(32, '0'), text: `earlier-${index}`, at: Date.now() + index, mine: true, read: false,
  }));
  const a = state(oldMessages);
  const b = state();
  const c = state();
  const rooms = [];
  try {
    const one = await RelayRoom.create(code, a.handlers);
    const two = await RelayRoom.create(code, b.handlers);
    rooms.push(one, two);
    one.start(); two.start();
    await waitFor(() => a.online && b.online);
    await waitFor(() => b.batches.flatMap((batch) => batch.messages).length === oldMessages.length);
    const secretText = `message-${randomBytes(16).toString('hex')}`;
    const sent = one.sendMessage(secretText);
    assert.ok(sent);
    const sentEvent = JSON.parse(published.at(-1));
    await waitFor(() => b.messages.some((entry) => entry.id === sent.id));
    assert.ok(published.every((event) => !event.includes(secretText) && !event.includes(code)));
    for (const socket of sockets) {
      if (socket.topic === one.topic) socket.emit('message', { data: JSON.stringify(['EVENT', 'room', sentEvent]) });
    }
    assert.equal(b.messages.filter((entry) => entry.id === sent.id).length, 1);
    assert.equal(two.sendReadBatch([sent.id]), true);
    await waitFor(() => a.receipts.some((entry) => entry.id === sent.id && entry.type === 'read'));
    const outsiderState = state();
    const outsider = new RelayRoom(one.topic, randomBytes(32), outsiderState.handlers);
    rooms.push(outsider);
    outsider.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    outsider.hello();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(one.peer?.id, two.id);
    assert.equal(two.peer?.id, one.id);
    assert.equal(outsider.peer, null);
    assert.equal(outsiderState.online, false);
    assert.equal(outsiderState.statuses.includes('이미 연결되어 있습니다'), false);
    outsider.close();
    const three = await RelayRoom.create(code, c.handlers);
    rooms.push(three);
    three.start();
    await waitFor(() => c.statuses.includes('이미 연결되어 있습니다'));
    assert.equal(c.online, false);
    assert.equal(a.online && b.online, true);
  } finally {
    for (const room of rooms) room.close();
  }
});

test('different room codes do not connect', async () => {
  const a = state(); const b = state();
  const one = await RelayRoom.create(makeCode(), a.handlers);
  const two = await RelayRoom.create(makeCode(), b.handlers);
  try {
    one.start(); two.start();
    assert.equal(one.sendMessage('offline'), null);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(a.online || b.online, false);
  } finally { one.close(); two.close(); }
});

test('retries a lost message and receipt using the same logical id', async () => {
  const code = makeCode(); const a = state(); const b = state();
  const one = await RelayRoom.create(code, a.handlers); const two = await RelayRoom.create(code, b.handlers);
  const received = new Map();
  b.handlers.message = (message) => { received.set(message.id, message); return true; };
  try {
    one.start(); two.start(); await waitFor(() => a.online && b.online);
    const originalSend = one.sendPayload.bind(one); const ids = []; let dropMessage = true;
    one.sendPayload = (payload, relayOnly) => {
      if (payload.type === 'message') { ids.push(payload.id); if (dropMessage) { dropMessage = false; return true; } }
      return originalSend(payload, relayOnly);
    };
    const originalReply = two.sendPayload.bind(two); let dropReceipt = true;
    two.sendPayload = (payload, relayOnly) => {
      if (payload.type === 'delivered' && dropReceipt) { dropReceipt = false; return true; }
      return originalReply(payload, relayOnly);
    };
    const message = one.sendMessage('retry'); const pending = one.pendingMessages.get(message.id);
    clearTimeout(pending.timer); one.attemptMessage(pending); await waitFor(() => received.size === 1);
    clearTimeout(pending.timer); one.attemptMessage(pending);
    await waitFor(() => a.receipts.some((receipt) => receipt.id === message.id && receipt.type === 'delivered'));
    assert.deepEqual(ids, [message.id, message.id, message.id]);
    assert.equal(received.size, 1); assert.equal(one.pendingMessages.size, 0);
  } finally { one.close(); two.close(); }
});

test('disconnect stops pending retries and manual retry retains the message id', async () => {
  const code = makeCode(); const a = state(); const b = state();
  const one = await RelayRoom.create(code, a.handlers); const two = await RelayRoom.create(code, b.handlers);
  try {
    one.start(); two.start(); await waitFor(() => a.online && b.online);
    const send = one.sendPayload.bind(one);
    one.sendPayload = (payload, relayOnly) => payload.type === 'message' ? true : send(payload, relayOnly);
    const message = one.sendMessage('pending'); one.resetPeer(false);
    assert.equal(one.pendingMessages.size, 0);
    assert.ok(a.receipts.some((receipt) => receipt.id === message.id && receipt.type === 'uncertain'));
    assert.equal(one.retryMessage(message), false); one.sendPayload = send;
    two.resetPeer(false);
    await waitFor(() => a.online && b.online);
    assert.equal(one.retryMessage(message), true);
    await waitFor(() => b.messages.some((entry) => entry.id === message.id));
    await waitFor(() => a.receipts.some((entry) => entry.id === message.id && entry.type === 'delivered'));
  } finally { one.close(); two.close(); }
});

test('buffered direct channel falls back to relay and rejection blocks that relay', async () => {
  const code = makeCode(); const a = state(); const b = state();
  const one = await RelayRoom.create(code, a.handlers); const two = await RelayRoom.create(code, b.handlers);
  try {
    one.start(); two.start(); await waitFor(() => a.online && b.online);
    let directSent = false;
    one.peer.channel = { readyState: 'open', bufferedAmount: 300000, send: () => { directSent = true; }, close() {} };
    const message = one.sendMessage('fallback');
    await waitFor(() => b.messages.some((entry) => entry.id === message.id));
    assert.equal(directSent, false);
    const socket = [...one.sockets.values()][0];
    socket.emit('message', { data: JSON.stringify(['OK', 'unknown-id', false, 'rate-limited: slow down']) });
    assert.equal(socket.blockedUntil, undefined);
    socket.emit('message', { data: JSON.stringify(['OK', [...one.publishedEvents].at(-1), false, 'rate-limited: slow down']) });
    assert.ok(socket.blockedUntil > Date.now());
  } finally { one.close(); two.close(); }
});


test('unconfirmed messages become uncertain after bounded attempts', async () => {
  const code = makeCode(); const a = state(); const b = state();
  const one = await RelayRoom.create(code, a.handlers); const two = await RelayRoom.create(code, b.handlers);
  try {
    one.start(); two.start(); await waitFor(() => a.online && b.online);
    const send = one.sendPayload.bind(one);
    one.sendPayload = (payload, relayOnly) => payload.type === 'message' ? true : send(payload, relayOnly);
    const message = one.sendMessage('lost'); const pending = one.pendingMessages.get(message.id);
    for (let i = 0; i < 4; i++) { clearTimeout(pending.timer); one.attemptMessage(pending); }
    assert.equal(one.pendingMessages.size, 0);
    assert.ok(a.receipts.some((receipt) => receipt.id === message.id && receipt.type === 'uncertain'));
    assert.ok(!a.receipts.some((receipt) => receipt.id === message.id && receipt.type === 'delivered'));
  } finally { one.close(); two.close(); }
});

test('history recovers lost batches and acknowledgements while new messages arrive', async () => {
  const code = makeCode();
  const history = Array.from({ length: 25 }, (_, index) => ({
    id: index.toString(16).padStart(32, '0'), text: `history-${index}`, at: 1000 + index, mine: true, read: false,
  }));
  const a = state(history); const b = state();
  const one = await RelayRoom.create(code, a.handlers); const two = await RelayRoom.create(code, b.handlers);
  try {
    one.start(); two.start(); await waitFor(() => a.online && b.online);
    const sendOne = one.sendPayload.bind(one); const sendTwo = two.sendPayload.bind(two);
    let dropBatch = true; let dropAck = true;
    one.sendPayload = (payload, relayOnly) => {
      if (payload.type === 'history-batch' && dropBatch) { dropBatch = false; return true; }
      return sendOne(payload, relayOnly);
    };
    two.sendPayload = (payload, relayOnly) => {
      if (payload.type === 'history-ack' && dropAck) { dropAck = false; return true; }
      return sendTwo(payload, relayOnly);
    };
    const incoming = two.peer.historyIncoming;
    clearTimeout(incoming.timer);
    one.handleHistoryRequest({ request: incoming.id });
    const outgoing = one.peer.historyOutgoing;
    assert.equal(b.batches.length, 0);
    clearTimeout(outgoing.timer); one.sendHistoryBatch(one.peer, outgoing);
    await waitFor(() => b.batches.length === 1);
    const live = one.sendMessage('new during sync');
    await waitFor(() => b.messages.some((entry) => entry.id === live.id));
    clearTimeout(outgoing.timer); one.sendHistoryBatch(one.peer, outgoing);
    await waitFor(() => incoming.done);
    assert.deepEqual(b.batches.flatMap((batch) => batch.messages).map((entry) => entry.id), history.map((entry) => entry.id));
    const count = b.batches.length;
    two.handleHistoryBatch({ request: incoming.id, index: incoming.expected, entries: [history[0]], floor: null, done: true });
    assert.equal(b.batches.length, count);
  } finally { one.close(); two.close(); }
});

test('a new room session restores the history held by the remaining peer', async () => {
  const code = makeCode();
  const history = [{ id: '1'.repeat(32), text: 'retained', at: 100, mine: true, read: false }];
  const a = state(history); const b = state(); const restored = state();
  const one = await RelayRoom.create(code, a.handlers); const two = await RelayRoom.create(code, b.handlers);
  let replacement;
  try {
    one.start(); two.start(); await waitFor(() => a.online && b.online);
    two.close({ reason: 'disconnect' });
    await waitFor(() => !a.online);
    replacement = await RelayRoom.create(code, restored.handlers); replacement.start();
    await waitFor(() => a.online && restored.online);
    await waitFor(() => restored.batches.some((batch) => batch.messages.some((entry) => entry.id === history[0].id)));
  } finally { one.close(); two.close(); replacement?.close(); }
});

test('history sync does not truncate at the former ten thousand message limit', async () => {
  const code = makeCode();
  const history = Array.from({ length: 10001 }, (_, index) => ({
    id: index.toString(16).padStart(32, '0'), text: `history-${index}`, at: index, mine: true, read: false,
  }));
  const a = state(history); const b = state();
  const one = await RelayRoom.create(code, a.handlers); const two = await RelayRoom.create(code, b.handlers);
  try {
    one.start(); two.start();
    await waitFor(() => a.online && b.online);
    await waitFor(() => b.batches.flatMap((batch) => batch.messages).length === history.length, 30000);
  } finally { one.close(); two.close(); }
});

test('restoring a transport restarts interrupted history sync with a new request', async () => {
  const code = makeCode(); const a = state(); const b = state();
  const one = await RelayRoom.create(code, a.handlers); const two = await RelayRoom.create(code, b.handlers);
  try {
    one.start(); two.start(); await waitFor(() => a.online && b.online);
    const incoming = one.peer.historyIncoming;
    for (const socket of one.sockets.values()) socket.blockedUntil = Date.now() + 10000;
    one.updateTransport();
    assert.equal(a.online, false);
    for (const socket of one.sockets.values()) socket.blockedUntil = 0;
    one.updateTransport();
    assert.equal(a.online, true);
    assert.notEqual(one.peer.historyIncoming.id, incoming.id);
  } finally { one.close(); two.close(); }
});

test('tampered, replayed and old-session frames do not deliver messages', async () => {
  const code = makeCode(); const a = state(); const b = state();
  const one = await RelayRoom.create(code, a.handlers); const two = await RelayRoom.create(code, b.handlers);
  try {
    one.start(); two.start(); await waitFor(() => a.online && b.online);
    const publish = one.publish.bind(one); let frame;
    one.publish = (payload) => { if (payload.t === 'frame') { frame = payload; return true; } return publish(payload); };
    const id = randomBytes(16).toString('hex');
    assert.equal(one.sendPayload({ type: 'message', id, text: 'authenticated', at: Date.now() }, true), true);
    const altered = Buffer.from(frame.data, 'base64'); altered[0] ^= 1;
    assert.throws(() => two.receiveFrame(one.id, { ...frame, data: altered.toString('base64') }));
    assert.throws(() => two.receiveFrame(one.id, { ...frame, seq: frame.seq + 1 }));
    assert.equal(b.messages.length, 0);
    two.receiveFrame(one.id, frame);
    assert.equal(b.messages.length, 1);
    two.receiveFrame(one.id, frame);
    assert.equal(b.messages.length, 1);
    one.publish = publish;
    one.resetPeer(false); two.resetPeer(false);
    await waitFor(() => a.online && b.online);
    two.receiveFrame(one.id, frame);
    assert.equal(b.messages.length, 1);
  } finally { one.close(); two.close(); }
});

test('sequence exhaustion resets the session before nonce reuse', async () => {
  const code = makeCode(); const a = state(); const b = state();
  const one = await RelayRoom.create(code, a.handlers); const two = await RelayRoom.create(code, b.handlers);
  try {
    one.start(); two.start(); await waitFor(() => a.online && b.online);
    const peer = one.peer;
    one.sequence = 0xffffffff;
    assert.equal(one.sendPayload({ type: 'ping' }, true), true);
    assert.equal(one.sendPayload({ type: 'ping' }, true), false);
    assert.equal(one.sequence, 0x100000000);
    await Promise.resolve();
    assert.notEqual(one.peer, peer);
    assert.equal(one.online, false);
  } finally { one.close(); two.close(); }
});

test('relay input verification has a bounded burst', async () => {
  const room = await RelayRoom.create(makeCode(), state().handlers);
  try {
    const socket = {};
    for (let i = 0; i < 400; i++) assert.equal(room.allowRelayEvent(socket), true);
    assert.equal(room.allowRelayEvent(socket), false);
    socket.eventBudgetTime -= 1000;
    assert.equal(room.allowRelayEvent(socket), true);
  } finally { room.close(); }
});


test('invalid and noncanonical room codes are rejected', async () => {
  const code = makeCode();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const noncanonical = code.slice(0, -1) + alphabet[alphabet.indexOf(code.at(-1)) + 1];
  for (const invalid of ['', code.slice(0, -1), 'BAD-' + code.slice(4), noncanonical]) {
    await assert.rejects(RelayRoom.create(invalid, state().handlers));
  }
});
