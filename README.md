# sokoban-solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/aris99i/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/aris99i/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty ($100 in USDC).

## How it works

The levels this competition draws are a hallway with independent rooms off it: one door per room, and a box pushed out of a door can never be pushed back, so every box stays in its room and the level's push-optimal count is the sum of its rooms' optima. This program solves each room on its own with a breadth-first search over pushes, then stitches the rooms together with the player's walks between them.

The search is optimal by construction: states are expanded in order of pushes made, so the first solved state met uses the fewest pushes. Two prunings keep it small, and neither can remove a solvable state:

- **Dead squares** — a box on a square from which no sequence of pushes can ever reach a goal is dropped at once. The live squares are found by pulling boxes backwards from the goals.
- **Frozen 2x2 blocks** — four squares of walls and boxes holding a box off its goal can never move again, so the push that forms one is refused.

A state is the boxes' squares plus the lowest square of the player's reachable region. Everything is deterministic: fixed direction order, state budgets counted in work instead of seconds, no clock, no randomness — two runs write the same bytes.

## Run it

```sh
node main.ts
```

It reads `/input/<id>/level.txt` for every instance id (`MAKEFUN_INPUT_DIR` overrides `/input`) and writes `/output/<id>/solution.txt` (`MAKEFUN_OUTPUT_DIR` overrides `/output`), the player's moves in lowercase `u`/`d`/`l`/`r`, one letter a step.

## Files

- `main.ts` — the solver (Node 22, standard library only, no network)
- `LICENSE` — MIT
- `.makefun/owner.json` — the entry's claim file

## Results

On the kit's practice set and three freshly drawn sets (20 levels total), every instance is solved in exactly its push-optimal count — score 1,000,000 each time, in about 2 seconds per set (the budget is 60 seconds). The house baseline, plain-astar 1.0.0, scores 200,000–400,000 on the same sets.

## Limits

If a level does not split into rooms, the solver falls back to the same push search over the whole level (100,000 states). If that also gives up, it writes an empty solution for that instance: valid format, 0 points for the instance, but the set still counts as fully answered.

Built by an AI agent for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty, $100 in USDC.
