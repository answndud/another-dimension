import Noise from 'noise-handshake';
import Cipher from 'noise-handshake/cipher.js';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import { crypto_auth, crypto_auth_verify } from 'sodium-javascript';

const RELAYS = ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.primal.net'];
const KIND = 24001;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_SEQUENCE = 0xffffffff;
const MAX_EVENT_SIZE = 100000;
const HISTORY_BATCH_ITEMS = 20;
const HISTORY_BATCH_BYTES = 24000;
const HISTORY_RETRY_MS = 3000;
const HISTORY_RETRIES = 8;
const DELIVERY_RETRY_MS = 2000;
const DELIVERY_ATTEMPTS = 4;
const MAX_PENDING_MESSAGES = 100;
const MAX_BUFFERED_BYTES = 256 * 1024;
const RELAY_EVENT_BURST = 400;
const RELAY_EVENTS_PER_SECOND = 200;

function base64(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}
function unbase64(value, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('invalid frame');
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
function hex(bytes) { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''); }
function newInstance() { return hex(crypto.getRandomValues(new Uint8Array(16))); }
function prologue(first, second) {
  return encoder.encode(`another-dimension/relay/v1/${first.id}/${first.instance}/${second.id}/${second.instance}`);
}
function associatedData(frame, sender) {
  return encoder.encode(`ad1|${sender}|${frame.to}|${frame.fromInstance}|${frame.toInstance}|${frame.seq}`);
}
function validMessage(message) {
  return message && typeof message.id === 'string' && /^[0-9a-f]{32}$/.test(message.id) &&
    typeof message.text === 'string' && message.text.length > 0 && Array.from(message.text).length <= 4000 &&
    Number.isSafeInteger(message.at) && Math.abs(message.at) <= 8640000000000000 && typeof message.mine === 'boolean';
}
function validFloor(floor) {
  return floor === null || (floor && typeof floor.id === 'string' && /^[0-9a-f]{32}$/.test(floor.id) &&
    Number.isSafeInteger(floor.at) && Math.abs(floor.at) <= 8640000000000000);
}

export class RelayRoom {
  static async create(code, handlers) {
    if (typeof code !== 'string' || !/^AD1-[A-Za-z0-9_-]{86}$/.test(code)) throw new Error('invalid room code');
    const encoded = code.slice(4).replaceAll('-', '+').replaceAll('_', '/');
    const decoded = atob(encoded + '==');
    if (decoded.length !== 64 || btoa(decoded).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') !== code.slice(4)) throw new Error('invalid room code');
    const raw = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    let material;
    try { material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']); }
    finally { raw.fill(0); }
    const derive = (label) => crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('another-dimension/room/v1'), info: encoder.encode(label) }, material, 256);
    const [topic, key, authKey] = await Promise.all([derive('rendezvous-topic'), derive('noise-psk'), derive('relay-event-auth')]);
    return new RelayRoom(hex(new Uint8Array(topic)), new Uint8Array(key), handlers, new Uint8Array(authKey));
  }

  constructor(topic, psk, handlers, authKey = psk.slice()) {
    this.topic = topic;
    this.psk = psk;
    this.authKey = authKey;
    this.handlers = handlers;
    this.signingKey = generateSecretKey();
    this.id = getPublicKey(this.signingKey);
    this.instance = newInstance();
    this.sockets = new Map();
    this.seenEvents = new Set();
    this.publishedEvents = new Set();
    this.peer = null;
    this.busyPeers = new Map();
    this.busyUntil = 0;
    this.closed = false;
    this.online = false;
    this.sequence = 0;
    this.received = new Set();
    this.highestReceived = -1;
    this.pendingTimers = new Set();
    this.pendingMessages = new Map();
    this.relayAttempts = new Map();
    this.transportAvailable = false;
    this.startedAt = Date.now();
  }

  start() {
    this.handlers.status('연결 중');
    for (const relay of RELAYS) this.connectRelay(relay);
    this.tickTimer = setInterval(() => this.tick(), 5000);
  }

