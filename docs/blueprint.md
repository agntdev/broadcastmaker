# Manual Broadcast Manager — Bot specification

**Archetype:** community

**Voice:** warm and concise — write every user-facing message, button label, error, and empty state in this voice.

A compact Telegram bot that lets a single admin compose, preview, target, and send one-off manual broadcasts (text, image + caption, optional up to 3 quick buttons) to an opt-in subscriber list; persists drafts and send history; streams progress during sends and posts a short delivery summary to the admin chat.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- small teams and communities
- creators who need manual one-off broadcasts
- admins managing subscriber lists (0–50k)

## Success criteria

- Subscribers can opt in/out via /start buttons and their choice is persisted
- Admin can compose, preview, edit, cancel, and send a broadcast to All or a pasted list of user IDs
- Bot streams send progress and produces a final delivery summary posted to the ADMIN_CHAT_ID
- Broadcast and subscriber records persist across restarts and produce accurate sent/failed/unsubscribe counts

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open the main menu and show Subscribe / Unsubscribe buttons for opt-in control
- **Subscribe** (button, actor: user, callback: subscribe:opt_in) — Opt the user into broadcasts; store subscriber record
  - outputs: Subscriber created/updated (id, opt-in timestamp, language tag), Admin notified of new opt-in
- **Unsubscribe** (button, actor: user, callback: subscribe:opt_out) — Remove user from subscriber list
  - outputs: Subscriber flagged unsubscribed, Confirmation message to user
- **/create** (command, actor: admin, command: /create) — Start guided wizard to compose a one-off broadcast (message type, content, optional up to 3 quick buttons)
  - inputs: message type (text | image+caption), text content or image file + caption, optional quick button labels (0–3), target selection (All | paste list of user IDs)
  - outputs: Broadcast draft saved, Preview shown, Options: Edit / Cancel / Send

## Flows

### Subscriber opt-in/out
_Trigger:_ /start or Subscribe/Unsubscribe button

1. User sends /start or taps Subscribe/Unsubscribe
2. Bot shows Subscribe and Unsubscribe inline buttons
3. On Subscribe: create or update Subscriber record with chat id, timestamp, language tag
4. On Unsubscribe: mark Subscriber as unsubscribed and confirm to user
5. Notify admin chat of new opt-ins (batched or immediate per config)

_Data touched:_ Subscriber

### Admin create broadcast (wizard)
_Trigger:_ /create

1. Verify actor is ADMIN_CHAT_ID
2. Wizard step 1: choose message type (text | image+caption)
3. Wizard step 2: capture content (text input or receive image + caption)
4. Wizard step 3: optional add up to 3 quick-action inline buttons (labels only)
5. Wizard step 4: choose target (All subscribers or paste newline-separated user IDs)
6. Wizard step 5: show Preview with Edit / Cancel / Send buttons

_Data touched:_ BroadcastDraft

### Send broadcast
_Trigger:_ Admin confirms Send

1. Lock draft to prevent concurrent edits
2. Resolve target list (All subscribers filtered by subscribed flag, or parsed pasted IDs)
3. Queue messages and send in safe background batches (system-chosen batch size and delay)
4. Stream periodic progress updates to admin (sent, failed, remaining)
5. Handle per-message API errors (count failures, skip blocked users)
6. On completion, persist SentBroadcast record and post delivery summary to ADMIN_CHAT_ID

_Data touched:_ BroadcastDraft, SentBroadcast, Subscriber

### Preview / Edit / Cancel flow
_Trigger:_ Preview screen actions

1. Preview displays final rendered message (text or image+caption) with quick buttons
2. Edit re-opens the wizard at the relevant step and updates BroadcastDraft
3. Cancel discards the draft or marks it cancelled
4. Send proceeds to Send broadcast flow

_Data touched:_ BroadcastDraft

### Custom target paste parsing
_Trigger:_ Admin pastes newline/CSV list during targeting step

1. Accept pasted text input
2. Parse newline-separated values, trimming whitespace and ignoring empty lines
3. Validate values look like Telegram chat IDs (numeric) and dedupe
4. Show a preview count and any invalid entries to admin for confirmation

_Data touched:_ BroadcastDraft

## Owner-supplied settings

The OWNER provides these; they are collected in chat and injected into the environment at deploy. Read each one from the environment where it is used (`ctx.env.<KEY>` / `env.<KEY>` on Cloudflare Workers; `process.env.<KEY>` only as a Node/harness fallback — never the sole read). Do NOT invent your own way of learning the value, do NOT ask for it in a bot message, and do NOT hardcode a default.

