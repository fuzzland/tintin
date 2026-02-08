# Adapter Migration Status

> Track progress of migrating from old controller/handlers to new adapter architecture.

---

## Migration Progress

### ✅ Completed (Phases 1-9)

| Feature | Old Handler | New Location | Status |
|---------|-------------|--------------|--------|
| Action parsing | `telegramHandler.parseTelegramInteractionAction` | `shared/ActionParser.ts` | ✅ Migrated |
| Access control | `telegramAccessDecision`, `slackAccessDecision` | `shared/AccessControl.ts` | ✅ Migrated |
| UI building | `buildRunActionTelegramKeyboard` | `shared/UIBuilder.ts` | ✅ Migrated |
| Session messages | `controller2.handleSessionMessage` | `orchestrator/SessionOrchestrator.ts` | ✅ Migrated |
| Wizard flow | `telegramHandler` wizard logic | `orchestrator/WizardOrchestrator.ts` | ✅ Migrated |
| Commands (basic) | `commands.ts` parsers | `orchestrator/CommandOrchestrator.ts` | ✅ Migrated |
| Telegram callbacks (basic) | `telegramHandler.handleTelegramCallback` | `adapters/TelegramAdapter.ts` | ✅ Migrated |
| Slack interactions (basic) | `slackHandler.handleSlackInteraction` | `adapters/SlackAdapter.ts` | ✅ Migrated |
| Session list formatting | `sessions.ts` | `shared/SessionListFormatter.ts` | ✅ Migrated (Phase 9) |
| Cloud commands (most) | `cloudHandler.ts` | `adapters/RequestRouter.ts` | ✅ Migrated (Phase 9) |
| Settings (identity/git) | `settings.ts` | `orchestrator/CommandOrchestrator.ts` | ✅ Migrated (Phase 9) |
| Commit proposals | `interactionHandler.ts` | `orchestrator/CommitProposalOrchestrator.ts` | ✅ Migrated |
| Channel posts | `telegramHandler` | `adapters/TelegramAdapter.ts` | ✅ Migrated |

### ✅ Removed Legacy Controller Modules

- `src/runtime/controller/commands.ts`
- `src/runtime/controller/settings.ts`
- `src/runtime/controller/types.ts`
- `src/runtime/controller/sessions.ts`
- `src/runtime/controller/utils.ts`

---

## Current Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    HTTP Server (httpServer.ts)              │
└─────────────────────────────────────────────────────────────┘
                             │
                ┌────────────┴────────────┐
                │                         │
                ▼                         ▼
        ┌───────────────┐
        │ New Adapter   │
        └───────┬───────┘
                │                         │
        ┌───────┴─────────┐               │
        │                 │               │
        ▼                 ▼               │
   ┌─────────┐      ┌─────────┐           │
   │ Wizard  │      │ Command │           │
   │Orch.    │      │ Orch.   │           │
   └─────────┘      └─────────┘           │
```

---

## Next Steps

- Monitor for regressions after controller removal.

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking existing features | High | Fallback mechanism + comprehensive tests |
| Cloud command edge cases | Medium | Keep CloudHandler for edge cases initially |
| Commit proposal complexity | High | Keep InteractionHandler until full rewrite |

---

**Last Updated:** 2026-02-08
**Branch:** `feat/support_websocket`
**Test Status:** typecheck + targeted orchestrator/adapter tests passing
