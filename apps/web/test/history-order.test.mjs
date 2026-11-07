import test from 'node:test';
import assert from 'node:assert/strict';
import { compareMessageOrder, messageInsertionIndex } from '../src/history-order.js';

test('display order is deterministic with skewed and equal device times', () => {
  const items = [
    { id: 'c', at: 10000 }, { id: 'b', at: 50 }, { id: 'a', at: 50 }, { id: 'd', at: -10 },
  ];
  const sorted = [...items].sort(compareMessageOrder);
  const inserted = [];
  for (const item of items.reverse()) inserted.splice(messageInsertionIndex(inserted, item), 0, item);
  assert.deepEqual(inserted, sorted);
  assert.deepEqual(sorted.map((item) => item.id), ['d', 'a', 'b', 'c']);
});

test('insertion of a late item preserves the most recent ten thousand', () => {
  const messages = Array.from({ length: 10000 }, (_, i) => ({ id: String(i).padStart(32, '0'), at: i }));
  const newer = { id: 'new', at: 10001 };
  messages.splice(messageInsertionIndex(messages, newer), 0, newer);
  const evicted = messages.shift();
  const late = { id: 'late', at: -1 };
  assert.ok(compareMessageOrder(late, evicted) <= 0);
  assert.equal(messages.length, 10000);
  assert.equal(messages.at(-1), newer);
});
