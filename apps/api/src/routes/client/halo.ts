import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { dataSchema, errorSchema } from '@halo/contracts';
import { and, blacklistedAddresses, eq, gt, haloEmailVerifications, users } from '@halo/database';
import KSUID from 'ksuid';
import { userAuth } from '../../middleware/auth';
import type { AppEnv } from '../../types';

/** At most this many codes may be requested inside `RATE_LIMIT_WINDOW_MS`. */
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_OTPS = 3;

/** Minimum gap between two code requests from the same wallet. */
const COOLDOWN_MS = 60 * 1000;

const OTP_EXPIRY_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

const app = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: {
            code: 'BAD_REQUEST' as const,
            message: result.error.issues[0]?.message ?? 'Invalid request',
          },
        },
        400,
      );
    }
  },
});

const chainSchema = z.enum(['celo', 'kaia', 'world']);

/**
 * Collapse provider-side aliases so one mailbox cannot claim the reward twice.
 *
 * Everything after a `+` is dropped for every provider, and Gmail additionally ignores dots
 * in the local part — `f.o.o+bonus@gmail.com` and `foo@gmail.com` are the same inbox.
 */
function normalizeEmail(email: string): string {
  const [localPart, domain] = email.toLowerCase().split('@');

  if (!localPart || !domain) return email;

  let normalized = localPart.split('+')[0] ?? '';

  const gmailDomains = ['gmail.com', 'googlemail.com'];
  if (gmailDomains.includes(domain)) {
    normalized = normalized.replace(/\./g, '');
  }

  return `${normalized}@${domain}`;
}

/**
 * Allow-list rather than a block-list: throwaway-mail domains appear faster than anyone can
 * maintain a deny list, and the reward here is real money.
 */
const WHITELISTED_DOMAINS = new Set([
  // Google
  'gmail.com',
  'googlemail.com',
  // Microsoft
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'hotmail.co.uk',
  'hotmail.fr',
  'hotmail.de',
  'hotmail.es',
  'hotmail.it',
  'outlook.co.uk',
  'outlook.fr',
  'outlook.de',
  'outlook.es',
  'outlook.it',
  // Yahoo
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.co.id',
  'yahoo.com.br',
  'yahoo.fr',
  'yahoo.de',
  'yahoo.es',
  'yahoo.it',
  'yahoo.com.mx',
  'yahoo.com.ar',
  'yahoo.com.vn',
  'yahoo.co.in',
  'ymail.com',
  'rocketmail.com',
  // Apple
  'icloud.com',
  'me.com',
  'mac.com',
  // Proton
  'proton.me',
  'protonmail.com',
  'pm.me',
  // Other major providers
  'zoho.com',
  'zohomail.in',
  'aol.com',
  'mail.com',
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'web.de',
  'yandex.com',
  'yandex.ru',
  'naver.com',
  'daum.net',
  'hanmail.net',
  'nate.com',
  'qq.com',
  '163.com',
  '126.com',
  'sina.com',
  // Privacy-focused
  'tutanota.com',
  'tutamail.com',
  'tuta.io',
  'fastmail.com',
  'fastmail.fm',
  'posteo.de',
  'mailbox.org',
  'duck.com',
  // Regional providers
  'mail.ru',
  'rambler.ru',
  'ukr.net',
  'wp.pl',
  'o2.pl',
  'interia.pl',
  'seznam.cz',
  'email.cz',
  'libero.it',
  'virgilio.it',
  'laposte.net',
  'orange.fr',
  'sfr.fr',
  'free.fr',
  'uol.com.br',
  'bol.com.br',
  'terra.com.br',
  'ig.com.br',
  'rediffmail.com',
  'telkom.net',
]);

/** Institutional domains are too numerous to enumerate, so they are matched by shape. */
const EDUCATIONAL_PATTERNS = [
  /\.edu$/,
  /\.edu\.[a-z]{2}$/,
  /\.ac\.[a-z]{2}$/,
  /\.gov\.[a-z]{2}$/,
  /\.gov$/,
];

function isDomainAllowed(domain: string): boolean {
  if (WHITELISTED_DOMAINS.has(domain)) return true;

  return EDUCATIONAL_PATTERNS.some((pattern) => pattern.test(domain));
}

