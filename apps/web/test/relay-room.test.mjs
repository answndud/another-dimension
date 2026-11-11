import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import sodium from 'sodium-javascript';

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
const { crypto_auth } = sodium;

function makeCode() { return `AD1-${randomBytes(64).toString('base64url')}`; }
function signedHello(room, createdAt) {
  const payload = { v: 1, t: 'hello', instance: room.instance };
  const authenticated = JSON.stringify(['another-dimension/relay-auth/v2', room.topic, room.id, 24001, createdAt, payload]);
  const mac = new Uint8Array(32);
  crypto_auth(mac, new TextEncoder().encode(authenticated), room.authKey);
  let binary = '';
  for (const byte of mac) binary += String.fromCharCode(byte);
  return finalizeEvent({ kind: 24001, created_at: createdAt, tags: [['t', room.topic]], content: JSON.stringify({ ...payload, auth: btoa(binary) }) }, room.signingKey);
}
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

test('copied hello MAC cannot be re-signed by another relay identity', async () => {
  const code = makeCode(); const a = state(); const b = state();
  const one = await RelayRoom.create(code, a.handlers); const two = await RelayRoom.create(code, b.handlers);
  try {
    one.start();
    await waitFor(() => published.some((value) => JSON.parse(value).pubkey === one.id));
    one.tick();
    assert.ok(a.statuses.some((status) => status.includes('양쪽에서 새로고침')));
    const original = published.map((value) => JSON.parse(value)).find((wire) => wire.pubkey === one.id && JSON.parse(wire.content).t === 'hello');
    const forged = finalizeEvent({ kind: original.kind, created_at: original.created_at, tags: original.tags, content: original.content }, generateSecretKey());
    two.receiveRelay({ data: JSON.stringify(['EVENT', 'room', forged]) });
    assert.equal(two.peer, null);
    two.start();
    await waitFor(() => a.online && b.online);
  } finally { one.close(); two.close(); }
});

test('a newer hello replaces a peer candidate created by replaying an older hello', async () => {
  const code = makeCode(); const oldState = state();
  const oldRoom = await RelayRoom.create(code, oldState.handlers);
  oldRoom.start();
  await waitFor(() => published.some((value) => JSON.parse(value).pubkey === oldRoom.id));
  const oldHello = published.map((value) => JSON.parse(value)).find((wire) => wire.pubkey === oldRoom.id && JSON.parse(wire.content).t === 'hello');
  oldRoom.close();

  const targetState = state(); const liveState = state();
  const target = await RelayRoom.create(code, targetState.handlers);
  const live = await RelayRoom.create(code, liveState.handlers);
  try {
    target.receiveRelay({ data: JSON.stringify(['EVENT', 'room', oldHello]) });
    assert.equal(target.peer?.id, oldRoom.id);
    await waitFor(() => Math.floor(Date.now() / 1000) > oldHello.created_at, 3000);
    target.start(); live.start();
    await waitFor(() => target.peer?.id === live.id && targetState.online && liveState.online);
  } finally { target.close(); live.close(); }
});

test('a live hello in the same second can replace a replayed candidate', async () => {
  const code = makeCode();
  const oldRoom = await RelayRoom.create(code, state().handlers);
  const target = await RelayRoom.create(code, state().handlers);
  const live = await RelayRoom.create(code, state().handlers);
  try {
    const createdAt = Math.floor(Date.now() / 1000);
    const replay = signedHello(oldRoom, createdAt);
    const current = signedHello(live, createdAt);
    target.receiveRelay({ data: JSON.stringify(['EVENT', 'room', replay]) });
    assert.equal(target.peer?.id, oldRoom.id);
    const stalePeer = target.peer;
    const staleKey = new Uint8Array(32).fill(7);
    let connectionClosed = false;
    stalePeer.sendCipher = { key: staleKey };
    stalePeer.connection = { close: () => { connectionClosed = true; } };
    target.receiveRelay({ data: JSON.stringify(['EVENT', 'room', current]) });
    assert.equal(target.peer?.id, live.id);
    assert.equal(connectionClosed, true);
    assert.equal(staleKey.every((byte) => byte === 0), true);
    target.receiveRelay({ data: JSON.stringify(['EVENT', 'room', replay]) });
    assert.equal(target.peer?.id, live.id);
  } finally { oldRoom.close(); target.close(); live.close(); }
});

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

