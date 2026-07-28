# Taskloop

Lightweight task tracking for small product teams. Plan the week, assign work,
and keep everyone pointed at the same three things.

This is the golden fixture for Superdemovideo's pipeline: a small but realistic
single-page app with routing, seeded data, a login step and an end-to-end test
suite. It exists so the pipeline has something honest to build, drive and film.

## Features

- **Dashboard** — open work, grouped by status, with weekly throughput.
- **Task composer** — create a task, assign an owner, set a due date.
- **Team settings** — invite a teammate by email and choose their role.

## Running it

```bash
npm install
npm run build
npm start      # http://127.0.0.1:3100
```

## Tests

```bash
npm run test:e2e
```

The suite signs in once in `e2e/auth.setup.ts` and reuses that session, so the
specs describe user journeys rather than login mechanics.
