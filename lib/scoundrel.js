'use strict';
/**
 * Scoundrel, played in the terminal. The simplest faithful version of the
 * card game behind classicscoundrel.com, using the same rules as
 * CLASSIC_SCOUNDREL_RULES.md in the SydBal/scoundrel repo:
 *
 *   - 20 HP, max 20. 44-card deck: Hearts 2-10, Diamonds 2-10,
 *     Clubs 2-Ace, Spades 2-Ace. Aces are 14, J 11, Q 12, K 13.
 *   - Rooms of 4 face-up cards. After resolving a card, if exactly 1
 *     room card remains, 3 more are dealt — and that refill IS a new
 *     room: the heal and flee locks reset (this is progressRoom in the
 *     web game, and it is what makes runs winnable).
 *   - Hearts heal (once per room, capped at 20). Diamonds equip as a
 *     weapon. Clubs/Spades are monsters.
 *   - A fresh weapon blocks any one monster. After that, the weapon
 *     only blocks monsters weaker than the last monster it slew:
 *     its durability becomes that monster's value. Blocked damage is
 *     monster value minus weapon value (never below 0). An unblocked
 *     fight deals full damage and leaves durability unchanged.
 *   - Flee is allowed only before touching the room and not on
 *     consecutive rooms. Fleeing returns the room to the bottom of
 *     the deck and redeals. Playing a card locks flee for the room.
 *   - Win: deck exhausted, room cleared, HP above 0. Lose: HP hits 0.
 *
 * Zero dependencies, Node's built-in readline only. Run: node scoundrel.js
 * Optional: node scoundrel.js --seed 42  (reproducible shuffle, mulberry32)
 */

const SUIT_SYMBOL = { Hearts: '♥', Diamonds: '♦', Clubs: '♣', Spades: '♠' };

