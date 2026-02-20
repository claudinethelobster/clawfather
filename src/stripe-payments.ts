import Stripe from 'stripe';
import { AccountStore } from './account-store';
import { ClawdfatherConfig } from './types';

const PRICE_PER_HOUR_CENTS = 100;
const SECONDS_PER_HOUR = 3600;

export class StripePayments {
  private stripe: Stripe;

  constructor(
    private store: AccountStore,
    private config: ClawdfatherConfig,
  ) {
    const secretKey = config.stripeSecretKey ?? process.env.STRIPE_SECRET_KEY ?? '';
    if (!secretKey) {
      throw new Error(
        'Stripe secret key not configured (set stripeSecretKey in config or STRIPE_SECRET_KEY env var)',
      );
    }
    this.stripe = new Stripe(secretKey, { apiVersion: '2025-01-27.acacia' as any });
  }

  async createCheckoutSession(params: {
    accountId: string;
    hours?: number;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string; sessionId: string }> {
    const hours = params.hours ?? 1;
    const creditSeconds = hours * SECONDS_PER_HOUR;

    const stripePriceId = this.config.stripePriceId ?? process.env.STRIPE_PRICE_ID;

    let lineItems: Stripe.Checkout.SessionCreateParams.LineItem[];
    if (stripePriceId) {
      lineItems = [{ price: stripePriceId, quantity: hours }];
    } else {
      lineItems = [
        {
          price_data: {
            currency: 'usd',
            unit_amount: PRICE_PER_HOUR_CENTS,
            product_data: {
              name: 'Clawdfather Session Time',
              description: `${hours} hour${hours !== 1 ? 's' : ''} of server admin session time`,
            },
          },
          quantity: hours,
        },
      ];
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata: {
        accountId: params.accountId,
        creditSeconds: String(creditSeconds),
        hours: String(hours),
      },
    });

    if (!session.url) throw new Error('Stripe checkout session URL not returned');
    return { url: session.url, sessionId: session.id };
  }

  async handleWebhook(
    rawBody: Buffer,
    signature: string,
  ): Promise<{ processed: boolean; eventType: string }> {
    const webhookSecret =
      this.config.stripeWebhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) throw new Error('Stripe webhook secret not configured');

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err: any) {
      throw new Error(`Webhook signature verification failed: ${err.message}`);
    }

    if (this.store.hasProcessedStripeEvent(event.id)) {
      return { processed: false, eventType: event.type };
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const accountId = session.metadata?.accountId;
      const creditSeconds = parseInt(session.metadata?.creditSeconds ?? '0', 10);

      if (accountId && creditSeconds > 0) {
        this.store.addCredits(accountId, creditSeconds, 'stripe_payment', event.id);
        console.log(
          `[clawdfather] Added ${creditSeconds}s credits to account ${accountId} via Stripe event ${event.id}`,
        );
      }
    }

    this.store.recordStripeEvent(event.id, event.type);
    return { processed: true, eventType: event.type };
  }
}
