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
    one.hello(); two.hello();
    await waitFor(() => outsider.peer !== null);
    await new Promise((resolve) => setTimeout(resolve, 300));
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