- **ADMIN_CHAT_ID** — Telegram chat id where admin actions and notifications are delivered
  - this is the OWNER's own chat id; the platform already knows it. Read `ADMIN_CHAT_ID` via `ctx.env` (prefer toolkit `adminChatId` / `requireOwner`) — never ask a user, never treat whoever writes first as the admin, never invent claim-admin or open manage for everyone.
  - may be UNSET at runtime: the bot must still start, and the feature needing ADMIN_CHAT_ID must say so plainly instead of failing.

Your behavioral specs run WITHOUT these values, so no spec may depend on one.

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

An entity that merely NAMES an owner-supplied setting above (an admin chat, an API account) is not something to store or discover — read it from the environment.

- **Subscriber** _(retention: persistent)_ — A Telegram chat that opted into broadcasts
  - fields: chat_id (integer), opt_in_timestamp (ISO datetime), opt_out_timestamp (ISO datetime | null), language_tag (string, optional), status (subscribed|unsubscribed), metadata (small JSON for source, e.g., 'start_payload')
- **BroadcastDraft** _(retention: persistent)_ — In-progress broadcast composition stored per admin
  - fields: draft_id, created_by_admin_chat_id, created_at, message_type (text | image), text_content, image_file_id (Telegram file_id, optional), caption (optional), quick_buttons (array of label strings, max 3), target_mode (all | custom_list), custom_target_list (array of chat_id integers, optional), status (editing|ready|sending|cancelled)
- **SentBroadcast** _(retention: persistent)_ — Record of a completed or aborted send with counts and targeting info
  - fields: broadcast_id, sent_at, created_by_admin_chat_id, message_snapshot (type, content, buttons, image file id), target_summary (all_count OR custom_count), counts_sent, counts_failed, counts_unsubscribed_during_send, failed_examples (sample of error reasons/ids, optional), status (completed|partial|aborted)

## Integrations

- **Telegram** (required) — Bot API messaging, file uploads (images), inline keyboards and callback queries
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Create, preview, edit, cancel, and send broadcasts
- Choose target: All subscribers or paste a custom list of user IDs
- Receive admin notifications for new opt-ins and failed delivery summaries
- View send history and per-broadcast summary records
- Set/change the ADMIN_CHAT_ID in platform settings (not in-chat)

## Notifications

- Admin: immediate notification of new subscriber opt-ins (simple message with chat id and timestamp)
- Admin: streaming progress updates during sends (periodic counts)
- Admin: final delivery summary after send (sent, failed, unsubscribes during send, sample errors)
- Subscriber: confirmation on subscribe/unsubscribe
- Admin: alert if a send encounters a high failure rate (> configurable threshold — default not configured)

## Permissions & privacy

- Bot stores subscriber chat IDs and timestamps to honor opt-in consent; opt-out is immediate and permanent until re-subscribe
- No subscriber data is shared externally; only aggregated send summaries and sample failure reasons are sent to ADMIN_CHAT_ID
- Admin must be a trusted owner; single ADMIN_CHAT_ID controls broadcasts
- No message content is forwarded outside Telegram or external services by default

## Edge cases

- User blocks bot during an ongoing send — count as failure and increment failed count
- Subscriber unsubscribes while a send is in progress — count as unsubscribed_during_send and exclude further sends
- Admin pastes invalid or non-numeric IDs — parser reports invalid lines and requires confirmation
- Duplicate IDs in custom list — dedupe before sending
- Large subscriber lists and Telegram rate limits — system sends in background batches; exact rate may throttle and prolong send
- Image sends fail for oversized files — Telegram will return an error and message is counted as failed for that recipient
- Admin aborts a send mid-way — bot marks broadcast as aborted and persists partial counts
- Bot restarts mid-send — system must resume or clearly mark the send as partial (implementation must persist send queue state)

## Required tests

- dialog-level acceptance test: subscriber /start → Subscribe → verify persistent subscriber record and admin notification
- dialog-level acceptance test: admin /create flow for text message → preview → edit → send to All → validate streaming progress and final SentBroadcast with correct counts
- dialog-level acceptance test: admin /create flow for image+caption → send to pasted custom list (with invalid IDs present) → validate parsing, confirmation, and per-id failure handling
- persistence test: create draft, restart service, resume editing and send
- edge-case test: unsubscribe during send — verify unsubscribed_during_send counted and further messages skipped

## Assumptions

- Single admin model (ADMIN_CHAT_ID) is sufficient for owner control
- Admin supplies custom target lists by pasting newline-separated Telegram chat IDs (no file upload required)
- Support only text and single-image-with-caption messages plus up to 3 quick inline buttons
- System-chosen batch size and pacing will be used to avoid Telegram API rate limits; exact numbers are not provided in brief
- No scheduling or recurring broadcasts required
