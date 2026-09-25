/**
 * Client for a Drop Protocol style payout service: it mints a one-time claim
 * link for a single recipient and calls our webhook once the link is redeemed.
 *
 * Everything about the provider is configuration. The endpoint we run against
 * is not public, so a fork points `DROP_API_URL` / `DROP_ID` at its own service
 * — or leaves them empty, in which case `dropConfigFromEnv` returns null and
 * the raffle records a winner for manual payout instead.
 */
export type ValidationItem =
  | { type: 'min-orb' }
  | { type: 'min-device' }
  | { type: 'exclude-address'; addresses: string[] }
  | { type: 'include-address'; addresses: string[] }
  | { type: 'start-at'; timestamp: number }
  | { $and: ValidationItem[] }
  | { $or: ValidationItem[] };

export interface DropConfig {
  /** Base URL of the payout service. */
  apiUrl: string;
  /** Identifies the funded drop the links are minted against. */
  dropId: string;
  /** Absolute URL of our `/v1/webhook/raffle-received` endpoint. */
  webhookUrl: string;
  /** Shared secret the service signs its webhook payload with. */
  webhookSecret: string;
  /** Used to build the deep link back into the World mini app. Optional. */
  worldAppId: string;
}

export interface CreateLinkParams {
  title: string;
  /** Wallet allowed to redeem the link. */
  receiver: string;
  /** Smallest unit of the payout token, as a decimal string. */
  amount: string;
}

export interface CreateLinkResult {
  base58Id: string;
  webLink: string;
  worldAppDeepLink: string;
}

/**
 * Reads the payout provider out of the environment, or returns null when it is
 * not configured. Null is a supported state, not a failure: the raffle still
 * runs and still records winners.
 */
export function dropConfigFromEnv(env: Env): DropConfig | null {
  if (!env.DROP_API_URL || !env.DROP_ID || !env.API_URL) {
    return null;
  }

  return {
    apiUrl: env.DROP_API_URL,
    dropId: env.DROP_ID,
    webhookUrl: `${env.API_URL}/v1/webhook/raffle-received`,
    webhookSecret: env.JWT_SECRET,
    worldAppId: env.WORLD_APP_ID,
  };
}

export class DropService {
  constructor(private readonly config: DropConfig) {}

  async createLink(params: CreateLinkParams): Promise<CreateLinkResult> {
    const response = await fetch(`${this.config.apiUrl}/v1/links`, {
      method: 'POST',
      headers: {
        'x-drop-id': this.config.dropId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: params.title,
        amountPerReceiver: params.amount,
        numOfReceivers: 1,
        webhookUrl: this.config.webhookUrl,
        webhookSecret: this.config.webhookSecret,
        redirectUrl: this.config.worldAppId
          ? `worldapp://mini-app?app_id=${this.config.worldAppId}&path=${encodeURIComponent('/?oc_ref=drop-received')}`
          : undefined,
        // The link is bound to the winner, so a leaked URL is not a payout.
        validation: {
          $and: [{ type: 'include-address', addresses: [params.receiver] }, { type: 'min-device' }],
        } satisfies ValidationItem,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create payout link: ${response.status} ${await response.text()}`);
    }

    return (await response.json()) as CreateLinkResult;
  }
}
