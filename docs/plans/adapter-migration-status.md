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

### ⏸️ Remaining (Low Priority)

| Feature | Old Handler | Reason | Priority |
|---------|-------------|--------|----------|
| `/cloud help` | `cloudHandler.ts` | Fallback works fine | Low |
| Commit proposals | `interactionHandler.ts` | Complex feature, rarely used | Low |
| Channel posts | `telegramHandler` | Rarely used feature | Low |

---

## Old Handler Analysis

### `controller/telegramHandler.ts` (1089 lines)

**Still Used For:**
- Cloud command routing (`/cloud run`, `/cloud repos`, etc.)
- Settings commands (identity, git user config)
- Session list formatting
- Channel posts
- Edited messages
- Error recovery

**Can Be Removed After:**
- Cloud commands migrated to CloudOrchestrator
- Settings commands migrated to CommandOrchestrator
- Session list formatting moved to shared service

### `controller/slackHandler.ts` (496 lines)

**Still Used For:**
- Similar to TelegramHandler - cloud, settings, lists
- Slack-specific message formatting

**Can Be Removed After:**
- Same as TelegramHandler

### `controller/cloudHandler.ts` (1528 lines)

**Status:** Mostly superseded by `CloudOrchestrator.ts`, but some edge cases remain.

### `controller/interactionHandler.ts` (514 lines)

**Status:** Contains complex commit_proposal logic. Should be kept until:
- Commit proposal flow is extracted to a dedicated service
- Or migrated to CloudOrchestrator

### `controller/commands.ts` (504 lines)

**Status:** Command parsers. Some migrated to RequestRouter, but:
- Cloud command parsers still needed
- Settings command parsers still needed

### `controller/settings.ts` (468 lines)

**Status:** Settings logic. Partially migrated to CommandOrchestrator, but:
- Identity settings (git user name/email) not migrated
- Branch name rules not migrated

### `controller/sessions.ts` (265 lines)

**Status:** Session list formatting. Needs to be moved to shared service.

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
        ┌───────────────┐         ┌───────────────┐
        │ New Adapter   │         │ Old Controller │
        │ (Try first)   │         │ (Fallback)     │
        └───────┬───────┘         └───────┬───────┘
                │                         │
        ┌───────┴─────────┐               │
        │                 │               │
        ▼                 ▼               │
   ┌─────────┐      ┌─────────┐           │
   │ Wizard  │      │ Command │           │
   │Orch.    │      │ Orch.   │           │
   └─────────┘      └─────────┘           │
                                        │
                        ┌───────────────┴───────────────┐
                        │                               │
                        ▼                               ▼
                ┌───────────────┐               ┌───────────────┐
                │ CloudHandler  │               │ Interaction   │
                │ Settings      │               │ Handler       │
                │ Sessions      │               └───────────────┘
                └───────────────┘
```

---

## Next Steps (Phase 9+)

1. **Migrate session list formatting** to `shared/SessionListFormatter.ts`
2. **Migrate cloud commands** completely to CloudOrchestrator
3. **Migrate settings commands** completely to CommandOrchestrator
4. **Extract commit proposal** to dedicated service
5. **Remove old handlers** only after all features migrated

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking existing features | High | Fallback mechanism + comprehensive tests |
| Cloud command edge cases | Medium | Keep CloudHandler for edge cases initially |
| Commit proposal complexity | High | Keep InteractionHandler until full rewrite |

---

**Last Updated:** 2026-02-07 (Phase 9 progress)
**Branch:** `feat/support_websocket`
**Test Status:** 705/706 passing (1 pre-existing failure)
