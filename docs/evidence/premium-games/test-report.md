# Premium games test report

## Rummy and catalogue checks — 2026-08-21

| Command | Result |
|---|---|
| `.venv/bin/pytest -q backend/test_rummy_engine.py` | PASS — 23 tests |
| `.venv/bin/python -m py_compile backend/rummy.py backend/routes_rummy.py backend/server.py backend/seed.py backend/game_access.py` | PASS |
| `.venv/bin/python backend/test_enable_all_games.py` | PASS — focused migration and route guards |
| `.venv/bin/python backend/test_public_catalog.py` | PASS — focused public catalogue checks |
| `.venv/bin/python backend/test_gameplay_readiness.py` | PASS — 4 tests |
| `.venv/bin/pytest -q backend` | PASS — 105 tests and 2 subtests |
| `CI=true ./node_modules/.bin/craco test --watchAll=false --runInBand` | PASS — exact staged tree, 23 suites and 103 tests |
| `GENERATE_SOURCEMAP=false ./node_modules/.bin/craco build` | PASS — exact staged tree; 706.85 kB JS and 52.42 kB CSS gzip |
| `git diff --check -- <Rummy and integration paths>` | PASS |

Coverage includes the 106-card/two-deck model, printed jokers, secure deterministic proof verification, wild-rank natural pure sequences, declaration constraints, scoring hierarchy, exactly five categories/seats, frozen room rules, exact LIVE stake conservation, wallet-neutral Practice, deadline rejection, reconnect/skill rules, private group-version isolation, action replay, opponent-hand privacy, catalogue art/availability, own-seat card-back privacy, single-flight polling, one active timer, and safe viewport CSS.

Not yet executed: a real Mongo replica-set five-browser live match, network interruption at every action phase, screenshot comparison on physical devices, and long-session memory soak. These remain explicit evidence gaps, not implied passes.

The production build reported only two pre-existing hook-dependency warnings in Pappu Pictures and 7Up7Down; it reported no Rummy warning. CRA also reported the existing large-bundle advisory.
