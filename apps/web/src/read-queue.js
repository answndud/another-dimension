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
    return Array.from(this.messages.values()).slice(0, limit);
  }

  get size() {
    return this.messages.size;
  }
}
