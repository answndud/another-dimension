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

test('display insertion keeps all entries beyond the former message limit', () => {
  const messages = Array.from({ length: 10001 }, (_, i) => ({ id: String(i).padStart(32, '0'), at: i }));
  const late = { id: 'late', at: -1 };
  messages.splice(messageInsertionIndex(messages, late), 0, late);
  assert.equal(messages.length, 10002);
  assert.equal(messages[0], late);
  assert.equal(messages.at(-1).at, 10000);
});