function valueToNumber(value) {
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (value === 'Jack') return 11;
  if (value === 'Queen') return 12;
  if (value === 'King') return 13;
  if (value === 'Ace') return 14;
  return 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildDeck() {
  const limited = ['2', '3', '4', '5', '6', '7', '8', '9', '10'];
  const full = [...limited, 'Jack', 'Queen', 'King', 'Ace'];
  const deck = [];
  for (const [suit, values] of [
    ['Hearts', limited],
    ['Diamonds', limited],
    ['Clubs', full],
    ['Spades', full],
  ]) {
    for (const label of values) deck.push({ suit, label, value: valueToNumber(label) });
  }
  return deck;
}

function shuffle(deck, rng) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardName(card) {
  return `${card.label}${SUIT_SYMBOL[card.suit]}`;
}

function newGame(seed) {
  const rng = seed === undefined ? Math.random : mulberry32(seed);
  const state = {
    deck: shuffle(buildDeck(), rng),
    room: [],
    discard: [],
    hp: 20,
    maxHp: 20,
    weapon: null, // { label, value } of the equipped diamond
    durability: undefined, // value of the last monster the weapon slew
    freshWeapon: false,
    healedThisRoom: false,
    roomTouched: false,
    fledLastRoom: false,
    fleeCount: 0,
    monstersSlain: 0,
    damageTaken: 0,
    potionsDrunk: 0,
    weaponsEquipped: 0,
    roomsCleared: 0,
    over: false,
    won: false,
  };
  dealRoom(state, 4);
  return state;
}

function dealRoom(state, count) {
  const dealt = state.deck.splice(0, count);
  state.room.push(...dealt);
  return dealt;
}

function canFlee(state) {
  if (state.over) return { ok: false, why: 'the run is over' };
  if (state.fledLastRoom) return { ok: false, why: 'you fled the last room' };
  if (state.roomTouched) return { ok: false, why: 'you already touched this room' };
  return { ok: true };
}

// Should the equipped weapon mitigate this monster? Mirrors
// shouldWeaponMitigateDamage in the web game.
function weaponMitigates(state, enemyValue) {
  if (!state.weapon) return false;
  if (state.freshWeapon) return true;
  if (state.durability === undefined) return false;
  return enemyValue < state.durability;
}

function fightPreview(state, card) {
  const weaponValue = state.weapon ? state.weapon.value : 0;
  const mitigated = weaponMitigates(state, card.value);
  const damage = mitigated ? Math.max(0, card.value - weaponValue) : card.value;
  return { mitigated, damage, blocked: card.value - damage };
}

function cardPreview(state, card) {
  if (card.suit === 'Hearts') {
    if (state.healedThisRoom) return 'potion, no effect (already healed this room)';
    const heal = Math.min(card.value, state.maxHp - state.hp);
    return `potion, heal ${heal}`;
  }
  if (card.suit === 'Diamonds') {
    return state.weapon ? `weapon, equip (replaces ${cardName(state.weapon)})` : 'weapon, equip';
  }
  const p = fightPreview(state, card);
  if (!state.weapon) return `monster, fight: take ${p.damage}`;
  if (p.mitigated) return `monster, fight: take ${p.damage} (blocked ${p.blocked})`;
  return `monster, fight: take ${p.damage} (weapon cannot block: needs a foe under ${state.durability})`;
}

// Resolve one room card. Returns the lines to print.
function playCard(state, index) {
  const events = [];
  if (state.over) return ['The run is over.'];
  const card = state.room[index];
  if (!card) return ['No card there.'];

  state.room.splice(index, 1);
  state.roomTouched = true;

  if (card.suit === 'Hearts') {
    if (state.healedThisRoom) {
      events.push(`You set aside the ${cardName(card)}. Already healed this room, so it does nothing.`);
    } else {
      const heal = Math.min(card.value, state.maxHp - state.hp);
      state.hp = Math.min(state.maxHp, state.hp + heal);
      state.healedThisRoom = true;
      state.potionsDrunk++;
      events.push(`You drank the ${cardName(card)}. Healed ${heal}. HP ${state.hp}/${state.maxHp}.`);
    }
    state.discard.push(card);
  } else if (card.suit === 'Diamonds') {
    if (state.weapon) {
      events.push(`You dropped the ${cardName(state.weapon)} and equipped the ${cardName(card)}.`);
      state.discard.push(state.weapon);
    } else {
      events.push(`You equipped the ${cardName(card)}.`);
    }
    state.weapon = card;
    state.freshWeapon = true;
    state.durability = undefined;
    state.weaponsEquipped++;
  } else {
    const p = fightPreview(state, card);
    const mitigated = weaponMitigates(state, card.value);
    state.hp = Math.max(0, state.hp - p.damage);
    state.damageTaken += p.damage;
    state.monstersSlain++;
    let line = `You fought the ${cardName(card)}.`;
    if (p.blocked > 0) line += ` Weapon blocked ${p.blocked}.`;
    line += p.damage > 0 ? ` Took ${p.damage} damage. HP ${state.hp}/${state.maxHp}.` : ` No damage. HP ${state.hp}/${state.maxHp}.`;
    events.push(line);
    if (mitigated) {
      state.durability = card.value;
      state.freshWeapon = false;
    }
    state.discard.push(card);
    if (state.hp <= 0) {
      state.over = true;
      state.won = false;
      events.push(`You died to the ${cardName(card)}.`);
      return events;
    }
  }

  // Room flow, mirroring progressRoom in the web game: when exactly 1
  // card remains, 3 more are dealt and the room locks reset. The refill
  // IS a new room, so healing unlocks again and flee becomes available
  // again, even right after a flee. Without this reset the game is
  // effectively unwinnable (verified by exhaustive search).
  if (state.room.length === 1) {
    // progressRoom runs even when the deck is empty (it just deals
    // nothing): the locks still reset, so flee/heal unlock for the
    // last card too.
    const n = Math.min(3, state.deck.length);
    dealRoom(state, n);
    state.roomsCleared++;
    state.roomTouched = false;
    state.healedThisRoom = false;
    state.fledLastRoom = false;
    if (n > 0) events.push(`One card left: fresh room, dealing ${n} more (flee and healing reset).`);
  }

  // Room cleared: deal a fresh room, or win if the deck is gone.
  if (state.room.length === 0) {
    if (state.deck.length === 0) {
      state.over = true;
      state.won = true;
      events.push('The dungeon is clear.');
    } else {
      state.roomsCleared++;
      state.roomTouched = false;
      state.healedThisRoom = false;
      state.fledLastRoom = false;
      dealRoom(state, Math.min(4, state.deck.length));
      events.push('Room cleared. Dealing a new room.');
    }
  }
  return events;
}

function flee(state) {
  const check = canFlee(state);
  if (!check.ok) return [`Cannot flee: ${check.why}.`];
  // Room cards return to the bottom of the deck, in room order.
  state.deck.push(...state.room);
  state.room = [];
  state.fleeCount++;
  state.fledLastRoom = true;
  state.roomTouched = false;
  state.healedThisRoom = false;
  dealRoom(state, Math.min(4, state.deck.length));
  return ['You fled. The room returns to the bottom of the deck.'];
}

function weaponStatus(state) {
  if (!state.weapon) return 'none';
  if (state.freshWeapon) return `${cardName(state.weapon)} (fresh, blocks any one foe)`;
  return `${cardName(state.weapon)} (blocks foes under ${state.durability})`;
}

function render(state) {
  const lines = [];
  lines.push(`HP ${state.hp}/${state.maxHp}  |  Weapon: ${weaponStatus(state)}  |  Deck: ${state.deck.length}  |  Discard: ${state.discard.length}  |  Rooms cleared: ${state.roomsCleared}  |  Flees: ${state.fleeCount}`);
  lines.push('Room:');
  state.room.forEach((card, i) => {
    lines.push(`  [${i + 1}] ${cardName(card)} — ${cardPreview(state, card)}`);
  });
  const fleeCheck = canFlee(state);
  lines.push(fleeCheck.ok ? '  [f] Flee this room' : `  [f] Flee (unavailable: ${fleeCheck.why})`);
  lines.push('  [h] Help   [q] Quit');
  return lines.join('\n');
}

function statsLine(state) {
  return `Monsters slain: ${state.monstersSlain} | Damage taken: ${state.damageTaken} | Potions: ${state.potionsDrunk} | Weapons: ${state.weaponsEquipped} | Flees: ${state.fleeCount} | Rooms cleared: ${state.roomsCleared}`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Scoundrel, in the terminal.\n\n  node scoundrel.js [--seed N]\n\nPlay a card with its number, f to flee, h for help, q to quit.\nClear all 44 cards to win. Survive at 1 HP or more.');
    return;
  }
  let seed;
  const seedIdx = args.findIndex((a) => a === '--seed');
  if (seedIdx >= 0 && args[seedIdx + 1] !== undefined) seed = Number(args[seedIdx + 1]);
  const seedArg = args.find((a) => a.startsWith('--seed='));
  if (seedArg) seed = Number(seedArg.slice('--seed='.length));

  // rl.question() drops pending reads when piped stdin hits EOF, so read
  // lines through a queue instead: every line is kept, EOF yields null.
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queued = [];
  let waiter = null;
  let inputClosed = false;
  rl.on('line', (line) => {
    if (waiter) { const w = waiter; waiter = null; w(line); }
    else queued.push(line);
  });
  rl.on('close', () => {
    inputClosed = true;
    if (waiter) { const w = waiter; waiter = null; w(null); }
  });
  const ask = (q) => {
    process.stdout.write(q);
    if (queued.length) return Promise.resolve(queued.shift());
    if (inputClosed) return Promise.resolve(null);
    return new Promise((resolve) => { waiter = resolve; });
  };

  console.log('SCOUNDREL — clear the dungeon, stay above 0 HP. 20 HP, 44 cards, rooms of 4.');
  let again = true;
  while (again) {
    const state = newGame(seed);
    if (seed !== undefined) seed++;
    console.log(render(state));
    while (!state.over) {
      const raw = await ask('> ');
      if (raw === null || raw === undefined) break;
      const input = raw.trim().toLowerCase();
      if (input === 'q' || input === 'quit') {
        console.log('You walk away from the dungeon.');
        rl.close();
        return;
      }
      if (input === 'h' || input === 'help') {
        console.log('Pick a card by number. Hearts heal once per room. Diamonds equip as your weapon. Clubs and Spades are monsters; your weapon blocks a monster only if it is weaker than the last one the weapon slew (a fresh weapon blocks anything once). Flee (f) only works in a fresh room, before you touch a card, and never twice in a row. Each refill (1 card left, 3 dealt) is a fresh room: healing and flee unlock again.');
        continue;
      }
      if (input === 'f' || input === 'flee') {
        for (const line of flee(state)) console.log(line);
        console.log(render(state));
        continue;
      }
      const n = Number(input);
      if (Number.isInteger(n) && n >= 1 && n <= state.room.length) {
        for (const line of playCard(state, n - 1)) console.log(line);
        if (!state.over) console.log(render(state));
        continue;
      }
      console.log('Unknown command. Use a card number, f, h, or q.');
    }
    if (state.over) {
      console.log(state.won ? 'YOU WIN. The dungeon is clear.' : 'YOU DIED. The dungeon keeps your bones.');
      console.log(statsLine(state));
      const answer = (await ask('Play again? (y/n) ')).trim().toLowerCase();
      again = answer === 'y' || answer === 'yes';
    } else {
      again = false;
    }
  }
  rl.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  valueToNumber,
  mulberry32,
  buildDeck,
  shuffle,
  cardName,
  newGame,
  canFlee,
  weaponMitigates,
  fightPreview,
  playCard,
  flee,
  render,
};
