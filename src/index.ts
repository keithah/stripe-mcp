import Stripe from 'stripe';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Logger } from './logger.js';

export const configSchema = z.object({
  stripe_api_key: z.string().min(1).describe('Stripe secret API key (sk_live_... or sk_test_...).'),
  stripe_api_version: z
    .string()
    .optional()
    .describe(
      'Optional Stripe API version override (e.g., 2024-06-20). Leave undefined to use your account default.'
    ),
  default_stripe_account: z
    .string()
    .optional()
    .describe(
      'Optional default connected account ID. Used when stripe_raw_request omits stripe_account.'
    ),
  log_level: z
    .enum(['debug', 'info', 'warn', 'error'])
    .default('info')
    .describe('Minimum log level emitted by the server (default: info).'),
});

type ServerConfig = z.infer<typeof configSchema>;

export default function createServer({
  config,
}: {
  config: ServerConfig;
}) {
  const stripeApiVersion = config.stripe_api_version as
    | Stripe.LatestApiVersion
    | undefined;

  const stripeConfig: Stripe.StripeConfig = {
    appInfo: {
      name: 'Stripe MCP Server',
      version: '0.1.0',
      url: 'https://smithery.ai/',
    },
  };

  if (stripeApiVersion) {
    stripeConfig.apiVersion = stripeApiVersion;
  }

  const stripe = new Stripe(config.stripe_api_key, stripeConfig);
  const logger = new Logger(config.log_level, 'stripe-mcp');
  logger.info('Initializing Stripe MCP server', {
    api_version: stripeApiVersion ?? 'account_default',
    default_stripe_account: config.default_stripe_account ?? null,
    log_level: config.log_level,
  });

  const server = new McpServer({
    name: 'stripe-fraud-mcp',
    version: '0.1.0',
  });

  registerStripeTools({
    server,
    stripe,
    logger,
    ...(config.default_stripe_account
      ? { defaultStripeAccount: config.default_stripe_account }
      : {}),
  });

  return server.server;
}

const fraudInsightShape = {
  payment_intent_id: z
    .string()
    .trim()
    .optional()
    .describe('Stripe PaymentIntent ID (pi_...) to analyse.'),
  charge_id: z
    .string()
    .trim()
    .optional()
    .describe('Stripe Charge ID (ch_...) to analyse.'),
  include_events: z
    .boolean()
    .default(true)
    .describe(
      'When true, include disputes, refunds, and related events for additional context.'
    ),
};
const fraudInsightSchema = z.object(fraudInsightShape);
type FraudInsightInput = z.infer<typeof fraudInsightSchema>;

const refundShape = {
  payment_intent_id: z
    .string()
    .trim()
    .optional()
    .describe('Stripe PaymentIntent ID to refund.'),
  charge_id: z
    .string()
    .trim()
    .optional()
    .describe('Stripe Charge ID to refund.'),
  amount: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Optional amount in the smallest currency unit for partial refunds.'
    ),
  reason: z
    .enum(['duplicate', 'fraudulent', 'requested_by_customer'])
    .optional()
    .describe('Optional refund reason.'),
  metadata: z
    .record(z.string())
    .optional()
    .describe('Optional metadata to attach to the refund.'),
};
const refundSchema = z.object(refundShape);
type RefundInput = z.infer<typeof refundSchema>;

const rawRequestShape = {
  method: z
    .enum(['GET', 'POST', 'DELETE'])
    .describe('HTTP method to use for the Stripe API request.'),
  path: z
    .string()
    .trim()
    .describe(
      'Stripe API path (e.g. /v1/customers or /v1/payment_intents/pi_xxx). Include query params directly in the path for non-POST requests.'
    ),
  query: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      'Optional query parameters. Applied only when method is GET or DELETE.'
    ),
  payload: z
    .record(z.any())
    .optional()
    .describe('Optional payload for POST requests.'),
  idempotency_key: z
    .string()
    .optional()
    .describe('Optional Idempotency-Key header to apply.'),
  stripe_account: z
    .string()
    .optional()
    .describe('Optional connected account ID for the request.'),
  api_version: z
    .string()
    .optional()
    .describe('Optional Stripe API version override.'),
};
const rawRequestSchema = z.object(rawRequestShape);
type RawRequestInput = z.infer<typeof rawRequestSchema>;

