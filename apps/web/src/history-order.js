// Device clocks can differ; this is a deterministic display order, not a causal order.
export function compareMessageOrder(a, b) {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function messageInsertionIndex(messages, message) {
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareMessageOrder(messages[middle], message) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}