test('extra sessions do not replace the active pair and can connect after exit', async () => {
  const code = makeCode();
  const states = Array.from({ length: 4 }, () => state());
  const rooms = [];
  try {
    for (let index = 0; index < 2; index++) {
      rooms.push(await RelayRoom.create(code, states[index].handlers));
      rooms[index].start();
    }
    await waitFor(() => states[0].online && states[1].online);

    for (let index = 2; index < 4; index++) {
      rooms.push(await RelayRoom.create(code, states[index].handlers));
      rooms[index].start();
    }
    await waitFor(() => states.slice(2).some((entry) => entry.statuses.includes('이미 연결되어 있습니다')));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(states[0].online && states[1].online, true);
    assert.equal(rooms[0].peer?.id, rooms[1].id);
    assert.equal(rooms[1].peer?.id, rooms[0].id);
    rooms[0].close(); rooms[1].close();
    await waitFor(() => states[2].online && states[3].online, 25000);
  } finally {
    for (const room of rooms) room.close();
  }
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

test('relay transport restoration lets an uncertain message be retried with its original id', async () => {
  const code = makeCode(); const a = state(); const b = state();
  const one = await RelayRoom.create(code, a.handlers); const two = await RelayRoom.create(code, b.handlers);
  try {
    one.start(); two.start(); await waitFor(() => a.online && b.online);
    const send = one.sendPayload.bind(one);
    one.sendPayload = (payload, relayOnly) => payload.type === 'message' ? false : send(payload, relayOnly);
    const message = one.sendMessage('retry after relay recovery');
    for (const socket of one.sockets.values()) socket.blockedUntil = Date.now() + 10000;
    one.updateTransport();
    assert.equal(a.online, false);
    assert.equal(one.pendingMessages.size, 0);
    assert.ok(a.receipts.some((receipt) => receipt.id === message.id && receipt.type === 'uncertain'));

    for (const socket of one.sockets.values()) socket.blockedUntil = 0;
    one.updateTransport();
    assert.equal(a.online, true);
    one.sendPayload = send;
    assert.equal(one.retryMessage(message), true);
    await waitFor(() => b.messages.some((entry) => entry.id === message.id));
    await waitFor(() => a.receipts.some((receipt) => receipt.id === message.id && receipt.type === 'delivered'));
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

test('a direct channel send exception falls back to relay', async () => {
  const code = makeCode(); const a = state(); const b = state();
  const one = await RelayRoom.create(code, a.handlers); const two = await RelayRoom.create(code, b.handlers);
  try {
    one.start(); two.start(); await waitFor(() => a.online && b.online);
    one.peer.channel = { readyState: 'open', bufferedAmount: 0, send: () => { throw new Error('closed channel'); }, close() {} };
    const message = one.sendMessage('relay after channel error');
    await waitFor(() => b.messages.some((entry) => entry.id === message.id));
    assert.equal(b.messages.filter((entry) => entry.id === message.id).length, 1);
  } finally { one.close(); two.close(); }
});

test('failed relay sends become uncertain after bounded attempts with a stable message id', async () => {
  const code = makeCode(); const a = state(); const b = state();
  const one = await RelayRoom.create(code, a.handlers); const two = await RelayRoom.create(code, b.handlers);
  try {
    one.start(); two.start(); await waitFor(() => a.online && b.online);
    const send = one.sendPayload.bind(one);
    const attempts = [];
    one.sendPayload = (payload, relayOnly) => {
      if (payload.type === 'message') { attempts.push(payload.id); return false; }
      return send(payload, relayOnly);
    };
    const message = one.sendMessage('lost'); const pending = one.pendingMessages.get(message.id);
    for (let i = 0; i < 4; i++) { clearTimeout(pending.timer); one.attemptMessage(pending); }
    assert.equal(one.pendingMessages.size, 0);
    assert.ok(a.receipts.some((receipt) => receipt.id === message.id && receipt.type === 'uncertain'));
    assert.ok(!a.receipts.some((receipt) => receipt.id === message.id && receipt.type === 'delivered'));
    assert.deepEqual(attempts, Array(4).fill(message.id));
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

test('history sync converges both message sets without duplicate ids under clock skew', async () => {
  const code = makeCode();
  const leftMessage = { id: 'a'.repeat(32), text: 'left clock ahead', at: Date.now() + 86_400_000, mine: true, read: false };
  const rightMessage = { id: 'b'.repeat(32), text: 'right clock behind', at: Date.now() - 86_400_000, mine: true, read: false };
  const a = state([leftMessage]); const b = state([rightMessage]);
  for (const value of [a, b]) {
    value.handlers.historySnapshot = () => ({ floor: null, messages: value.history });
    value.handlers.historyBatch = (batch) => {
      value.batches.push(batch);
      for (const entry of batch.messages) {
        if (!value.history.some((message) => message.id === entry.id)) value.history.push({ ...entry, mine: !entry.mine });
      }
    };
  }
  const one = await RelayRoom.create(code, a.handlers); const two = await RelayRoom.create(code, b.handlers);
  try {
    one.start(); two.start();
    await waitFor(() => a.online && b.online);
    await waitFor(() => a.history.length === 2 && b.history.length === 2);
    assert.deepEqual(a.history.map((message) => message.id).sort(), b.history.map((message) => message.id).sort());
    assert.equal(new Set(a.history.map((message) => message.id)).size, 2);
    assert.equal(new Set(b.history.map((message) => message.id)).size, 2);
    assert.equal(a.history.find((message) => message.id === rightMessage.id).at, rightMessage.at);
    assert.equal(b.history.find((message) => message.id === leftMessage.id).at, leftMessage.at);
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
