<img src='./img/sign.svg' width='500' alt='Automerge logo' />

## Deprecation Notice

Automerge now has a shiny new implementation at https://github.com/automerge/automerge. This repository is the original pure javascript implementation. All development effort has shifted to the new implementation which is written in Rust and so can easily be ported to other platforms. 

## Original Readme

💬 [Join the Automerge Slack community](https://join.slack.com/t/automerge/shared_invite/zt-e4p3760n-kKh7r3KRH1YwwNfiZM8ktw)

[![Build Status](https://github.com/automerge/automerge/actions/workflows/automerge-ci.yml/badge.svg)](https://github.com/automerge/automerge/actions/workflows/automerge-ci.yml)
[![Browser Test Status](https://app.saucelabs.com/buildstatus/automerge)](https://app.saucelabs.com/open_sauce/user/automerge/builds)

Automerge is a library of data structures for building collaborative applications in JavaScript.

Please see [automerge.org](http://automerge.org/) for documentation.

For a set of extensible examples in TypeScript, see [automerge-repo](https://github.com/automerge/automerge-repo)

## Setup

If you're using npm, `npm install automerge`. If you're using pnpm, `pnpm add automerge`. Then you
can import it with `import * as Automerge from 'automerge'`. The package is ESM-only;
`require()` is not supported.

Otherwise, clone this repository, and then you can use the following commands:

- `pnpm install` — installs dependencies.
- `pnpm test` — type-checks and runs the Vitest suite in Node.
- `pnpm run coverage` — runs the test suite with coverage reporting.
- `pnpm run build` — builds `dist/` with Vite in library mode: a UMD bundle `dist/automerge.js`
  for web browsers (bundles the dependencies, loadable through a script tag), plus the ES modules
  `dist/automerge.mjs` and `dist/classic.mjs`.

## Meta

Copyright 2017–2021, the Automerge contributors. Released under the terms of the
MIT license (see `LICENSE`).
