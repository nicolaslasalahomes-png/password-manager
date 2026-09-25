# CLAUDE.md — Password Manager

Read `~/.claude/CLAUDE.md` first for workspace-wide rules. This file adds project specifics.

## What this project is

Personal password vault. Zero-knowledge two-password model (planned). Built with React + Tauri (desktop app) + browser extension + Supabase. This is a personal project on the `nicolassut` GitHub account — direct pushes to main are OK here (unlike business projects).

## Key architectural facts

- **Stack:** React 18 + TypeScript + Vite + Tailwind
- **Desktop:** Tauri (`src-tauri/`) — wraps the web app as a native desktop app
- **Browser extension:** `extension/` folder — separate Vite build (`vite.extension.config.ts`)
- **Backend:** Supabase (credentials in memory — never commit them)
- **Auth:** Two-password model planned: one to authenticate, one to decrypt locally. Server never sees the decryption key.
- **Build configs:** 3 separate tsconfigs (app, extension, node) — be careful which one applies when editing

## Source layout

```
src/             — main web/desktop app
  components/
  lib/
  pages/
  state/
  App.tsx
  QuickAddWindow.tsx  — Tauri quick-add overlay
  TwoFactorPopover.tsx
extension/       — browser extension source
src-tauri/       — Tauri Rust backend
```

## Critical rules

- **Zero-knowledge:** Encryption/decryption must happen client-side only. Never send plaintext passwords or decryption keys to the server.
- **Personal project** — push to main is fine, no preview approval required.
- **Three build targets:** web app, desktop (Tauri), extension. Changes to shared code affect all three.

## Issue state

Active issues tracked in `~/.claude/issues/password-manager/`. Read the relevant STATE.md before starting work.
