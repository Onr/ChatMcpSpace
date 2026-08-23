# Mobile Dashboard Feature Checklist

**Date:** 2026-05-18

This checklist defines what the dashboard must support on mobile. Items marked **Required** are core workflows; the mobile UI is considered broken if any of them are unavailable.

## Required Mobile Features

- **Agent selection:** user can open the agent list, search all agents, select an agent, and the search field clears/blurs after selection.
- **Correct active chat:** header, selected agent state, and rendered messages must always belong to the same selected agent.
- **Latest message on open:** opening a chat lands on the newest rendered message, while background history loading must not jump the view.
- **Composer visibility:** textbox, settings/model button, stop button, file attachment, image attachment, and send button must remain visible when keyboard is open or closed.
- **Send behavior:** pressing Send must not scroll the conversation upward.
- **Scroll to latest:** a visible down button appears when away from the bottom, and one tap shows the newest message.
- **Model/provider sheet:** settings sheet must open above the composer and remain usable on small screens.
- **Mobile action menus:** password/archive/voice/group actions are folded behind the mobile council menu; Settings/Logout are folded behind the mobile nav menu.
- **No mobile side pinning:** side-chat pin affordances are hidden on mobile/touch layouts.
- **Rich/interactive content:** Agent Space collapses when the textbox is focused so the composer stays usable.
- **Attachments:** file and image attach controls sit inside the composer tray and stay next to the other controls.
- **Rotated phone layout:** wide touch/landscape screens must keep the page height constrained and make only the message list scroll.

## Performance Features

- **Initial message load:** load recent messages first, then hydrate older history without blocking chat open.
- **Stable polling:** polling and background loads must not repaint stale chats or jump the scroll position.
- **Fast Mode:** a mobile-only toggle enables a minimal interface for testing responsiveness. It keeps only agent selection, active agent header, messages, scroll-to-bottom, and composer controls, while hiding/de-emphasizing expensive decorative or secondary panels.

## Regression Coverage

Current guards live mainly in:

- `tests/ui/mobile-css-regressions.test.js`
- `tests/ui/mobile-layout.test.js`
- `tests/ui/mobile-composer-visual.spec.js`
- `tests/e2e/mobile-dashboard-visibility-audit.js`

The tests should verify required controls exist in markup/CSS/JS and that Fast Mode preserves the core workflow while hiding nonessential UI.

