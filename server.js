'use strict';
/**
 * Scoundrel, over HTTP. A tiny JSON API around the Scoundrel engine in
 * lib/scoundrel.js (a verbatim copy of the engine from SydBal/scoundrel-CLI).
 * Zero dependencies, Node's built-in http only.
 *
 *   node server.js            (PORT env var, default 3000)
 *
 * Games live in memory, in this process. Restarting the server forgets
 * them. One game is one engine state object, mutated in place by the
 * engine's own playCard/flee functions, so the API can never disagree
 * with the terminal game about the rules.
 *
 * Endpoints:
 *   GET  /health               -> { ok: true }
 *   GET  /                      -> endpoint index
 *   POST /games                -> create a game, optional { seed }
 *   GET  /games                -> list games
 *   GET  /games/:id            -> one game
 *   POST /games/:id/play       -> { index } (0-based) plays a room card
 *   POST /games/:id/flee       -> flee the room, when the rules allow
 *   DELETE /games/:id          -> forget a game
 */

const http = require('node:http');
const crypto = require('node:crypto');

const engine = require('./lib/scoundrel.js');

/** One line of preview for a room card, mirroring the CLI's cardPreview. */
function cardPreview(state, card) {
  if (card.suit === 'Hearts') {
    if (state.healedThisRoom) return 'potion, no effect (already healed this room)';
    const heal = Math.min(card.value, state.maxHp - state.hp);
    return `potion, heal ${heal}`;
  }
  if (card.suit === 'Diamonds') {
    return state.weapon ? `weapon, equip (replaces ${engine.cardName(state.weapon)})` : 'weapon, equip';
  }
  const p = engine.fightPreview(state, card);
  if (!state.weapon) return `monster, fight: take ${p.damage}`;
  if (p.mitigated) return `monster, fight: take ${p.damage} (blocked ${p.blocked})`;
  return `monster, fight: take ${p.damage} (weapon cannot block: needs a foe under ${state.durability})`;
}

function weaponView(state) {
  if (!state.weapon) return null;
  const status = state.freshWeapon
    ? `${engine.cardName(state.weapon)} (fresh, blocks any one foe)`
    : `${engine.cardName(state.weapon)} (blocks foes under ${state.durability})`;
  return { suit: state.weapon.suit, label: state.weapon.label, value: state.weapon.value, status };
}

/** The public shape of a game: the engine state, plus previews and counts. */
function publicState(state) {
  const fleeCheck = engine.canFlee(state);
  return {
    hp: state.hp,
    maxHp: state.maxHp,
    weapon: weaponView(state),
    durability: state.durability === undefined ? null : state.durability,
    freshWeapon: state.freshWeapon,
    room: state.room.map((card) => ({
      suit: card.suit,
      label: card.label,
      value: card.value,
      preview: cardPreview(state, card),
    })),
    deckCount: state.deck.length,
    discardCount: state.discard.length,
    roomsCleared: state.roomsCleared,
    fleeCount: state.fleeCount,
    canFlee: fleeCheck.ok ? true : false,
    fleeWhy: fleeCheck.ok ? null : fleeCheck.why,
    over: state.over,
    won: state.won,
    stats: {
      monstersSlain: state.monstersSlain,
      damageTaken: state.damageTaken,
      potionsDrunk: state.potionsDrunk,
      weaponsEquipped: state.weaponsEquipped,
    },
  };
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(Object.assign(new Error('body must be a JSON object'), { status: 400 }));
          return;
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function createServer() {
  const games = new Map();

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const parts = path.split('/').filter(Boolean);

      if (req.method === 'GET' && path === '/health') {
        return send(res, 200, { ok: true });
      }

      if (req.method === 'GET' && path === '/') {
        return send(res, 200, {
          name: 'scoundrel-api',
          description: 'Scoundrel, the single-player card game, over HTTP.',
          endpoints: [
            'GET /health',
            'POST /games { seed? }',
            'GET /games',
            'GET /games/:id',
            'POST /games/:id/play { index }',
            'POST /games/:id/flee',
            'DELETE /games/:id',
          ],
        });
      }

      if (path === '/games' && req.method === 'POST') {
        const body = await readBody(req);
        if (body.seed !== undefined) {
          if (typeof body.seed !== 'number' || !Number.isFinite(body.seed)) {
            return send(res, 400, { error: 'seed must be a number' });
          }
        }
        const state = engine.newGame(body.seed);
        const id = crypto.randomUUID();
        games.set(id, state);
        return send(res, 201, { id, state: publicState(state), text: engine.render(state) });
      }

      if (path === '/games' && req.method === 'GET') {
        const list = [...games.entries()].map(([id, state]) => ({
          id,
          hp: state.hp,
          roomCards: state.room.length,
          deckCount: state.deck.length,
          over: state.over,
          won: state.won,
        }));
        return send(res, 200, { games: list });
      }

      if (parts[0] === 'games' && parts.length === 2) {
        const id = decodeURIComponent(parts[1]);
        const state = games.get(id);
        if (!state) return send(res, 404, { error: 'no such game' });

        if (req.method === 'GET') {
          return send(res, 200, { id, state: publicState(state), text: engine.render(state) });
        }

        if (req.method === 'DELETE') {
          games.delete(id);
          res.writeHead(204);
          return res.end();
        }

        return send(res, 404, { error: 'not found' });
      }

      if (parts[0] === 'games' && parts.length === 3 && parts[2] === 'play' && req.method === 'POST') {
        const id = decodeURIComponent(parts[1]);
        const state = games.get(id);
        if (!state) return send(res, 404, { error: 'no such game' });
        if (state.over) {
          return send(res, 409, { error: 'game over', won: state.won });
        }
        const body = await readBody(req);
        const index = body.index;
        if (!Number.isInteger(index) || index < 0 || index >= state.room.length) {
          return send(res, 400, { error: `index must be an integer from 0 to ${state.room.length - 1}` });
        }
        const events = engine.playCard(state, index);
        return send(res, 200, { id, events, state: publicState(state), text: engine.render(state) });
      }

      if (parts[0] === 'games' && parts.length === 3 && parts[2] === 'flee' && req.method === 'POST') {
        const id = decodeURIComponent(parts[1]);
        const state = games.get(id);
        if (!state) return send(res, 404, { error: 'no such game' });
        if (state.over) {
          return send(res, 409, { error: 'game over', won: state.won });
        }
        const check = engine.canFlee(state);
        if (!check.ok) {
          return send(res, 409, { error: 'cannot flee', why: check.why });
        }
        await readBody(req).catch(() => ({}));
        const events = engine.flee(state);
        return send(res, 200, { id, events, state: publicState(state), text: engine.render(state) });
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (err && err.status) return send(res, err.status, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'internal error' });
    }
  };

  return http.createServer(handler);
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => {
    console.log(`Scoundrel API listening on http://localhost:${port}`);
  });
}

module.exports = { createServer };
