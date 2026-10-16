# Dependency security update — October 16, 2026

A fresh audit found five high-severity findings in the Tailwind 3 build chain. They shared one root cause: the braces parser has no patched release for [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).

## Changes

- Upgrade Tailwind CSS and its CLI to 4.3.3.
- Override the CLI’s pinned file watcher with API-compatible `@parcel/watcher` 2.6.0, which uses picomatch instead of the vulnerable micromatch/braces chain.
- Remove braces, micromatch, and the old chokidar chain from the lockfile.
- Retain the existing static theme, browser reset, and the legacy spacing, divide, outline, and grid rules used by the app. These are licensed CSS/data, with no old compiler or parser code.
- Make the landing page’s responsive heading line heights explicit.
- Add CI checks for all dependency advisories, reproducible CSS builds, and browser controls/layouts.

## Building styles

Run `npm ci`, then `npm run build:css`. The compiler scans `views` and `public/js`; add complete utility class names to those source files. For new layouts, use current Tailwind utilities and prefer `gap` over legacy `space-*` classes.

The maintained compatibility classes are excluded from automatic generation and defined in `src/styles/tailwind-legacy-utilities.css`. Theme values live in `src/styles/tailwind-compat-theme.json`; the reset lives in `src/styles/tailwind-base.css`. Their upstream MIT license is included alongside them.

Tailwind 4 targets Safari 16.4+, Chrome 111+, and Firefox 128+; see the [official upgrade guide](https://tailwindcss.com/docs/upgrade-guide). Browser regression checks here use Chromium at mobile and desktop sizes.

## Validation

- `npm audit` reports zero findings across production and development dependencies.
- Sixteen before/after page views (landing, login, registration, dashboard, Settings, shared chats, and guest pages at 390/1280 pixels) retain identical measured layouts. Screenshot comparisons found no pixels differing by more than 3 RGB units.
- Browser regressions exercise menus, chat selection, quoted replies, Settings controls, group drops, and legacy CSS behavior.
- Full application suite: 116 suites and 1,671 tests passed; 51 tests were skipped. A pre-existing Redis connection leak in the dashboard-stop test fixture was isolated, and its focused open-handle check exits cleanly.
- All 12 browser regressions passed.
- The CLI watch mode rebuilds after a source edit with the patched watcher.