  connectRelay(url) {
    if (this.closed) return;
    let socket;
    try { socket = new WebSocket(url); } catch {
      this.scheduleRelayReconnect(url);
      return;
    }
    this.sockets.set(url, socket);
    socket.addEventListener('open', () => {
      if (this.closed) return;
      try { socket.send(JSON.stringify(['REQ', 'room', { kinds: [KIND], '#t': [this.topic], limit: 0 }])); } catch { socket.close(); return; }
      const stableTimer = setTimeout(() => { this.pendingTimers.delete(stableTimer); if (this.sockets.get(url) === socket && socket.readyState === WebSocket.OPEN) this.relayAttempts.delete(url); }, 30000);
      socket.stableTimer = stableTimer;
      this.pendingTimers.add(stableTimer);
      this.updateTransport();
    });
    socket.addEventListener('message', (event) => this.receiveRelay(event, socket));
    socket.addEventListener('error', () => socket.close());
    socket.addEventListener('close', () => {
      if (this.sockets.get(url) === socket) this.sockets.delete(url);
      for (const timer of [socket.stableTimer, socket.blockTimer]) { clearTimeout(timer); this.pendingTimers.delete(timer); }
      this.updateTransport();
      if (!this.closed) this.scheduleRelayReconnect(url);
    });
  }

