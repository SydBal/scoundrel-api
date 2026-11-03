# scoundrel-api

Scoundrel, the single-player roguelike card game, over HTTP. A tiny JSON API around the Scoundrel engine. Zero dependencies, Node's built-in `http` only.

The engine is `lib/scoundrel.js`: a verbatim copy of the engine from [SydBal/scoundrel-CLI](https://github.com/SydBal/scoundrel-CLI) (the same rules as [classicscoundrel.com](https://classicscoundrel.com): 44 cards, 20 HP, rooms of 4, weapons, flee rules, and the refill-is-a-new-room reset). The API holds one engine state object per game and mutates it with the engine's own `playCard` and `flee` functions, so the API can never disagree with the terminal game about the rules. To refresh the engine after the CLI changes, copy it over and keep it byte-identical:

```
cp ../scoundrel-cli/scoundrel.js lib/scoundrel.js
```

## Run

```
node server.js
```

`PORT` env var, default 3000. Games live in memory, in this process. Restarting the server forgets them.

## Endpoints

| Method | Path | Body | What it does |
| --- | --- | --- | --- |
| GET | `/health` | | `{ ok: true }` |
| GET | `/` | | Endpoint index |
| POST | `/games` | `{ seed? }` | Create a game. A seed plays the same shuffle every time. Returns 201 with the game id and state. |
| GET | `/games` | | List games |
| GET | `/games/:id` | | One game |
| POST | `/games/:id/play` | `{ index }` | Play a room card. `index` is 0-based. Returns the event lines, the new state, and the CLI-style text render. |
| POST | `/games/:id/flee` | | Flee the room, when the rules allow. 409 when fleeing is not allowed, with the reason. |
| DELETE | `/games/:id` | | Forget a game |

Errors are JSON: unknown game is 404, a bad card index or bad JSON is 400, playing or fleeing when the rules forbid it is 409.

## The game state

Every game response carries `state`:

```
{
  "hp": 20, "maxHp": 20,
  "weapon": null,
  "durability": null, "freshWeapon": false,
  "room": [{ "suit": "Clubs", "label": "Queen", "value": 12, "preview": "monster, fight: take 12" }],
  "deckCount": 40, "discardCount": 0,
  "roomsCleared": 0, "fleeCount": 0,
  "canFlee": true, "fleeWhy": null,
  "over": false, "won": false,
  "stats": { "monstersSlain": 0, "damageTaken": 0, "potionsDrunk": 0, "weaponsEquipped": 0 }
}
```

`text` is the same render the terminal game prints. `events` on play and flee are the lines the terminal game would print for that move.

## Examples

```
# Start a game
curl -s -X POST localhost:3000/games | python3 -m json.tool

# Start a reproducible game
curl -s -X POST localhost:3000/games -H 'Content-Type: application/json' -d '{"seed": 42}'

# Play the first room card (replace ID)
curl -s -X POST localhost:3000/games/<id>/play -H 'Content-Type: application/json' -d '{"index": 0}'

# Flee a fresh room
curl -s -X POST localhost:3000/games/<id>/flee
```

## Tests

```
npm test
```

Zero-dependency tests. They boot the server on an ephemeral port and drive it over HTTP with `fetch`.

## License

MIT.
