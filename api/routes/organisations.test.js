'use strict';

// organisations.test.js — route-protection wiring only. The pre-existing
// derive*/toOrganisationDTO handler logic predates this slice and has no
// coverage here (matches this file's existing zero-test baseline); this
// test only confirms the gate middleware is composed on the right routes
// and NOT on /search, which is a deliberate scope boundary (§4 of the plan).

const { test } = require('node:test');
const assert = require('node:assert');

const router = require('./organisations');

const GATE_NAMES = ['requireAuth', 'attachTenant', 'requirePortfolio'];

function layerFor(path, method = 'get') {
  return router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
}

function middlewareNames(path, method = 'get') {
  const layer = layerFor(path, method);
  assert.ok(layer, `no route registered for ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map(s => s.name);
}

test('GET /search has none of the auth/tenant/portfolio gate applied — stays public', () => {
  const names = middlewareNames('/search');
  for (const gate of GATE_NAMES) {
    assert.ok(!names.includes(gate), `/search must not carry ${gate}`);
  }
});

for (const path of ['/:id', '/:id/signals', '/:id/timeline', '/:id/improvement-queue']) {
  test(`GET ${path} carries requireAuth, attachTenant, requirePortfolio in that order`, () => {
    const names = middlewareNames(path);
    const gatePositions = GATE_NAMES.map(name => names.indexOf(name));

    for (const [i, pos] of gatePositions.entries()) {
      assert.notStrictEqual(pos, -1, `${path} is missing ${GATE_NAMES[i]}`);
    }
    assert.ok(
      gatePositions[0] < gatePositions[1] && gatePositions[1] < gatePositions[2],
      `${path} must run requireAuth → attachTenant → requirePortfolio in order, got: ${names.join(', ')}`
    );
    // the gate must run before the route's own handler logic
    assert.ok(Math.max(...gatePositions) < names.length - 1, `${path} must have a handler after the gate`);
  });
}