/**
 * Send the OTP through Maileroo's transactional API.
 *
 * Called over plain HTTP rather than through `maileroo-sdk`: the SDK is not a dependency of
 * this baseline and wraps a single POST. Throws on a non-2xx so the caller can report a
 * send failure instead of silently leaving the user waiting for a mail that never arrives.
 */
async function sendOtpEmail(
  apiKey: string,
  fromAddress: string,
  recipient: string,
  otp: string,
): Promise<void> {
  const response = await fetch('https://smtp.maileroo.com/api/v2/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({
      from: { address: fromAddress, display_name: 'Halo' },
      to: [{ address: recipient }],
      subject: 'Your Halo Verification Code',
      html: `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto;">
  <h2 style="color: #1a1a1a; margin-bottom: 24px;">Verify your email</h2>
  <p style="color: #333; font-size: 16px;">Your verification code is:</p>
  <p style="font-size: 36px; font-weight: bold; letter-spacing: 6px; color: #000; margin: 24px 0; font-family: monospace;">${otp}</p>
  <p style="color: #666; font-size: 14px;">This code expires in 10 minutes.</p>
  <p style="color: #999; font-size: 12px; margin-top: 32px;">
    If you didn't request this code, you can safely ignore this email.
  </p>
</body>
</html>`,
      plain: `Your Halo verification code is: ${otp}\n\nThis code expires in 10 minutes.\n\nIf you didn't request this code, you can safely ignore this email.`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Maileroo responded ${response.status}: ${await response.text()}`);
  }
}

// ── GET /halo/email/status ──────────────────────────────────────────────────

const emailStatusRoute = createRoute({
  method: 'get',
  path: '/halo/email/status',
  tags: ['Halo'],
  summary: 'Get email verification status',
  middleware: [userAuth] as const,
  request: {
    query: z.object({ chain: chainSchema.describe('Chain to check email verification for') }),
  },
  responses: {
    200: {
      description: 'Email verification status',
      content: {
        'application/json': {
          schema: dataSchema(
            z.object({ verified: z.boolean(), email: z.string().nullable() }),
          ),
        },
      },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
});

app.openapi(emailStatusRoute, async (c) => {
  const { chain } = c.req.valid('query');
  const userAddress = c.get('address')!;

  const verification = await c.get('db').query.haloEmailVerifications.findFirst({
    where: and(
      eq(haloEmailVerifications.userAddress, userAddress),
      eq(haloEmailVerifications.chain, chain),
      eq(haloEmailVerifications.isVerified, true),
    ),
  });

  return c.json(
    { data: { verified: !!verification, email: verification?.email ?? null } },
    200,
  );
});

// ── POST /halo/email/send-code ──────────────────────────────────────────────

const sendCodeRoute = createRoute({
  method: 'post',
  path: '/halo/email/send-code',
  tags: ['Halo'],
  summary: 'Send email verification OTP code',
  middleware: [userAuth] as const,
  request: {
    query: z.object({ chain: chainSchema.describe('Chain to verify email for') }),
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            email: z
              .string()
              .email()
              .transform((val) => val.toLowerCase()),
            turnstileToken: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'OTP sent',
      content: {
        'application/json': {
          schema: dataSchema(
            z.object({
              success: z.literal(true),
              expiresAt: z.string(),
              cooldownUntil: z.string(),
            }),
          ),
        },
      },
    },
    400: {
      description:
        'TURNSTILE_FAILED / DOMAIN_NOT_ALLOWED / ALREADY_VERIFIED / EMAIL_ALREADY_USED / EMAIL_SEND_FAILED',
      content: { 'application/json': { schema: errorSchema } },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
    403: {
      description: 'ADDRESS_BLACKLISTED / CHAIN_MISMATCH',
      content: { 'application/json': { schema: errorSchema } },
    },
    429: {
      description: 'RATE_LIMITED / COOLDOWN_ACTIVE — see the Retry-After header',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

app.openapi(sendCodeRoute, async (c) => {
  const { chain } = c.req.valid('query');
  const { email: originalEmail, turnstileToken } = c.req.valid('json');
  const userAddress = c.get('address')!;
  const db = c.get('db');

  const email = normalizeEmail(originalEmail);

  const blacklisted = await db.query.blacklistedAddresses.findFirst({
    where: eq(blacklistedAddresses.address, userAddress),
  });

  if (blacklisted) {
    return c.json(
      {
        error: {
          code: 'ADDRESS_BLACKLISTED' as const,
          message: 'This address has been restricted.',
        },
      },
      403,
    );
  }

  const user = await db.query.users.findFirst({ where: eq(users.address, userAddress) });

  if (!user || user.platform !== chain) {
    return c.json({ error: { code: 'CHAIN_MISMATCH' as const, message: 'Chain mismatch' } }, 403);
  }

  const turnstileRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: c.env.TURNSTILE_SECRET_KEY, response: turnstileToken }),
  });
  const turnstileData = (await turnstileRes.json()) as { success: boolean };

  if (!turnstileData.success) {
    return c.json(
      {
        error: {
          code: 'TURNSTILE_FAILED' as const,
          message: 'CAPTCHA verification failed. Please try again.',
        },
      },
      400,
    );
  }

  const domain = email.split('@')[1];

  if (domain && !isDomainAllowed(domain)) {
    return c.json(
      {
        error: {
          code: 'DOMAIN_NOT_ALLOWED' as const,
          message:
            'Please use an email from a major provider (Gmail, Outlook, Yahoo, iCloud, etc.) or your educational institution.',
        },
      },
      400,
    );
  }

  const existingVerified = await db.query.haloEmailVerifications.findFirst({
    where: and(
      eq(haloEmailVerifications.userAddress, userAddress),
      eq(haloEmailVerifications.chain, chain),
      eq(haloEmailVerifications.isVerified, true),
    ),
  });

  if (existingVerified) {
    return c.json(
      {
        error: {
          code: 'ALREADY_VERIFIED' as const,
          message: 'Email already verified for this wallet',
        },
      },
      400,
    );
  }

  const emailUsed = await db.query.haloEmailVerifications.findFirst({
    where: and(
      eq(haloEmailVerifications.email, email),
      eq(haloEmailVerifications.chain, chain),
      eq(haloEmailVerifications.isVerified, true),
    ),
  });

  if (emailUsed) {
    return c.json(
      {
        error: {
          code: 'EMAIL_ALREADY_USED' as const,
          message: 'Email already used by another wallet',
        },
      },
      400,
    );
  }

  const tenMinutesAgo = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const recentOtps = await db.query.haloEmailVerifications.findMany({
    where: and(
      eq(haloEmailVerifications.userAddress, userAddress),
      eq(haloEmailVerifications.chain, chain),
      gt(haloEmailVerifications.otpSentAt, tenMinutesAgo),
    ),
  });

  if (recentOtps.length >= RATE_LIMIT_MAX_OTPS) {
    c.header('Retry-After', String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
    return c.json(
      {
        error: {
          code: 'RATE_LIMITED' as const,
          message: 'Too many OTP requests. Please try again later.',
        },
      },
      429,
    );
  }

  const lastOtp = recentOtps.sort(
    (a, b) => (b.otpSentAt?.getTime() ?? 0) - (a.otpSentAt?.getTime() ?? 0),
  )[0];

  if (lastOtp?.otpSentAt) {
    const timeSinceLastOtp = Date.now() - lastOtp.otpSentAt.getTime();

    if (timeSinceLastOtp < COOLDOWN_MS) {
      const waitSeconds = Math.ceil((COOLDOWN_MS - timeSinceLastOtp) / 1000);
      c.header('Retry-After', String(waitSeconds));
      return c.json(
        {
          error: {
            code: 'COOLDOWN_ACTIVE' as const,
            message: `Please wait ${waitSeconds} seconds before requesting a new code`,
          },
        },
        429,
      );
    }
  }

  const otp = Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join('');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MS);
  const cooldownUntil = new Date(now.getTime() + COOLDOWN_MS);

  await db.insert(haloEmailVerifications).values({
    id: KSUID.randomSync().string,
    chain,
    userAddress,
    email,
    otpCode: otp,
    otpExpiresAt: expiresAt,
    otpSentAt: now,
    otpAttempts: 0,
    isVerified: false,
  });

  try {
    // Delivered to the address the user actually typed — the normalized form is only the
    // uniqueness key and may not be a deliverable mailbox at some providers.
    await sendOtpEmail(c.env.MAILEROO_API_KEY, c.env.EMAIL_FROM_ADDRESS, originalEmail, otp);
  } catch (emailError) {
    console.error('[halo/email/send-code] failed to send email:', emailError);
    return c.json(
      {
        error: {
          code: 'EMAIL_SEND_FAILED' as const,
          message: 'Failed to send verification email. Please try again.',
        },
      },
      400,
    );
  }

  return c.json(
    {
      data: {
        success: true as const,
        expiresAt: expiresAt.toISOString(),
        cooldownUntil: cooldownUntil.toISOString(),
      },
    },
    200,
  );
});

// ── POST /halo/email/verify-code ────────────────────────────────────────────

const verifyCodeRoute = createRoute({
  method: 'post',
  path: '/halo/email/verify-code',
  tags: ['Halo'],
  summary: 'Verify email OTP code',
  middleware: [userAuth] as const,
  request: {
    query: z.object({ chain: chainSchema.describe('Chain to verify email for') }),
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({ code: z.string().length(6).describe('6-digit OTP code') }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Email verified',
      content: {
        'application/json': {
          schema: dataSchema(z.object({ verified: z.literal(true), email: z.string() })),
        },
      },
    },
    400: {
      description:
        'NO_PENDING_VERIFICATION / OTP_EXPIRED / MAX_ATTEMPTS_EXCEEDED / INVALID_CODE / EMAIL_ALREADY_USED',
      content: { 'application/json': { schema: errorSchema } },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
});

app.openapi(verifyCodeRoute, async (c) => {
  const { chain } = c.req.valid('query');
  const { code } = c.req.valid('json');
  const userAddress = c.get('address')!;
  const db = c.get('db');

  const now = new Date();

  const pendingVerifications = await db.query.haloEmailVerifications.findMany({
    where: and(
      eq(haloEmailVerifications.userAddress, userAddress),
      eq(haloEmailVerifications.chain, chain),
      eq(haloEmailVerifications.isVerified, false),
    ),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
    limit: 1,
  });

  const pending = pendingVerifications[0];

  if (!pending) {
    return c.json(
      {
        error: {
          code: 'NO_PENDING_VERIFICATION' as const,
          message: 'No pending email verification found. Please request a new code.',
        },
      },
      400,
    );
  }

  if (!pending.otpExpiresAt || pending.otpExpiresAt < now) {
    return c.json(
      {
        error: {
          code: 'OTP_EXPIRED' as const,
          message: 'Verification code has expired. Please request a new code.',
        },
      },
      400,
    );
  }

  if (pending.otpAttempts >= MAX_OTP_ATTEMPTS) {
    return c.json(
      {
        error: {
          code: 'MAX_ATTEMPTS_EXCEEDED' as const,
          message: 'Too many failed attempts. Please request a new code.',
        },
      },
      400,
    );
  }

  if (code !== pending.otpCode) {
    await db
      .update(haloEmailVerifications)
      .set({ otpAttempts: pending.otpAttempts + 1 })
      .where(eq(haloEmailVerifications.id, pending.id));

    const attemptsRemaining = MAX_OTP_ATTEMPTS - pending.otpAttempts - 1;

    return c.json(
      {
        error: {
          code: 'INVALID_CODE' as const,
          message: `Invalid verification code. ${attemptsRemaining} attempts remaining.`,
        },
      },
      400,
    );
  }

  // Re-checked after the code matched: two wallets can race on the same address between the
  // send-code check and here, and only the first one may keep it.
  const emailNowUsed = await db.query.haloEmailVerifications.findFirst({
    where: and(
      eq(haloEmailVerifications.email, pending.email),
      eq(haloEmailVerifications.chain, chain),
      eq(haloEmailVerifications.isVerified, true),
    ),
  });

  if (emailNowUsed) {
    return c.json(
      {
        error: {
          code: 'EMAIL_ALREADY_USED' as const,
          message: 'Email was just verified by another wallet',
        },
      },
      400,
    );
  }

  await db
    .update(haloEmailVerifications)
    .set({ isVerified: true, verifiedAt: now, otpCode: null })
    .where(eq(haloEmailVerifications.id, pending.id));

  return c.json({ data: { verified: true as const, email: pending.email } }, 200);
});

export const clientHaloRoutes = app;
