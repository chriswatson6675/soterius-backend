'use strict';

// Disjoint-set (union-find) over string keys, with path compression and
// union-by-size. Deterministic: the representative of a set is the
// lexicographically smallest key ever unioned into it, so repeated builds
// produce identical groupings regardless of insertion order.

class UnionFind {
  constructor() {
    this.parent = new Map();
    this.size = new Map();
  }

  add(key) {
    if (!this.parent.has(key)) {
      this.parent.set(key, key);
      this.size.set(key, 1);
    }
    return key;
  }

  find(key) {
    this.add(key);
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // Path compression.
    let cur = key;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a, b) {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return ra;
    // Union by size; tie-break on smaller key so the result is deterministic.
    if (this.size.get(ra) < this.size.get(rb) ||
        (this.size.get(ra) === this.size.get(rb) && rb < ra)) {
      const t = ra; ra = rb; rb = t;
    }
    this.parent.set(rb, ra);
    this.size.set(ra, this.size.get(ra) + this.size.get(rb));
    return ra;
  }

  // Group all added keys by their root. Returns Map<root, key[]>.
  groups() {
    const g = new Map();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      if (!g.has(root)) g.set(root, []);
      g.get(root).push(key);
    }
    return g;
  }
}

module.exports = { UnionFind };