function registerStripeTools({
  server,
  stripe,
  defaultStripeAccount,
  logger,
}: {
  server: McpServer;
  stripe: Stripe;
  defaultStripeAccount?: string;
  logger: Logger;
}) {
  const toolsLogger = logger.child('tools');
  toolsLogger.info('Registering Stripe tools');
  const fraudLogger = toolsLogger.child('stripe_fraud_insight');
  const refundLogger = toolsLogger.child('stripe_create_refund');
  const rawRequestLogger = toolsLogger.child('stripe_raw_request');
  server.registerTool(
    'stripe_fraud_insight',
    {
      title: 'Stripe Radar Fraud Insight',
      description:
        'Fetches Radar risk data, early fraud warnings, disputes, and refunds for a payment.',
      inputSchema: fraudInsightShape,
    },
    async (input: FraudInsightInput) => {
      fraudLogger.info('Invocation received', {
        has_payment_intent: Boolean(input.payment_intent_id),
        has_charge: Boolean(input.charge_id),
        include_events: input.include_events,
      });
      try {
        if (!input.payment_intent_id && !input.charge_id) {
          fraudLogger.warn('Missing identifiers for fraud insight request');
          throw new Error(
            'You must provide either payment_intent_id or charge_id to retrieve fraud insights.'
          );
        }

        const insight = await buildFraudInsight(stripe, input, fraudLogger);

        const summaryLines: string[] = [
          `Payment Intent: ${insight.paymentIntent?.id ?? 'n/a'} | status: ${
            insight.paymentIntent?.status ?? 'unknown'
          }`,
          `Charge: ${insight.charge?.id ?? 'n/a'} | risk level: ${
            insight.charge?.outcome?.risk_level ?? 'unknown'
          } | risk score: ${insight.charge?.outcome?.risk_score ?? 'unknown'}`,
          `Recommendation: ${insight.recommendation.action.toUpperCase()} - ${
            insight.recommendation.reason
          }`,
        ];

        fraudLogger.info('Fraud insight generated', {
          payment_intent: insight.paymentIntent?.id ?? null,
          charge: insight.charge?.id ?? null,
          recommendation: insight.recommendation.action,
          risk_level: insight.charge?.outcome?.risk_level ?? null,
          risk_score: insight.charge?.outcome?.risk_score ?? null,
        });

        return {
          content: [
            {
              type: 'text',
              text: `${summaryLines.join(
                '\n'
              )}\n\nFull details:\n${JSON.stringify(insight, null, 2)}`,
            },
          ],
          structuredContent: insight as Record<string, unknown>,
        };
      } catch (error) {
        fraudLogger.error('Fraud insight tool failed', {
          error_message: error instanceof Error ? error.message : String(error),
          error_stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }
    }
  );

  server.registerTool(
    'stripe_create_refund',
    {
      title: 'Stripe Refund Creator',
      description:
        'Creates a refund for a charge or payment intent, supporting partial refunds and metadata.',
      inputSchema: refundShape,
    },
    async (input: RefundInput) => {
      refundLogger.info('Invocation received', {
        has_payment_intent: Boolean(input.payment_intent_id),
        has_charge: Boolean(input.charge_id),
        amount: input.amount ?? null,
        reason: input.reason ?? null,
      });
      try {
        if (!input.payment_intent_id && !input.charge_id) {
          refundLogger.warn('Missing identifiers for refund request');
          throw new Error(
            'You must provide either payment_intent_id or charge_id to create a refund.'
          );
        }

        const params: Stripe.RefundCreateParams = {};
        if (input.payment_intent_id) {
          params.payment_intent = input.payment_intent_id;
        }
        if (input.charge_id) {
          params.charge = input.charge_id;
        }
        if (typeof input.amount === 'number') {
          params.amount = input.amount;
        }
        if (input.reason) {
          params.reason = input.reason;
        }
        if (input.metadata) {
          params.metadata = input.metadata;
        }

        refundLogger.debug('Creating refund with parameters', {
          payment_intent: params.payment_intent ?? null,
          charge: params.charge ?? null,
          amount: params.amount ?? null,
          reason: params.reason ?? null,
          metadata_keys: params.metadata ? Object.keys(params.metadata) : [],
        });
        const refundResponse = await stripe.refunds.create(params);
        const refund = refundResponse as Stripe.Refund;
        refundLogger.info('Refund created', {
          refund_id: refund.id,
          target_charge: typeof refund.charge === 'string' ? refund.charge : refund.charge?.id ?? null,
          target_payment_intent:
            typeof refund.payment_intent === 'string'
              ? refund.payment_intent
              : refund.payment_intent?.id ?? null,
          status: refund.status ?? null,
          amount: refund.amount,
        });

        return {
          content: [
            {
              type: 'text',
              text: `Refund ${refund.id} created for ${refund.amount} ${
                refund.currency
              } on ${
                refund.charge ?? refund.payment_intent ?? 'unknown target'
              }. Status: ${refund.status ?? 'unknown'}`,
            },
          ],
          structuredContent: {
            refund,
            last_response: refundResponse.lastResponse,
          },
        };
      } catch (error) {
        refundLogger.error('Refund tool failed', {
          error_message: error instanceof Error ? error.message : String(error),
          error_stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }
    }
  );

  server.registerTool(
    'stripe_raw_request',
    {
      title: 'Stripe Raw API Request',
      description:
        'Direct access to any Stripe REST endpoint using the authenticated SDK client.',
      inputSchema: rawRequestShape,
    },
    async (input: RawRequestInput) => {
      const method = input.method.toUpperCase() as RawRequestInput['method'];
      rawRequestLogger.info('Invocation received', {
        method,
        path: input.path,
        has_query: Boolean(input.query),
        has_payload: Boolean(input.payload),
        idempotency_key: input.idempotency_key ?? null,
        explicit_stripe_account: input.stripe_account ?? null,
        api_version: input.api_version ?? null,
      });

      let path = input.path;
      if (input.query && method !== 'POST') {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(input.query)) {
          search.append(key, String(value));
        }
        const separator = path.includes('?') ? '&' : '?';
        path = `${path}${separator}${search.toString()}`;
      }

      const params =
        method === 'POST' ? (input.payload ?? {}) : (undefined as undefined);

      const stripeAccount =
        input.stripe_account ?? defaultStripeAccount ?? undefined;

      try {
        rawRequestLogger.debug('Dispatching raw request', {
          method,
          path,
          stripe_account: stripeAccount ?? null,
        });
        const response = await stripe.rawRequest(method, path, params, {
          ...(input.idempotency_key
            ? { idempotencyKey: input.idempotency_key }
            : {}),
          ...(stripeAccount ? { stripeAccount } : {}),
          ...(input.api_version ? { apiVersion: input.api_version } : {}),
        });

        const { lastResponse, ...responseData } =
          response as Stripe.Response<Record<string, unknown>>;

        rawRequestLogger.info('Raw request completed', {
          method,
          path,
          status: lastResponse.statusCode,
          request_id: lastResponse.requestId,
          stripe_account: lastResponse.stripeAccount ?? null,
        });

        return {
          content: [
            {
              type: 'text',
              text: `Stripe ${method} ${path}\nStatus: ${
                lastResponse.statusCode
              }\n\n${JSON.stringify(responseData, null, 2)}`,
            },
          ],
          structuredContent: {
            status: lastResponse.statusCode,
            headers: lastResponse.headers,
            request_id: lastResponse.requestId,
            api_version: lastResponse.apiVersion ?? null,
            idempotency_key: lastResponse.idempotencyKey ?? null,
            stripe_account: lastResponse.stripeAccount ?? null,
            data: responseData,
          },
        };
      } catch (error) {
        if (error instanceof Stripe.errors.StripeError) {
          rawRequestLogger.warn('Stripe raw error captured', {
            method,
            path,
            status: error.statusCode ?? null,
            type: error.type,
            code: error.code ?? null,
            request_id: error.requestId ?? null,
            message: error.message,
          });
          return {
            content: [
              {
                type: 'text',
                text: `Stripe ${method} ${path} failed with status ${
                  error.statusCode ?? 'unknown'
                }\n${error.message}`,
              },
            ],
            structuredContent: {
              status: error.statusCode ?? null,
              type: error.type,
              code: error.code ?? null,
              headers: error.headers ?? null,
              message: error.message,
              request_id: error.requestId ?? null,
            },
            isError: true,
          };
        }

        rawRequestLogger.error('Unexpected raw request failure', {
          method,
          path,
          error_message: error instanceof Error ? error.message : String(error),
          error_stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }
    }
  );
}

async function buildFraudInsight(
  stripe: Stripe,
  input: FraudInsightInput,
  logger: Logger
): Promise<FraudInsightResult> {
  logger.debug('Building fraud insight', {
    payment_intent_id: input.payment_intent_id ?? null,
    charge_id: input.charge_id ?? null,
    include_events: input.include_events,
  });
  const result: FraudInsightResult = {
    recommendation: {
      action: 'monitor',
      reason: 'Baseline recommendation before risk analysis.',
    },
  };

  let paymentIntent: Stripe.PaymentIntent | null = null;
  let charge: Stripe.Charge | null = null;

  if (input.payment_intent_id) {
    logger.debug('Retrieving PaymentIntent', {
      payment_intent_id: input.payment_intent_id,
    });
    paymentIntent = await stripe.paymentIntents.retrieve(
      input.payment_intent_id,
      {
        expand: [
          'latest_charge',
          'latest_charge.outcome',
          'latest_charge.review',
          'latest_charge.payment_method_details',
          'latest_charge.refunds',
        ],
      }
    );
    result.paymentIntent = summarizePaymentIntent(paymentIntent);
    logger.debug('PaymentIntent retrieved', {
      payment_intent_id: paymentIntent.id,
      latest_charge_type: typeof paymentIntent.latest_charge,
      status: paymentIntent.status,
    });

    if (
      paymentIntent.latest_charge &&
      typeof paymentIntent.latest_charge === 'object'
    ) {
      charge = paymentIntent.latest_charge as Stripe.Charge;
    } else if (typeof paymentIntent.latest_charge === 'string') {
      logger.debug('Fetching latest charge by ID', {
        charge_id: paymentIntent.latest_charge,
      });
      charge = await stripe.charges.retrieve(paymentIntent.latest_charge, {
        expand: [
          'outcome',
          'review',
          'payment_intent',
          'payment_method_details',
          'refunds',
        ],
      });
    }
  }

  if (input.charge_id) {
    logger.debug('Retrieving Charge', { charge_id: input.charge_id });
    charge = await stripe.charges.retrieve(input.charge_id, {
      expand: [
        'outcome',
        'review',
        'payment_intent',
        'payment_method_details',
        'refunds',
      ],
    });
    result.charge = summarizeCharge(charge);
    logger.debug('Charge retrieved', {
      charge_id: charge.id,
      outcome_present: Boolean(charge.outcome),
    });

    if (
      charge.payment_intent &&
      typeof charge.payment_intent === 'string' &&
      !paymentIntent
    ) {
      logger.debug('Fetching PaymentIntent referenced by charge', {
        payment_intent_id: charge.payment_intent,
      });
      paymentIntent = await stripe.paymentIntents.retrieve(
        charge.payment_intent,
        {
          expand: ['latest_charge'],
        }
      );
      result.paymentIntent = summarizePaymentIntent(paymentIntent);
    } else if (
      charge.payment_intent &&
      typeof charge.payment_intent === 'object'
    ) {
      paymentIntent = charge.payment_intent as Stripe.PaymentIntent;
      result.paymentIntent = summarizePaymentIntent(paymentIntent);
    }
  }

  if (!charge && paymentIntent?.id) {
    const chargeList = await stripe.charges.list({
      payment_intent: paymentIntent.id,
      limit: 1,
      expand: ['data.outcome', 'data.review', 'data.payment_method_details'],
    });
    charge = chargeList.data[0] ?? null;
    if (charge) {
      result.charge = summarizeCharge(charge);
      logger.debug('Charge inferred from PaymentIntent charges list', {
        charge_id: charge.id,
      });
    } else {
      logger.warn('No charge found for payment intent', {
        payment_intent_id: paymentIntent.id,
      });
    }
  }

  if (charge) {
    result.charge ??= summarizeCharge(charge);
    const earlyFraudWarnings =
      await stripe.radar.earlyFraudWarnings.list({ charge: charge.id });

    const reviews: ReviewSummary[] = [];
    if (charge.review) {
      if (typeof charge.review === 'string') {
        logger.debug('Retrieving associated review', {
          review_id: charge.review,
        });
        const reviewResponse = await stripe.reviews.retrieve(charge.review);
        reviews.push(summarizeReview(reviewResponse));
      } else {
        reviews.push(summarizeReview(charge.review));
      }
    }

    const disputeData = input.include_events
      ? (
          await stripe.disputes.list({
            charge: charge.id,
            limit: 100,
          })
        ).data
      : [];

    const refundData =
      typeof charge.refunds === 'object' && charge.refunds?.data
        ? charge.refunds.data
        : input.include_events
        ? (
            await stripe.refunds.list({
              charge: charge.id,
              limit: 100,
            })
          ).data
        : [];

    logger.debug('Radar context collected', {
      charge_id: charge.id,
      early_fraud_warning_count: earlyFraudWarnings.data.length,
      review_count: reviews.length,
      dispute_count: disputeData.length,
      refund_count: refundData.length,
    });

    result.radar = {
      early_fraud_warnings: earlyFraudWarnings.data.map(
        summarizeEarlyFraudWarning
      ),
      reviews,
      disputes: disputeData.map(summarizeDispute),
      refunds: refundData.map(summarizeRefund),
      risk_level: charge.outcome?.risk_level ?? null,
      risk_score: charge.outcome?.risk_score ?? null,
      outcome_type: charge.outcome?.type ?? null,
      seller_message: charge.outcome?.seller_message ?? null,
    };

    result.recommendation = deriveRecommendation({
      charge,
      earlyFraudWarnings: earlyFraudWarnings.data,
      disputes: disputeData,
    });
  } else {
    result.recommendation = {
      action: 'manual_review',
      reason:
        'No charge details available. Review manually before taking action.',
    };
    logger.warn('No charge details available for fraud insight', {
      payment_intent_id: paymentIntent?.id ?? null,
      charge_id: input.charge_id ?? null,
    });
  }

  return result;
}

function summarizeReview(
  review: Stripe.Review | Stripe.Response<Stripe.Review>
): ReviewSummary {
  const data = review as Stripe.Review;
  return {
    id: data.id,
    open: data.open,
    reason: data.reason ?? null,
    created: data.created,
    closed_reason: data.closed_reason ?? null,
  };
}

function summarizeEarlyFraudWarning(
  warning: Stripe.Radar.EarlyFraudWarning
): EarlyFraudWarningSummary {
  return {
    id: warning.id,
    actionable: warning.actionable,
    fraud_type: warning.fraud_type,
    created: warning.created,
    charge:
      typeof warning.charge === 'string'
        ? warning.charge
        : warning.charge.id,
    payment_intent: warning.payment_intent
      ? typeof warning.payment_intent === 'string'
        ? warning.payment_intent
        : warning.payment_intent.id
      : null,
  };
}

function summarizeDispute(dispute: Stripe.Dispute): DisputeSummary {
  return {
    id: dispute.id,
    amount: dispute.amount,
    currency: dispute.currency,
    status: dispute.status,
    reason: dispute.reason ?? null,
    created: dispute.created,
    charge:
      typeof dispute.charge === 'string'
        ? dispute.charge
        : dispute.charge?.id ?? null,
    payment_intent:
      dispute.payment_intent && typeof dispute.payment_intent === 'object'
        ? dispute.payment_intent.id
        : (dispute.payment_intent as string | null) ?? null,
  };
}

function summarizeRefund(refund: Stripe.Refund): RefundSummary {
  return {
    id: refund.id,
    amount: refund.amount,
    currency: refund.currency,
    status: refund.status ?? null,
    reason: refund.reason ?? null,
    created: refund.created,
    charge:
      refund.charge && typeof refund.charge === 'object'
        ? refund.charge.id
        : (refund.charge as string | null) ?? null,
    payment_intent:
      refund.payment_intent && typeof refund.payment_intent === 'object'
        ? refund.payment_intent.id
        : (refund.payment_intent as string | null) ?? null,
  };
}

function summarizePaymentIntent(
  paymentIntent: Stripe.PaymentIntent
): PaymentIntentSummary {
  return {
    id: paymentIntent.id,
    amount: paymentIntent.amount,
    amount_capturable: paymentIntent.amount_capturable,
    amount_received: paymentIntent.amount_received,
    currency: paymentIntent.currency,
    status: paymentIntent.status,
    customer: paymentIntent.customer,
    created: paymentIntent.created,
    confirmation_method: paymentIntent.confirmation_method,
    payment_method_types: paymentIntent.payment_method_types,
  };
}

function summarizeCharge(charge: Stripe.Charge): ChargeSummary {
  return {
    id: charge.id,
    amount: charge.amount,
    captured: charge.captured,
    paid: charge.paid,
    currency: charge.currency,
    refunded: charge.refunded,
    disputed: charge.disputed,
    status: charge.status ?? null,
    outcome: charge.outcome
      ? {
          network_status: charge.outcome.network_status ?? null,
          reason: charge.outcome.reason ?? null,
          risk_level: charge.outcome.risk_level ?? null,
          risk_score: charge.outcome.risk_score ?? null,
          seller_message: charge.outcome.seller_message ?? null,
          type: charge.outcome.type ?? null,
        }
      : null,
    metadata: charge.metadata,
    payment_method_details: charge.payment_method_details ?? null,
    review_id:
      charge.review && typeof charge.review === 'object'
        ? charge.review.id
        : (charge.review as string | null) ?? null,
    receipt_url: charge.receipt_url ?? null,
  };
}

function deriveRecommendation({
  charge,
  earlyFraudWarnings,
  disputes,
}: {
  charge: Stripe.Charge;
  earlyFraudWarnings: Stripe.Radar.EarlyFraudWarning[];
  disputes: Stripe.Dispute[];
}): FraudRecommendation {
  if (disputes.length > 0) {
    return {
      action: 'refund',
      reason: 'Existing dispute detected. Prefer immediate refund to reduce losses.',
    };
  }

  if (earlyFraudWarnings.some((warning) => warning.actionable)) {
    return {
      action: 'refund',
      reason:
        'Actionable Radar early fraud warning present. Stripe recommends refunding.',
    };
  }

  const riskLevel = charge.outcome?.risk_level ?? null;
  const riskScore = charge.outcome?.risk_score ?? 0;

  if (riskLevel === 'highest' || riskScore >= 75) {
    return {
      action: 'refund',
      reason: `High risk detected (level: ${riskLevel ?? 'n/a'}, score: ${riskScore}).`,
    };
  }

  if (riskLevel === 'elevated' || riskScore >= 50) {
    return {
      action: 'manual_review',
      reason:
        'Elevated risk level. Review supporting evidence before issuing refund.',
    };
  }

  return {
    action: 'monitor',
    reason:
      'No disputes or actionable warnings. Monitor the transaction for future signals.',
  };
}

type FraudAction = 'refund' | 'manual_review' | 'monitor';

interface FraudRecommendation {
  action: FraudAction;
  reason: string;
  [key: string]: unknown;
}

interface PaymentIntentSummary {
  id: string;
  amount: number;
  amount_capturable: number;
  amount_received: number;
  currency: string;
  status: string;
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null;
  created: number;
  confirmation_method: Stripe.PaymentIntent.ConfirmationMethod;
  payment_method_types: string[];
}

interface ChargeSummary {
  id: string;
  amount: number;
  captured: boolean;
  paid: boolean;
  currency: string;
  refunded: boolean;
  disputed: boolean;
  status: string | null;
  outcome: {
    network_status: string | null;
    reason: string | null;
    risk_level: string | null;
    risk_score: number | null;
    seller_message: string | null;
    type: string | null;
  } | null;
  metadata: Stripe.Metadata;
  payment_method_details: Stripe.Charge.PaymentMethodDetails | null;
  review_id: string | null;
  receipt_url: string | null;
}

interface RadarInsight {
  early_fraud_warnings: EarlyFraudWarningSummary[];
  reviews: ReviewSummary[];
  disputes: DisputeSummary[];
  refunds: RefundSummary[];
  risk_level: string | null;
  risk_score: number | null;
  outcome_type: string | null;
  seller_message: string | null;
}

interface EarlyFraudWarningSummary {
  id: string;
  actionable: boolean;
  fraud_type: string;
  created: number;
  charge: string;
  payment_intent: string | null;
}

interface ReviewSummary {
  id: string;
  open: boolean;
  reason: string | null;
  created: number;
  closed_reason: string | null;
}

interface DisputeSummary {
  id: string;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  created: number;
  charge: string | null;
  payment_intent: string | null;
}

interface RefundSummary {
  id: string;
  amount: number;
  currency: string;
  status: string | null;
  reason: string | null;
  created: number;
  charge: string | null;
  payment_intent: string | null;
}

interface FraudInsightResult {
  paymentIntent?: PaymentIntentSummary;
  charge?: ChargeSummary;
  radar?: RadarInsight;
  recommendation: FraudRecommendation;
  [key: string]: unknown;
}
