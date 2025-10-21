# Stripe Fraud MCP

TypeScript Model Context Protocol (MCP) server that wraps the official [`stripe`](https://github.com/stripe/stripe-node) SDK. The server focuses on fraud and Radar operations while still exposing a raw request tool that lets an LLM call any Stripe REST endpoint. It is designed to run locally or inside [Smithery](https://smithery.ai/) for hosting.

## Features
- **`stripe_fraud_insight`** – Given a `payment_intent_id` or `charge_id`, pulls Radar early fraud warnings, risk scores, disputes, refunds, and reviews, then returns a recommendation (`refund`, `manual_review`, or `monitor`).
- **`stripe_create_refund`** – Creates refunds against a charge or payment intent, supporting partial amounts, reasons, and metadata.
- **`stripe_raw_request`** – Full access to the Stripe API via `stripe.rawRequest`, so you can reach any endpoint that is not yet wrapped in a specialized tool.
- Built for Smithery (stdio + Streamable HTTP builds) so you can host it as a managed MCP service without writing glue code.

## Prerequisites
- Node.js 20+
- Stripe secret key with the necessary permissions.
- [Smithery CLI](https://smithery.ai/docs) (`npx @smithery/cli`) for local builds and development.

## Smithery Configuration

The Smithery runtime picks up the configuration schema that lives in `src/index.ts`. When you install or run the server you will be prompted for:

| Config key | Required | Description |
|------------|----------|-------------|
| `stripe_api_key` | ✅ | Secret key used to authenticate Stripe requests. |
| `stripe_api_version` | ❌ | Optional API version override (defaults to your account version). |
| `default_stripe_account` | ❌ | Optional connected account ID used when a request does not specify one. |
| `log_level` | ❌ | Minimum log level to emit (`debug`, `info`, `warn`, `error`). Defaults to `info`. |

The repository includes `smithery.yaml`, so Smithery knows to treat it as a TypeScript project and to compile from `src/index.ts`.

## Local Development
```bash
npm install
npm run dev  # wraps `smithery dev`
```

`smithery dev` will prompt for your configuration values (or you can provide a `--config` file). It spins up both stdio and SHTTP transports so you can test with `smithery proxy`, Claude Desktop, or any MCP client.

## Building for Deployment
- `npm run build:stdio` – Produces `.smithery/stdio/index.cjs` for stdio transport.
- `npm run build:shttp` – Produces `.smithery/shttp/index.cjs` for Streamable HTTP transport.
- `npm run build` – Builds both artefacts.

When you push to Smithery, it runs the same build pipeline and hosts the generated artefact automatically.

## Tool Reference

### `stripe_status`
- **Input**: Optional `stripe_account` override.
- **Output**: Current server time, effective configuration (API version, log level, default account), and key flags from the Stripe account (charges/payouts enabled). Useful for quick health checks in Smithery.

### `stripe_fraud_insight`
- **Input**: `payment_intent_id` or `charge_id` (one required), `include_events` (boolean, default `true`).
- **Output**: Structured fraud/risk summary with Stripe Radar data and an automated recommendation.

### `stripe_create_refund`
- **Input**: `payment_intent_id` or `charge_id`, optional `amount`, `reason`, `metadata`.
- **Output**: Created refund plus Stripe response metadata.

### `stripe_raw_request`
- **Input**: HTTP method (`GET`, `POST`, `DELETE`), `path`, optional `query`, `payload`, `idempotency_key`, `stripe_account`, `api_version`.
- **Output**: Raw response body and headers so you can reach any Stripe endpoint from the LLM.

## Project Scripts
- `npm run dev` – Runs `smithery dev` for interactive local development.
- `npm run build` – Builds stdio and SHTTP bundles under `.smithery/`.
- `npm run build:stdio` / `npm run build:shttp` – Build individual transports.
- `npm run typecheck` – TypeScript diagnostics without emitting files.

## Logging
- The server emits structured JSON logs with timestamps, logger names, and context to make triage in Smithery or other observability tooling straightforward.
- Set `log_level` in the Smithery configuration to control verbosity; `debug` includes every Stripe call and fraud-analysis step, while `info` surfaces tool invocations and outcomes.
- Sensitive values (Stripe API keys, tokens, etc.) are automatically redacted from logged context.

## Next Steps
- Add additional purpose-built tools for dispute responses, Radar rule management, value list operations, etc., by wrapping the official SDK in new MCP handlers.
- Implement optional caching or memoization if you anticipate repeated lookups.
- Instrument with logging/observability before production use.
