export class ReadQueue {
  constructor() {
    this.messages = new Map();
  }

  add(message) {
    if (!message.mine && !message.read) this.messages.set(message.id, message);
  }

  remove(id) {
    this.messages.delete(id);
  }

  clear() {
    this.messages.clear();
  }

  nextBatch(limit = 20) {
    const batch = [];
    for (const message of this.messages.values()) {
      if (batch.length >= limit) break;
      batch.push(message);
    }
    return batch;
  }

  get size() {
    return this.messages.size;
  }
}