  scheduleRelayReconnect(url) {
    const attempts = this.relayAttempts.get(url) || 0;
    this.relayAttempts.set(url, attempts + 1);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempts, 5));
    const timer = setTimeout(() => { this.pendingTimers.delete(timer); this.connectRelay(url); }, delay + Math.random() * 500);
    this.pendingTimers.add(timer);
  }

  hasTransport() {
    return this.peer?.channel?.readyState === 'open' || [...this.sockets.values()].some((socket) => socket.readyState === WebSocket.OPEN && !(socket.blockedUntil > Date.now()));
  }

  updateTransport() {
    const available = Boolean(this.online && this.hasTransport());
    if (available === this.transportAvailable) return;
    this.transportAvailable = available;
    if (!available) {
      this.cancelPendingMessages();
      clearTimeout(this.peer?.historyIncoming?.timer);
      clearTimeout(this.peer?.historyOutgoing?.timer);
      if (this.peer) this.peer.historyOutgoing = null;
    }
    this.handlers.connected(available);
    if (this.online) {
      this.handlers.status(available ? '연결됨' : '연결이 끊겼습니다');
      if (!available && this.peer?.historyIncoming && !this.peer.historyIncoming.done) {
        this.handlers.historyStatus?.('연결이 끊겨 대화 동기화가 중단되었습니다.');
      } else if (available && this.peer?.historyIncoming) {
        this.startHistorySync(this.peer);
      }
    }
  }

  publish(payload) {
    if (this.closed) return false;
    const createdAt = Math.floor(Date.now() / 1000);
    const content = JSON.stringify(['another-dimension/relay-auth/v2', this.topic, this.id, KIND, createdAt, payload]);
    const mac = new Uint8Array(32);
    crypto_auth(mac, encoder.encode(content), this.authKey);
    const wire = finalizeEvent({ kind: KIND, created_at: createdAt, tags: [['t', this.topic]], content: JSON.stringify({ ...payload, auth: base64(mac) }) }, this.signingKey);
    this.publishedEvents.add(wire.id);
    if (this.publishedEvents.size > 512) this.publishedEvents.delete(this.publishedEvents.values().next().value);
    const message = JSON.stringify(['EVENT', wire]);
    let sent = false;
    for (const socket of this.sockets.values()) {
      if (socket.readyState === WebSocket.OPEN && !(socket.blockedUntil > Date.now()) && (socket.bufferedAmount || 0) < MAX_BUFFERED_BYTES) {
        try { socket.send(message); sent = true; } catch { /* Another relay may still be available. */ }
      }
    }
    return sent;
  }

  receiveRelay(event, socket) {
    if (typeof event.data !== 'string' || event.data.length > MAX_EVENT_SIZE) return;
    let packet;
    try { packet = JSON.parse(event.data); } catch { return; }
    if (packet[0] === 'OK' && packet[2] === false && socket && this.publishedEvents.has(packet[1]) && !String(packet[3] || '').startsWith('duplicate:')) {
      socket.blockedUntil = Date.now() + 10000;
      this.updateTransport();
      clearTimeout(socket.blockTimer);
      this.pendingTimers.delete(socket.blockTimer);
      const timer = setTimeout(() => { this.pendingTimers.delete(timer); this.updateTransport(); }, 10000);
      socket.blockTimer = timer;
      this.pendingTimers.add(timer);
      return;
    }
    if (packet[0] === 'EOSE' && packet[1] === 'room') { this.hello(); return; }
    if (packet[0] !== 'EVENT' || packet[1] !== 'room') return;
    if (socket && !this.allowRelayEvent(socket)) return;
    const wire = packet[2];
    if (!wire || wire.kind !== KIND || wire.pubkey === this.id || typeof wire.content !== 'string' || wire.content.length > MAX_EVENT_SIZE || !Array.isArray(wire.tags) || !wire.tags.some((tag) => Array.isArray(tag) && tag[0] === 't' && tag[1] === this.topic)) return;
    if (Math.abs(Math.floor(Date.now() / 1000) - wire.created_at) > 300 || this.seenEvents.has(wire.id)) return;
    try { if (!verifyEvent(wire)) return; } catch { return; }
    this.seenEvents.add(wire.id);
    if (this.seenEvents.size > 5000) this.seenEvents.delete(this.seenEvents.values().next().value);
    let body;
    try { body = JSON.parse(wire.content); } catch { return; }
    if (!body || body.v !== 1 || typeof body.t !== 'string' || !/^[0-9a-f]{32}$/.test(body.instance || '')) return;
    const { auth, ...payload } = body;
    let mac;
    try { mac = Uint8Array.from(atob(auth), (character) => character.charCodeAt(0)); } catch { return; }
    const authenticated = JSON.stringify(['another-dimension/relay-auth/v2', this.topic, wire.pubkey, wire.kind, wire.created_at, payload]);
    if (mac.length !== 32 || !crypto_auth_verify(mac, encoder.encode(authenticated), this.authKey)) return;
    try { this.handle(wire.pubkey, payload, wire.created_at); } catch { /* Discard malformed or unauthenticated input. */ }
  }

  allowRelayEvent(socket) {
    const now = Date.now();
    const elapsed = Math.max(0, now - (socket.eventBudgetTime ?? now));
    socket.eventBudget = Math.min(RELAY_EVENT_BURST, (socket.eventBudget ?? RELAY_EVENT_BURST) + elapsed * RELAY_EVENTS_PER_SECOND / 1000);
    socket.eventBudgetTime = now;
    if (socket.eventBudget < 1) return false;
    socket.eventBudget--;
    return true;
  }

  hello() { this.publish({ v: 1, t: 'hello', instance: this.instance }); }

  tick() {
    if (this.closed) return;
    this.hello();
    for (const [key, candidate] of this.busyPeers) {
      if (Date.now() - candidate.started > 20000) this.removeBusyPeer(key);
    }
    if (!this.peer) {
      const relayAvailable = [...this.sockets.values()].some((socket) => socket.readyState === WebSocket.OPEN);
      this.handlers.status(Date.now() < this.busyUntil ? '이미 연결되어 있습니다' : (relayAvailable ? '상대방을 기다리는 중. 연결되지 않으면 양쪽에서 새로고침해 주세요.' : '연결 중'));
      return;
    }
    if (!this.online && Date.now() - this.peer.started > 15000) { this.resetPeer(); return; }
    if (this.online && Date.now() - this.peer.lastSeen > 30000) {
      this.handlers.status('연결이 끊겼습니다');
      this.resetPeer(false);
      return;
    }
    if (this.online) this.sendPayload({ type: 'ping' });
    else if (this.peer.initial) this.sendHandshake('h1', this.peer.initial);
    else if (this.peer.reply) this.sendHandshake('h2', this.peer.reply);
  }

  setPeer(id, instance, helloCreatedAt = 0) {
    const peer = { id, instance, helloCreatedAt, started: Date.now(), lastSeen: Date.now(), initiator: this.id < id };
    const first = peer.initiator ? { id: this.id, instance: this.instance } : peer;
    const second = peer.initiator ? peer : { id: this.id, instance: this.instance };
    peer.noise = new Noise('NNpsk0', peer.initiator, undefined, { psk: this.psk });
    peer.noise.initialise(prologue(first, second));
    this.peer = peer;
    if (peer.initiator) {
      peer.initial = base64(peer.noise.send());
      this.sendHandshake('h1', peer.initial);
    }
  }

  sendHandshake(type, data) {
    if (!this.peer) return;
    this.publish({ v: 1, t: type, instance: this.instance, to: this.peer.id, targetInstance: this.peer.instance, data });
  }

  activateCiphers() {
    this.peer.sendCipher = new Cipher(this.peer.noise.tx);
    this.peer.receiveCipher = new Cipher(this.peer.noise.rx);
    this.sequence = 0;
    this.received.clear();
    this.highestReceived = -1;
  }

  handle(author, body, createdAt = 0) {
    if (body.t === 'hello') {
      if (!this.peer) this.setPeer(author, body.instance, createdAt);
      else if (!this.online && (author !== this.peer.id || body.instance !== this.peer.instance) && createdAt > this.peer.helloCreatedAt) this.setPeer(author, body.instance, createdAt);
      else if (this.online && (author !== this.peer.id || body.instance !== this.peer.instance)) this.handleBusyHello(author, body.instance);
      return;
    }
    if (body.to !== this.id || body.targetInstance !== this.instance) return;
    if (this.online && this.peer && (author !== this.peer.id || body.instance !== this.peer.instance)) {
      this.handleBusyHandshake(author, body);
      return;
    }
    if (!this.peer && body.t === 'h1') this.setPeer(author, body.instance);
    const peer = this.peer;
    if (!peer || author !== peer.id || body.instance !== peer.instance) return;
    if (body.t === 'h1' && !peer.initiator) {
      if (peer.reply) { this.sendHandshake('h2', peer.reply); return; }
      peer.noise.recv(unbase64(body.data, 1024));
      peer.reply = base64(peer.noise.send());
      this.activateCiphers();
      this.sendHandshake('h2', peer.reply);
    } else if (body.t === 'h2' && peer.initiator) {
      if (!peer.sendCipher) {
        peer.noise.recv(unbase64(body.data, 1024));
        this.activateCiphers();
      }
      this.sendPayload({ type: 'confirm' });
    } else if (body.t === 'frame' && peer.receiveCipher) {
      this.receiveFrame(author, body);
    }
  }

  sendPayload(payload, relayOnly = false) {
    const peer = this.peer;
    if (!peer?.sendCipher) return false;
    if (this.sequence > MAX_SEQUENCE) {
      if (!peer.exhaustionScheduled) {
        peer.exhaustionScheduled = true;
        queueMicrotask(() => {
          if (!this.closed && this.peer === peer) {
            this.handlers.status('연결을 다시 설정하는 중');
            this.resetPeer(false);
          }
        });
      }
      return false;
    }
    const frame = { v: 1, t: 'frame', instance: this.instance, to: peer.id, targetInstance: peer.instance, fromInstance: this.instance, toInstance: peer.instance, seq: this.sequence++ };
    peer.sendCipher.setNonce(frame.seq);
    frame.data = base64(peer.sendCipher.encrypt(encoder.encode(JSON.stringify(payload)), associatedData(frame, this.id)));
    if (!relayOnly && peer.channel?.readyState === 'open' && (peer.channel.bufferedAmount || 0) < MAX_BUFFERED_BYTES) {
      try { peer.channel.send(JSON.stringify(frame)); return true; } catch { /* Use the relay below. */ }
    }
    return this.publish(frame);
  }

  receiveFrame(author, frame) {
    const peer = this.peer;
    if (frame.fromInstance !== peer.instance || frame.toInstance !== this.instance || !Number.isInteger(frame.seq) || frame.seq < 0 || frame.seq > MAX_SEQUENCE || frame.seq < this.highestReceived - 1024 || this.received.has(frame.seq)) return;
    peer.receiveCipher.setNonce(frame.seq);
    const payload = JSON.parse(decoder.decode(peer.receiveCipher.decrypt(unbase64(frame.data, 60000), associatedData(frame, author))));
    this.received.add(frame.seq);
    this.highestReceived = Math.max(this.highestReceived, frame.seq);
    for (const seq of this.received) if (seq < this.highestReceived - 1024) this.received.delete(seq);
    peer.lastSeen = Date.now();
    if (payload.type === 'confirm' && !peer.initiator) {
      this.sendPayload({ type: 'confirmed' });
      this.setOnline();
    } else if (payload.type === 'confirmed' && peer.initiator) {
      this.setOnline();
    } else if (payload.type === 'busy' && !this.online) {
      this.busyUntil = Date.now() + 20000;
      this.handlers.status('이미 연결되어 있습니다');
      this.resetPeer(false);
    } else if (this.online && payload.type === 'rtc') {
      void this.handleRtc(payload).catch(() => { if (this.peer === peer) this.closeDirect(); });
    } else if (this.online && payload.type === 'ping') {
      // The authenticated frame itself updates the peer's activity time.
    } else if (this.online && payload.type === 'bye') {
      this.handlers.status('상대방이 나갔습니다');
      this.resetPeer(false);
    } else if (this.online && payload.type === 'disconnect') {
      this.handlers.status('연결이 끊겼습니다');
      this.resetPeer(false);
    } else if (this.online && payload.type === 'history-request') {
      this.handleHistoryRequest(payload);
    } else if (this.online && payload.type === 'history-batch') {
      this.handleHistoryBatch(payload);
    } else if (this.online && payload.type === 'history-ack') {
      this.handleHistoryAck(payload);
    } else if (this.online && payload.type === 'message' && typeof payload.id === 'string' && /^[0-9a-f]{32}$/.test(payload.id) && typeof payload.text === 'string' && Array.from(payload.text).length <= 4000 && payload.text.length > 0 && Number.isSafeInteger(payload.at) && Math.abs(payload.at) <= 8640000000000000) {
      if (this.handlers.message(payload) !== false) this.sendPayload({ type: 'delivered', id: payload.id });
    } else if (this.online && (payload.type === 'delivered' || payload.type === 'read') && typeof payload.id === 'string' && /^[0-9a-f]{32}$/.test(payload.id)) {
      this.confirmPendingMessage(payload.id);
      this.handlers.receipt?.(payload);
    } else if (this.online && payload.type === 'read-batch' && Array.isArray(payload.ids) && payload.ids.length <= 20 && payload.ids.every((id) => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id))) {
      for (const id of payload.ids) { this.confirmPendingMessage(id); this.handlers.receipt?.({ type: 'read', id }); }
    }
  }

  setOnline() {
    if (this.online) return;
    this.online = true;
    this.busyUntil = 0;
    this.peer.lastSeen = Date.now();
    this.handlers.status('연결됨');
    this.updateTransport();
    const peer = this.peer;
    if (peer.initiator) void this.startDirect().catch(() => { if (this.peer === peer) this.closeDirect(); });
    this.startHistorySync(peer);
  }

  makeBusyPeer(id, instance) {
    const key = `${id}:${instance}`;
    if (this.busyPeers.has(key)) return this.busyPeers.get(key);
    if (!this.online || this.busyPeers.size >= 4) return null;
    const candidate = { id, instance, initiator: this.id < id, started: Date.now(), sequence: 0 };
    const first = candidate.initiator ? { id: this.id, instance: this.instance } : candidate;
    const second = candidate.initiator ? candidate : { id: this.id, instance: this.instance };
    candidate.noise = new Noise('NNpsk0', candidate.initiator, undefined, { psk: this.psk });
    candidate.noise.initialise(prologue(first, second));
    this.busyPeers.set(key, candidate);
    if (candidate.initiator) {
      candidate.initial = base64(candidate.noise.send());
      this.sendBusyHandshake(candidate, 'h1', candidate.initial);
    }
    return candidate;
  }

  handleBusyHello(id, instance) {
    const candidate = this.makeBusyPeer(id, instance);
    if (candidate?.sendCipher) this.sendBusy(candidate);
    else if (candidate?.initial) this.sendBusyHandshake(candidate, 'h1', candidate.initial);
  }

  sendBusyHandshake(candidate, type, data) {
    this.publish({ v: 1, t: type, instance: this.instance, to: candidate.id, targetInstance: candidate.instance, data });
  }

  handleBusyHandshake(author, body) {
    if (body.t !== 'h1' && body.t !== 'h2') return;
    const key = `${author}:${body.instance}`;
    const candidate = this.busyPeers.get(key) || (body.t === 'h1' ? this.makeBusyPeer(author, body.instance) : null);
    if (!candidate) return;
    try {
      if (body.t === 'h1' && !candidate.initiator) {
        if (!candidate.reply) {
          candidate.noise.recv(unbase64(body.data, 1024));
          candidate.reply = base64(candidate.noise.send());
          candidate.sendCipher = new Cipher(candidate.noise.tx);
        }
        this.sendBusyHandshake(candidate, 'h2', candidate.reply);
        this.sendBusy(candidate);
      } else if (body.t === 'h2' && candidate.initiator) {
        if (!candidate.sendCipher) {
          candidate.noise.recv(unbase64(body.data, 1024));
          candidate.sendCipher = new Cipher(candidate.noise.tx);
        }
        this.sendBusy(candidate);
      }
    } catch {
      this.removeBusyPeer(key);
    }
  }

  sendBusy(candidate) {
    if (!candidate.sendCipher || candidate.sequence > MAX_SEQUENCE) return;
    const frame = { v: 1, t: 'frame', instance: this.instance, to: candidate.id, targetInstance: candidate.instance, fromInstance: this.instance, toInstance: candidate.instance, seq: candidate.sequence++ };
    candidate.sendCipher.setNonce(frame.seq);
    frame.data = base64(candidate.sendCipher.encrypt(encoder.encode(JSON.stringify({ type: 'busy' })), associatedData(frame, this.id)));
    this.publish(frame);
  }

  removeBusyPeer(key) {
    const candidate = this.busyPeers.get(key);
    if (!candidate) return;
    candidate.sendCipher?.key?.fill(0);
    candidate.noise?.s?.secretKey?.fill(0);
    candidate.noise?.e?.secretKey?.fill(0);
    this.busyPeers.delete(key);
  }

  startHistorySync(peer) {
    if (!this.handlers.historySnapshot || !this.handlers.historyBatch) return;
    clearTimeout(peer.historyIncoming?.timer);
    const incoming = { id: newInstance(), expected: 0, attempts: 0, started: false, done: false, timer: null };
    peer.historyIncoming = incoming;
    this.handlers.historyStatus?.('대화 동기화 중');
    const request = () => {
      if (this.peer !== peer || !this.online || incoming.started) return;
      if (incoming.attempts >= HISTORY_RETRIES) {
        this.handlers.historyStatus?.('대화 동기화에 실패했습니다. 다시 연결해 주세요.');
        return;
      }
      incoming.attempts++;
      this.sendPayload({ type: 'history-request', request: incoming.id }, incoming.attempts % 2 === 0);
      incoming.timer = setTimeout(request, HISTORY_RETRY_MS);
    };
    incoming.timer = setTimeout(request, 750);
  }

  handleHistoryRequest(payload) {
    if (!/^[0-9a-f]{32}$/.test(payload.request || '') || !this.handlers.historySnapshot) return;
    const peer = this.peer;
    const current = peer.historyOutgoing;
    if (current?.id === payload.request) { this.sendHistoryBatch(peer, current); return; }
    if (current) clearTimeout(current.timer);
    const snapshot = this.handlers.historySnapshot();
    if (!snapshot || !Array.isArray(snapshot.messages) || !validFloor(snapshot.floor)) return;
    const list = snapshot.messages.filter(validMessage);
    const outgoing = { id: payload.request, messages: list, floor: snapshot.floor, position: 0, index: 0, attempts: 0, timer: null, batch: null };
    peer.historyOutgoing = outgoing;
    this.sendHistoryBatch(peer, outgoing);
  }

  sendHistoryBatch(peer, outgoing) {
    if (this.peer !== peer || !this.online || peer.historyOutgoing !== outgoing) return;
    clearTimeout(outgoing.timer);
    if (outgoing.attempts >= HISTORY_RETRIES) { peer.historyOutgoing = null; return; }
    if (!outgoing.batch) {
      const entries = [];
      let bytes = 0;
      while (outgoing.position < outgoing.messages.length && entries.length < HISTORY_BATCH_ITEMS) {
        const entry = outgoing.messages[outgoing.position];
        const size = encoder.encode(JSON.stringify(entry)).length;
        if (entries.length && bytes + size > HISTORY_BATCH_BYTES) break;
        entries.push(entry);
        bytes += size;
        outgoing.position++;
      }
      outgoing.batch = { type: 'history-batch', request: outgoing.id, index: outgoing.index, done: outgoing.position === outgoing.messages.length, floor: outgoing.floor, entries };
    }
    outgoing.attempts++;
    this.sendPayload(outgoing.batch, outgoing.attempts % 2 === 0);
    outgoing.timer = setTimeout(() => this.sendHistoryBatch(peer, outgoing), HISTORY_RETRY_MS);
  }

  handleHistoryBatch(payload) {
    const incoming = this.peer.historyIncoming;
    if (!incoming || payload.request !== incoming.id || !Number.isSafeInteger(payload.index) || payload.index < 0) return;
    if (payload.index < incoming.expected) {
      const ack = { type: 'history-ack', request: incoming.id, index: payload.index };
      if (!this.sendPayload(ack, true)) this.sendPayload(ack);
      return;
    }
    if (incoming.done || payload.index !== incoming.expected || !Array.isArray(payload.entries) || payload.entries.length > HISTORY_BATCH_ITEMS ||
        typeof payload.done !== 'boolean' ||
        (!payload.done && payload.entries.length === 0) || !validFloor(payload.floor) || !payload.entries.every(validMessage)) return;
    clearTimeout(incoming.timer);
    incoming.started = true;
    this.handlers.historyBatch({ floor: payload.floor, messages: payload.entries });
    incoming.expected++;
    this.sendPayload({ type: 'history-ack', request: incoming.id, index: payload.index });
    incoming.done = payload.done;
    if (incoming.done) this.handlers.historyStatus?.('');
    else incoming.timer = setTimeout(() => {
      if (this.peer?.historyIncoming === incoming && !incoming.done) this.handlers.historyStatus?.('대화 동기화가 중단되었습니다. 다시 연결해 주세요.');
    }, HISTORY_RETRY_MS * (HISTORY_RETRIES + 1));
  }

  handleHistoryAck(payload) {
    const peer = this.peer;
    const outgoing = peer.historyOutgoing;
    if (!outgoing || payload.request !== outgoing.id || payload.index !== outgoing.index || !outgoing.batch) return;
    clearTimeout(outgoing.timer);
    if (outgoing.batch.done) { peer.historyOutgoing = null; return; }
    outgoing.index++;
    outgoing.batch = null;
    outgoing.attempts = 0;
    outgoing.timer = setTimeout(() => this.sendHistoryBatch(peer, outgoing), 20);
  }

  createPeerConnection() {
    const peer = this.peer;
    if (!peer || !globalThis.RTCPeerConnection) return null;
    const connection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
    peer.connection = connection;
    peer.candidates = [];
    connection.onicecandidate = (event) => {
      if (event.candidate && this.peer === peer) this.sendPayload({ type: 'rtc', candidate: event.candidate.toJSON() }, true);
    };
    connection.ondatachannel = (event) => this.attachChannel(peer, event.channel);
    connection.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(connection.connectionState) && this.peer === peer) this.closeDirect();
    };
    return connection;
  }

  attachChannel(peer, channel) {
    if (this.peer !== peer) { channel.close(); return; }
    peer.channel = channel;
    channel.onmessage = (event) => {
      if (this.peer !== peer || typeof event.data !== 'string' || event.data.length > MAX_EVENT_SIZE) return;
      try {
        const frame = JSON.parse(event.data);
        if (frame.v === 1 && frame.t === 'frame' && frame.to === this.id && frame.targetInstance === this.instance) this.receiveFrame(peer.id, frame);
      } catch { /* Ignore unauthenticated or malformed frames. */ }
    };
    channel.onopen = () => { if (this.peer === peer && peer.channel === channel) this.updateTransport(); };
    channel.onclose = () => { if (this.peer === peer && peer.channel === channel) { peer.channel = null; this.updateTransport(); } };
  }

  async startDirect() {
    const peer = this.peer;
    if (!peer || peer.connection || !this.online) return;
    const connection = this.createPeerConnection();
    if (!connection) return;
    this.attachChannel(peer, connection.createDataChannel('chat'));
    await connection.setLocalDescription(await connection.createOffer());
    if (this.peer === peer) this.sendPayload({ type: 'rtc', description: connection.localDescription.toJSON() }, true);
  }

  async handleRtc(payload) {
    const peer = this.peer;
    if (!peer || !this.online) return;
    if (payload.description?.type === 'offer' && !peer.initiator) {
      const connection = peer.connection || this.createPeerConnection();
      if (!connection) return;
      await connection.setRemoteDescription(payload.description);
      for (const candidate of peer.candidates.splice(0)) await connection.addIceCandidate(candidate);
      await connection.setLocalDescription(await connection.createAnswer());
      if (this.peer === peer) this.sendPayload({ type: 'rtc', description: connection.localDescription.toJSON() }, true);
    } else if (payload.description?.type === 'answer' && peer.initiator && peer.connection) {
      await peer.connection.setRemoteDescription(payload.description);
      for (const candidate of peer.candidates.splice(0)) await peer.connection.addIceCandidate(candidate);
    } else if (payload.candidate && typeof payload.candidate.candidate === 'string') {
      if (!peer.connection) this.createPeerConnection();
      if (!peer.connection) return;
      if (peer.connection.remoteDescription) await peer.connection.addIceCandidate(payload.candidate);
      else if (peer.candidates.length < 64) peer.candidates.push(payload.candidate);
    }
  }

  closeDirect() {
    const peer = this.peer;
    if (!peer) return;
    const connection = peer.connection;
    peer.connection = null;
    peer.channel?.close();
    peer.channel = null;
    connection?.close();
    this.updateTransport();
  }

  sendMessage(text, at = Date.now()) {
    if (!this.online || !this.hasTransport() || !text || Array.from(text).length > 4000) return null;
    const message = { id: newInstance(), text, at };
    return this.retryMessage(message) ? message : null;
  }

  retryMessage(message) {
    if (!this.online || !this.hasTransport() || this.pendingMessages.size >= MAX_PENDING_MESSAGES ||
        !validMessage({ ...message, mine: true }) || this.pendingMessages.has(message.id)) return false;
    const pending = { message: { id: message.id, text: message.text, at: message.at }, peer: this.peer, attempts: 0, timer: null };
    this.pendingMessages.set(message.id, pending);
    this.attemptMessage(pending);
    return true;
  }

  attemptMessage(pending) {
    if (this.pendingMessages.get(pending.message.id) !== pending) return;
    if (!this.online || this.peer !== pending.peer || !this.hasTransport() || pending.attempts >= DELIVERY_ATTEMPTS) {
      this.finishPendingMessage(pending, true);
      return;
    }
    pending.attempts++;
    this.sendPayload({ type: 'message', ...pending.message }, pending.attempts % 2 === 0);
    pending.timer = setTimeout(() => this.attemptMessage(pending), DELIVERY_RETRY_MS);
  }

  finishPendingMessage(pending, uncertain) {
    if (this.pendingMessages.get(pending.message.id) !== pending) return;
    clearTimeout(pending.timer);
    this.pendingMessages.delete(pending.message.id);
    if (uncertain) this.handlers.receipt?.({ type: 'uncertain', id: pending.message.id });
  }

  confirmPendingMessage(id) {
    const pending = this.pendingMessages.get(id);
    if (pending) this.finishPendingMessage(pending, false);
  }

  cancelPendingMessages() {
    for (const pending of this.pendingMessages.values()) this.finishPendingMessage(pending, true);
  }

  sendRead(id) { return this.online && this.sendPayload({ type: 'read', id }); }

  sendReadBatch(ids) {
    if (!this.online || !Array.isArray(ids) || ids.length === 0 || ids.length > 20 || !ids.every((id) => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id))) return false;
    return this.sendPayload({ type: 'read-batch', ids });
  }

  resetPeer(update = true) {
    this.online = false;
    this.cancelPendingMessages();
    this.transportAvailable = false;
    this.handlers.connected(false);
    this.clearPeerKeys();
    this.peer = null;
    this.instance = newInstance();
    this.sequence = 0;
    this.received.clear();
    this.highestReceived = -1;
    if (update) this.handlers.status('상대방을 기다리는 중');
    this.hello();
  }

  close({ reason = 'bye' } = {}) {
    if (this.closed) return;
    if (this.online) {
      const direct = this.peer?.channel?.readyState === 'open';
      this.sendPayload({ type: reason });
      if (direct) this.sendPayload({ type: reason }, true);
    }
    this.closed = true;
    this.online = false;
    this.cancelPendingMessages();
    this.transportAvailable = false;
    clearInterval(this.tickTimer);
    for (const timer of this.pendingTimers) clearTimeout(timer);
    for (const socket of this.sockets.values()) socket.close();
    this.sockets.clear();
    this.psk.fill(0);
    this.authKey.fill(0);
    this.signingKey.fill(0);
    this.clearPeerKeys();
    this.peer = null;
  }

  clearPeerKeys() {
    this.closeDirect();
    for (const key of this.busyPeers.keys()) this.removeBusyPeer(key);
    clearTimeout(this.peer?.historyIncoming?.timer);
    clearTimeout(this.peer?.historyOutgoing?.timer);
    this.peer?.sendCipher?.key?.fill(0);
    this.peer?.receiveCipher?.key?.fill(0);
    this.peer?.noise?.s?.secretKey?.fill(0);
    this.peer?.noise?.e?.secretKey?.fill(0);
  }
}
