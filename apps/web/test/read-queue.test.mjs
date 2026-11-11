import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadQueue } from '../src/read-queue.js';

test('read queue yields bounded batches and preserves the rest for later frames', () => {
  const queue = new ReadQueue();
  const items = Array.from({ length: 45 }, (_, index) => ({ id: String(index), mine: false, read: false }));
  for (const item of items) queue.add(item);
  queue.add(items[0]);
  queue.add({ id: 'mine', mine: true, read: false });
  queue.add({ id: 'already-read', mine: false, read: true });

  const first = queue.nextBatch(20);
  assert.equal(first.length, 20);
  for (const item of first) queue.remove(item.id);
  assert.equal(queue.size, 25);
  assert.deepEqual(queue.nextBatch(20), items.slice(20, 40));
});
