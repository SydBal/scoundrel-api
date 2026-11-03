'use strict';
// Zero-dependency tests. Run: npm test  (or: node --test test.js)
// Boots the server on an ephemeral port and drives it over HTTP.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('./server.js');
const engine = require('./lib/scoundrel.js');

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function req(method, path, body, rawBody) {
  const opts = { method, headers: {} };
  if (rawBody !== undefined) {
    opts.body = rawBody;
    opts.headers['Content-Type'] = 'application/json';
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(base + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body, e.g. 204 */ }
  return { status: res.status, json, text };
}

async function newGame(seed) {
  const body = seed === undefined ? {} : { seed };
  const r = await req('POST', '/games', body);
  assert.equal(r.status, 201, `create failed: ${r.text}`);
  return r.json;
}

test('health and index', async () => {
  const h = await req('GET', '/health');
  assert.equal(h.status, 200);
  assert.deepEqual(h.json, { ok: true });
  const idx = await req('GET', '/');
  assert.equal(idx.status, 200);
  assert.match(idx.json.name, /scoundrel-api/);
  assert.ok(idx.json.endpoints.length > 0);
});

test('creating a game deals a room of 4 from a 44-card deck', async () => {
  const g = await newGame();
  assert.ok(typeof g.id === 'string' && g.id.length > 0);
  assert.equal(g.state.hp, 20);
  assert.equal(g.state.maxHp, 20);
  assert.equal(g.state.room.length, 4);
  assert.equal(g.state.deckCount, 40);
  assert.equal(g.state.discardCount, 0);
  assert.equal(g.state.canFlee, true);
  assert.equal(g.state.over, false);
  assert.ok(typeof g.text === 'string' && g.text.includes('HP 20/20'));
  for (const card of g.state.room) {
    assert.ok(typeof card.preview === 'string' && card.preview.length > 0);
  }
});

test('same seed deals the same room as the engine, twice', async () => {
  const a = await newGame(42);
  const b = await newGame(42);
  assert.deepEqual(a.state.room, b.state.room);
  const local = engine.newGame(42);
  assert.deepEqual(
    a.state.room.map((c) => `${c.label}${c.suit}`),
    local.room.map((c) => `${c.label}${c.suit}`),
  );
});

test('a non-numeric seed is rejected', async () => {
  const r = await req('POST', '/games', { seed: 'abc' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /seed/);
});

test('getting a game, and a 404 for an unknown id', async () => {
  const g = await newGame();
  const got = await req('GET', `/games/${g.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.id, g.id);
  assert.deepEqual(got.json.state, g.state);
  const missing = await req('GET', '/games/nope');
  assert.equal(missing.status, 404);
});

test('playing a card resolves it and returns events', async () => {
  const g = await newGame(7);
  const first = g.state.room[0];
  const r = await req('POST', `/games/${g.id}/play`, { index: 0 });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.events) && r.json.events.length > 0);
  assert.equal(r.json.state.discardCount + r.json.state.room.length + r.json.state.deckCount, 44);
  assert.ok(!r.json.state.room.some((c) => c.label === first.label && c.suit === first.suit && c.preview === first.preview)
    || r.json.state.room.length !== g.state.room.length);
});

test('bad card indexes are rejected', async () => {
  const g = await newGame();
  for (const bad of [-1, 4, 1.5, '0', null]) {
    const r = await req('POST', `/games/${g.id}/play`, { index: bad });
    assert.equal(r.status, 400, `index ${JSON.stringify(bad)} was not rejected`);
  }
  const missing = await req('POST', '/games/nope/play', { index: 0 });
  assert.equal(missing.status, 404);
});

test('fleeing a fresh room works once, then the rules forbid it', async () => {
  const g = await newGame(11);
  const fled = await req('POST', `/games/${g.id}/flee`);
  assert.equal(fled.status, 200);
  assert.ok(fled.json.events.length > 0);
  assert.equal(fled.json.state.fleeCount, 1);
  assert.equal(fled.json.state.room.length, 4);
  assert.equal(fled.json.state.deckCount, 40);
  assert.equal(fled.json.state.canFlee, false);
  const again = await req('POST', `/games/${g.id}/flee`);
  assert.equal(again.status, 409);
  assert.match(again.json.why, /fled the last room/);
});

test('fleeing after touching the room is forbidden', async () => {
  const g = await newGame(13);
  const played = await req('POST', `/games/${g.id}/play`, { index: 0 });
  assert.equal(played.status, 200);
  const fled = await req('POST', `/games/${g.id}/flee`);
  assert.equal(fled.status, 409);
  assert.match(fled.json.why, /touched/);
});

test('invalid JSON is a 400', async () => {
  const r = await req('POST', '/games', undefined, '{not json');
  assert.equal(r.status, 400);
});

test('list and delete', async () => {
  const g = await newGame();
  const list = await req('GET', '/games');
  assert.equal(list.status, 200);
  assert.ok(list.json.games.some((x) => x.id === g.id));
  const del = await req('DELETE', `/games/${g.id}`);
  assert.equal(del.status, 204);
  const gone = await req('GET', `/games/${g.id}`);
  assert.equal(gone.status, 404);
});

test('unknown routes are 404 JSON', async () => {
  const r = await req('GET', '/nope');
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'not found');
});

test('a driven game ends, and a finished game refuses moves', async () => {
  const g = await newGame(3);
  let state = g.state;
  // Monster-first policy: fight the biggest monster, else play the first card.
  for (let move = 0; move < 200 && !state.over; move++) {
    let idx = 0;
    let best = -1;
    state.room.forEach((card, i) => {
      if ((card.suit === 'Clubs' || card.suit === 'Spades') && card.value > best) {
        best = card.value;
        idx = i;
      }
    });
    const r = await req('POST', `/games/${g.id}/play`, { index: idx });
    assert.equal(r.status, 200, `move ${move} failed: ${r.text}`);
    state = r.json.state;
  }
  assert.equal(state.over, true, 'monster-first play should die within 200 moves');
  assert.equal(state.won, false);
  assert.equal(state.hp, 0);
  const after = await req('POST', `/games/${g.id}/play`, { index: 0 });
  assert.equal(after.status, 409);
  const fleeAfter = await req('POST', `/games/${g.id}/flee`);
  assert.equal(fleeAfter.status, 409);
});
