# Phone planned events (hackathon demo)

The phone assistant creates a **proposal** from saved kitchen recipes. It never places an order. The buyer approves the plan from an email link; that approval enables the existing event scheduler, which checks current prices and availability when ordering is due. The normal mandate still applies and order exceptions still need buyer approval.

## Local mock setup

1. Copy `.env.example` to `.env` and set:

   ```dotenv
   VOICE_MOCK_MODE=true
   VOICE_CALLER_MAP_JSON={"+358401234567":{"customerId":"HOTEL-001","buyerEmail":"buyer@example.test"}}
   ```

2. Start the gateway: `npm run dev:gateway`.
3. List saved recipes:

   ```sh
   curl -s http://localhost:8787/vapi/mock/tools \
     -H 'content-type: application/json' -d '{"message":{"call":{"id":"demo-call-1","customer":{"number":"+358401234567"}},"toolCallList":[{"id":"recipes-1","name":"list_saved_recipes","parameters":{}}]}}'
   ```

4. Create a confirmed proposal (replace the recipe id with one returned above):

   ```sh
   curl -s http://localhost:8787/vapi/mock/tools \
     -H 'content-type: application/json' -d '{"message":{"call":{"id":"demo-call-2","customer":{"number":"+358401234567"}},"toolCallList":[{"id":"proposal-1","name":"create_event_proposal","parameters":{"confirmed":true,"name":"Saturday lunch","date":"2026-12-12","guests":80,"recipeIds":["rcp-pancake"]}}]}}'
   ```

   Mock mode records delivery as `mocked` and does not contact Resend. The tool response says no email was sent and includes `mockApprovalUrl`; open it locally to preview, then click the POST approval button. Read the event list using a buyer key (`GET /v1/events` with `x-api-key: hotel_buyer_key_001`) to see the current delivery and approval state. Mock mode and its approval link only work through localhost and must never be enabled on a public deployment.

5. Run checks with `npm test` and `npm run build`.

Mock routes are accepted only when `VOICE_MOCK_MODE=true` and the request Host is localhost/127.0.0.1. Do not enable mock mode on a public deployment.

## Live provider setup

1. The gateway only needs to be reachable at a public HTTPS URL. `GATEWAY_PUBLIC_URL` is currently local in this workspace, so a phone call cannot reach it yet. Use your deployed gateway or a temporary HTTPS tunnel for a live demo. Set `VOICE_APPROVAL_BASE_URL` to that same public origin.
2. In Vapi, create an assistant, then create two **Function tools** under **Tools**. Set both tool server URLs to `https://<public-host>/vapi/tools`. Configure the function names and JSON schemas from [`vapi-tools.json`](./vapi-tools.json). Add both tools to the assistant.
3. Generate `VAPI_WEBHOOK_SECRET` (for example `openssl rand -hex 32`), set it in the gateway `.env`, and configure the Vapi tool's `Authorization: Bearer <same-secret>` header. The app does not need the Vapi account API key at runtime; keep that key in Vapi or a local secret store if you use it for Vapi account administration.
4. Configure `VOICE_CALLER_MAP_JSON` as caller E.164 number to customer and buyer email, for example `{"+358401234567":{"customerId":"HOTEL-001","buyerEmail":"buyer@example.fi"}}`. Only mapped callers can create proposals. Caller ID is an allowlist, not approval authority.
5. Set `RESEND_API_KEY` and `EMAIL_FROM` to a verified Resend sender if the call should email an approval link.
6. Assign the assistant to an inbound phone number in Vapi. Call that number from the exact mapped caller phone. The Vapi dashboard's single-tool test panel is not an end-to-end test because it does not send the call ID and caller number expected by this gateway.

   Paste this into the assistant's system prompt:

   ```text
   You help a kitchen plan food for a named event. First call list_saved_recipes and only use recipes returned for this account. Ask for the event name, event date, guest count, and dishes if any are missing. If a requested dish is not in the saved recipes, explain that and ask the caller to choose a saved dish; never invent a recipe or recipe ID.

   Before creating anything, read back the event name, full date, guest count, dish names, and portions. Ask the caller to confirm. Call create_event_proposal with confirmed=true only after an explicit yes. If they correct anything, read back the corrected details and confirm again.

   A successful call creates a proposal only. Say that the buyer must review the plan by email and that no order has been placed. If the tool returns mock_preview, say this is a local demo and no email was sent. If it reports any email failure or unknown status, say the plan was saved but the email is not confirmed; do not claim the buyer has been notified. If any tool fails, say no purchase was made and suggest contacting the account buyer. Never approve a plan or place an order yourself.
   ```

   After live tool success say that a proposal was saved and the buyer must approve by email; explicitly say no order was placed. Never claim email sent if the tool result reports `email_failed`, `email_unknown` or another failure.

## Delivery and recovery

- `GET /v1/voice/readiness` reports live/mock mode and missing setting **names only**.
- `GET /v1/events` includes phone email delivery and plan approval status.
- A known Resend failure can be retried from the event card (`POST /v1/events/:id/voice-email/retry`), at most three times. Provider timeout is `unknown` and is not retried automatically; check provider logs first to avoid duplicates.
- Approval email `GET /approval/voice/:token` only renders a preview. The visible form sends `POST` to approve. Tokens are hashed in SQLite, expire after seven days, and are single-use. Any event mutation changes its version and makes the old approval link stale.
- The `approved` state means the event is scheduled for a future ordering attempt. It does not guarantee stock, price, or an order outside the mandate.
- `429` tool requests include `Retry-After`; caller attempts are limited to 12 per five-minute window.

Vapi currently advertises $5 in starter credit and one included number; its hosting fee is $0.05/minute, with model and telephony costs in addition. Resend's free tier lists 3,000 emails/month and 100/day. Check the live [Vapi pricing](https://vapi.ai/pricing) and [Resend pricing](https://resend.com/pricing) before the demo. Free tiers do not mean unlimited use. This integration does not send orders to Valio; the challenge has no order API.
