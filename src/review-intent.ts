import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON, ROOT } from './io.ts';
import { smellBrain } from './review-brain.ts';
import type { Descriptors } from './review-brain.ts';
import { changedText } from './review-cases.ts';
import type { Parameter, ReviewCase, Scalar } from './review-cases.ts';
import { validateGrownCase } from './review-grown.ts';
import { encodeWithJev } from './review-jev.ts';
import { fitLogistic, predictLogistic } from './review-logistic.ts';
import { hear, odorize } from './review-odor.ts';
import { reviewVerdict, VERDICT_RULE } from './review-verdict.ts';
import { executeRuns, THROWS } from './review-verify.ts';

/**
 * Intended behavior changes: can the fly tell a right change from a wrong one when both change behavior?
 *
 * Every harmless lesson the fly was taught is a refactor, so "harmless" and "behavior unchanged" were the same thing in its
 * corpus. Here each scenario is a ticket that changes what a function should do, with a new written contract and an
 * independent reference implementation of it. Each gets two changes of the same kind and size: one that does what the
 * ticket asks (sugar, if it were a lesson) and one plausible mistake implementing it (bitter). Labels are proven by
 * executing both against the reference; the run refuses to score if any label does not hold. Nothing here is ever taught.
 * The fly's live memory is scored once, beside a logistic regression fit on the fly's own training split.
 *
 *   npm run intent                  writes data/intent.json
 *   CHECK=refactor npm run intent   the fairness check: a behavior-preserving tidy-up of each right change, the kind of
 *                                   harmless change the fly was taught on, so a fly that rejects these too finds the set
 *                                   itself strange. Writes data/intent-refactor.json.
 */
type Scenario = {
  name: string;
  ticket: string;
  group: string;
  filename: string;
  context: string;
  functionName: string;
  signature: string;
  contract: string;
  parameters: Parameter[];
  /** One column of values per parameter; the sweep is every combination. */
  grid: Scalar[][];
  smell: string;
  before: string;
  right: string;
  wrong: string;
  reference: string;
};
const int = (name: string, min: number, max: number): Parameter => ({ name, type: 'integer', min, max });
const bool = (name: string): Parameter => ({ name, type: 'boolean' });
const oneOf = (name: string, values: string[]): Parameter => ({ name, type: 'enum', values });
const TF = [true, false];

const SCENARIOS: Scenario[] = [
  {
    name: 'free-shipping',
    ticket: 'Free shipping from $50 (was over $100)',
    group: 'Checkout',
    filename: 'shipping.ts',
    context: 'The checkout page calls this to decide whether to waive the shipping charge.',
    functionName: 'freeShipping',
    signature: 'totalCents: number): boolean',
    contract:
      'Orders of $50.00 or more ship free. totalCents is the order total in cents (integer 0-20000). Return true if and only if totalCents is at least 5000.',
    parameters: [int('totalCents', 0, 20000)],
    grid: [[0, 4999, 5000, 5001, 9999, 10000, 10001, 20000]],
    smell: 'boundary',
    before: 'return totalCents > 10000;',
    right: 'return totalCents >= 5000;',
    wrong: 'return totalCents > 5000;',
    reference: 'return !(totalCents < 5000);',
  },
  {
    name: 'trial-length',
    ticket: 'Trials last 14 days (was 7)',
    group: 'Billing',
    filename: 'trial.ts',
    context: 'The billing service calls this nightly to decide which accounts are still in their free trial.',
    functionName: 'trialActive',
    signature: 'daysSinceSignup: number): boolean',
    contract:
      'A free trial lasts 14 days: it is active on days 0 through 13 after signup and over from day 14. Return true while the trial is active.',
    parameters: [int('daysSinceSignup', 0, 60)],
    grid: [[0, 1, 6, 7, 8, 13, 14, 15, 30]],
    smell: 'off-by-one',
    before: 'return daysSinceSignup < 7;',
    right: 'return daysSinceSignup < 14;',
    wrong: 'return daysSinceSignup <= 14;',
    reference: 'return daysSinceSignup >= 0 && daysSinceSignup <= 13;',
  },
  {
    name: 'session-timeout',
    ticket: 'Default sessions last 30 minutes (was 15)',
    group: 'Auth',
    filename: 'session.ts',
    context: 'The login handler calls this to set the session cookie lifetime.',
    functionName: 'sessionTimeoutSeconds',
    signature: 'rememberMe: boolean): number',
    contract:
      "Sessions last 30 minutes, or 24 hours when the user chose 'remember me'. Return the session length in seconds.",
    parameters: [bool('rememberMe')],
    grid: [TF],
    smell: 'changed-default',
    before: 'const minutes = rememberMe ? 60 * 24 : 15;\n  return minutes * 60;',
    right: 'const minutes = rememberMe ? 60 * 24 : 30;\n  return minutes * 60;',
    wrong: 'const minutes = rememberMe ? 30 : 15;\n  return minutes * 60;',
    reference: 'if (rememberMe) return 86400;\n  return 1800;',
  },
  {
    name: 'retries',
    ticket: 'Retry idempotent requests up to 5 times (was 3)',
    group: 'HTTP client',
    filename: 'retry.ts',
    context: 'The HTTP client calls this before each request to decide how many times a failure may be retried.',
    functionName: 'maxRetries',
    signature: 'isIdempotent: boolean): number',
    contract:
      'Idempotent requests are retried up to 5 times; other requests are never retried. Return the maximum number of retries.',
    parameters: [bool('isIdempotent')],
    grid: [TF],
    smell: 'changed-default',
    before: 'return isIdempotent ? 3 : 0;',
    right: 'return isIdempotent ? 5 : 0;',
    wrong: 'return isIdempotent ? 3 : 5;',
    reference: 'if (!isIdempotent) return 0;\n  return 5;',
  },
  {
    name: 'public-pages',
    ticket: 'Guests can see public pages without signing in',
    group: 'Content',
    filename: 'visibility.ts',
    context: 'The page router calls this before rendering any page.',
    functionName: 'canView',
    signature: 'isPublic: boolean, signedIn: boolean, isMember: boolean): boolean',
    contract:
      'Public pages are visible to everyone, signed in or not. Private pages are visible only to signed-in members. Return whether the page is visible.',
    parameters: [bool('isPublic'), bool('signedIn'), bool('isMember')],
    grid: [TF, TF, TF],
    smell: 'removed-guard',
    before: 'if (isPublic && !signedIn) return false;\n  if (isPublic) return true;\n  return signedIn && isMember;',
    right: 'if (isPublic) return true;\n  return signedIn && isMember;',
    wrong: 'if (isPublic && !signedIn) return false;\n  if (isPublic) return true;\n  return isMember;',
    reference: 'return isPublic || (signedIn && isMember);',
  },
  {
    name: 'member-coupon',
    ticket: 'Members with a coupon get 15% (was 10%)',
    group: 'Checkout',
    filename: 'discount.ts',
    context: 'The cart calls this to compute the discount line.',
    functionName: 'discountPercent',
    signature: 'isMember: boolean, hasCoupon: boolean): number',
    contract:
      'Members get 10% off, coupon holders get 5% off, and members with a coupon get 15% off. Everyone else gets 0. Return the discount percent.',
    parameters: [bool('isMember'), bool('hasCoupon')],
    grid: [TF, TF],
    smell: 'changed-default',
    before:
      'if (isMember && hasCoupon) return 10;\n  if (isMember) return 10;\n  if (hasCoupon) return 5;\n  return 0;',
    right: 'if (isMember && hasCoupon) return 15;\n  if (isMember) return 10;\n  if (hasCoupon) return 5;\n  return 0;',
    wrong: 'if (isMember && hasCoupon) return 10;\n  if (isMember) return 15;\n  if (hasCoupon) return 5;\n  return 0;',
    reference: 'return (isMember ? 10 : 0) + (hasCoupon ? 5 : 0);',
  },
  {
    name: 'tax-rounding',
    ticket: 'Round tax to the nearest cent (was truncated)',
    group: 'Checkout',
    filename: 'tax.ts',
    context: 'The invoice generator calls this for every line item.',
    functionName: 'priceWithTaxCents',
    signature: 'cents: number): number',
    contract: 'Add 8% tax to a price in cents and round to the nearest cent, halves up. Return the total in cents.',
    parameters: [int('cents', 0, 100000)],
    grid: [[0, 1, 7, 13, 49, 99, 100, 1234, 9999, 54321]],
    smell: 'rounding',
    before: 'return Math.floor(cents * 1.08);',
    right: 'return Math.round(cents * 1.08);',
    wrong: 'return Math.ceil(cents * 1.08);',
    reference: 'return Math.floor((cents * 108 + 50) / 100);',
  },
  {
    name: 'backoff',
    ticket: 'Exponential backoff for retries (was linear)',
    group: 'HTTP client',
    filename: 'backoff.ts',
    context: 'The retry loop calls this to know how long to wait before the next attempt.',
    functionName: 'retryDelayMs',
    signature: 'attempt: number): number',
    contract:
      'Retry delays use exponential backoff starting at 200 ms: attempt 1 waits 200 ms, and each later attempt waits twice as long as the one before. Return the delay in milliseconds.',
    parameters: [int('attempt', 1, 10)],
    grid: [[1, 2, 3, 4, 5, 6, 7, 8]],
    smell: 'arithmetic',
    before: 'return 200 * attempt;',
    right: 'return 200 * 2 ** (attempt - 1);',
    wrong: 'return 200 * 2 ** attempt;',
    reference: 'let delay = 200;\n  for (let i = 1; i < attempt; i++) delay *= 2;\n  return delay;',
  },
  {
    name: 'invoice-id',
    ticket: 'Pad invoice numbers to 6 digits',
    group: 'Billing',
    filename: 'invoice.ts',
    context: 'The invoice PDF renderer calls this for the header.',
    functionName: 'invoiceId',
    signature: 'n: number): string',
    contract:
      "Invoice ids are 'INV-' followed by the invoice number padded with leading zeros to 6 digits, for example INV-000042.",
    parameters: [int('n', 0, 999999)],
    grid: [[0, 7, 42, 999, 123456]],
    smell: 'string-handling',
    before: "return 'INV-' + n;",
    right: "return 'INV-' + String(n).padStart(6, '0');",
    wrong: "return 'INV-' + String(n).padEnd(6, '0');",
    reference: "let digits = String(n);\n  while (digits.length < 6) digits = '0' + digits;\n  return 'INV-' + digits;",
  },
  {
    name: 'hotfix-deploy',
    ticket: 'Hotfixes can deploy without approval',
    group: 'CI',
    filename: 'deploy.ts',
    context: 'The deploy pipeline calls this before promoting a build to production.',
    functionName: 'canDeploy',
    signature: 'testsPass: boolean, approved: boolean, isHotfix: boolean): boolean',
    contract:
      'A change can deploy when its tests pass and it is approved. Hotfixes whose tests pass can deploy without approval. Nothing deploys with failing tests.',
    parameters: [bool('testsPass'), bool('approved'), bool('isHotfix')],
    grid: [TF, TF, TF],
    smell: 'boolean-logic',
    before: 'return testsPass && approved;',
    right: 'return testsPass && (approved || isHotfix);',
    wrong: 'return (testsPass && approved) || isHotfix;',
    reference: 'if (!testsPass) return false;\n  return isHotfix ? true : approved;',
  },
  {
    name: 'page-size',
    ticket: 'Allow page sizes from 1 to 100 (was up to 50)',
    group: 'API',
    filename: 'pagination.ts',
    context: 'Every list endpoint calls this with the ?limit= query parameter.',
    functionName: 'pageSize',
    signature: 'requested: number): number',
    contract:
      'The page size is the requested size limited to the range 1 to 100: anything below 1 becomes 1 and anything above 100 becomes 100.',
    parameters: [int('requested', -10, 1000)],
    grid: [[-5, 0, 1, 2, 50, 99, 100, 101, 500]],
    smell: 'clamping',
    before: 'return Math.min(requested, 50);',
    right: 'return Math.max(1, Math.min(requested, 100));',
    wrong: 'return Math.min(1, Math.max(requested, 100));',
    reference: 'if (requested < 1) return 1;\n  if (requested > 100) return 100;\n  return requested;',
  },
  {
    name: 'order-total',
    ticket: 'Charge 8% tax on the subtotal, not on shipping',
    group: 'Checkout',
    filename: 'total.ts',
    context: 'The checkout summary calls this to show the amount to be charged.',
    functionName: 'totalCents',
    signature: 'subtotal: number, shipping: number): number',
    contract:
      'The order total is the subtotal plus 8% tax on the subtotal only, rounded down to the cent, plus shipping. Shipping is not taxed. All amounts are in cents.',
    parameters: [int('subtotal', 0, 100000), int('shipping', 0, 2000)],
    grid: [
      [0, 99, 1000, 12345],
      [0, 499, 1500],
    ],
    smell: 'precedence',
    before: 'return subtotal + shipping;',
    right: 'return subtotal + Math.floor((subtotal * 8) / 100) + shipping;',
    wrong: 'return Math.floor(((subtotal + shipping) * 108) / 100);',
    reference: 'const tax = (subtotal * 8 - ((subtotal * 8) % 100)) / 100;\n  return subtotal + tax + shipping;',
  },
  {
    name: 'delete-account',
    ticket: 'Admins can no longer delete their own account',
    group: 'Auth',
    filename: 'accounts.ts',
    context: 'The account settings page calls this to show or hide the delete button.',
    functionName: 'canDeleteAccount',
    signature: 'isAdmin: boolean, isSelf: boolean): boolean',
    contract: 'Users may delete their own account. Admins may delete any other account, but not their own.',
    parameters: [bool('isAdmin'), bool('isSelf')],
    grid: [TF, TF],
    smell: 'permission',
    before: 'return isAdmin || isSelf;',
    right: 'return isAdmin ? !isSelf : isSelf;',
    wrong: 'return isAdmin && !isSelf;',
    reference: 'if (isAdmin && isSelf) return false;\n  return isAdmin || isSelf;',
  },
  {
    name: 'priority-label',
    ticket: "Urgent tickets get their own 'Urgent' label",
    group: 'Support',
    filename: 'priority.ts',
    context: 'The support inbox calls this to render the priority badge.',
    functionName: 'priorityLabel',
    signature: 'level: string): string',
    contract:
      "Show 'Low', 'Medium', 'High', or 'Urgent' for the matching level ('low', 'medium', 'high', 'urgent'). Urgent tickets get their own label instead of 'High'.",
    parameters: [oneOf('level', ['low', 'medium', 'high', 'urgent'])],
    grid: [['low', 'medium', 'high', 'urgent']],
    smell: 'enum-mapping',
    before: "return level === 'low' ? 'Low' : level === 'medium' ? 'Medium' : 'High';",
    right: "return level === 'low' ? 'Low' : level === 'medium' ? 'Medium' : level === 'high' ? 'High' : 'Urgent';",
    wrong: "return level === 'low' ? 'Low' : level === 'medium' ? 'Medium' : level === 'urgent' ? 'High' : 'Urgent';",
    reference:
      "const labels: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };\n  return labels[level];",
  },
  {
    name: 'late-fee',
    ticket: 'Three-day grace period before the late fee',
    group: 'Billing',
    filename: 'late-fee.ts',
    context: 'The billing job calls this for every overdue invoice.',
    functionName: 'lateFeeCents',
    signature: 'daysLate: number): number',
    contract:
      'Payments up to 3 days late have no fee. From the 4th day late the fee is $5.00. Return the fee in cents.',
    parameters: [int('daysLate', 0, 60)],
    grid: [[0, 1, 2, 3, 4, 5, 30]],
    smell: 'off-by-one',
    before: 'return daysLate > 0 ? 500 : 0;',
    right: 'return daysLate > 3 ? 500 : 0;',
    wrong: 'return daysLate >= 3 ? 500 : 0;',
    reference: 'if (daysLate <= 3) return 0;\n  return 500;',
  },
  {
    name: 'rate-limit',
    ticket: 'Premium users get 1000 requests per window',
    group: 'API',
    filename: 'rate-limit.ts',
    context: 'The API gateway calls this on every request.',
    functionName: 'allowRequest',
    signature: 'countInWindow: number, isPremium: boolean): boolean',
    contract:
      "Free users may make 100 requests per window; premium users may make 1000. Allow the request if the count so far in the window is below the user's limit.",
    parameters: [int('countInWindow', 0, 2000), bool('isPremium')],
    grid: [[0, 99, 100, 101, 999, 1000, 1001], TF],
    smell: 'changed-default',
    before: 'return countInWindow < 100;',
    right: 'return countInWindow < (isPremium ? 1000 : 100);',
    wrong: 'return countInWindow < (isPremium ? 100 : 1000);',
    reference: 'const limit = isPremium ? 1000 : 100;\n  return limit - countInWindow > 0;',
  },
  {
    name: 'price-format',
    ticket: 'Always show two decimals in prices',
    group: 'Storefront',
    filename: 'format.ts',
    context: 'Every product card calls this to render the price.',
    functionName: 'formatPrice',
    signature: 'cents: number): string',
    contract: "Format a price in cents as dollars with exactly two decimals, for example 550 becomes '$5.50'.",
    parameters: [int('cents', 0, 100000)],
    grid: [[0, 5, 50, 99, 100, 550, 1999, 12345]],
    smell: 'string-handling',
    before: "return '$' + cents / 100;",
    right: "return '$' + (cents / 100).toFixed(2);",
    wrong: "return '$' + Math.floor(cents / 100) + '.' + (cents % 100);",
    reference:
      "const dollars = Math.floor(cents / 100);\n  const rest = cents % 100;\n  return '$' + dollars + '.' + (rest < 10 ? '0' + rest : String(rest));",
  },
  {
    name: 'drinking-age',
    ticket: "Use each country's legal drinking age",
    group: 'Storefront',
    filename: 'age-check.ts',
    context: 'The checkout calls this before selling an age-restricted item.',
    functionName: 'canBuyAlcohol',
    signature: 'age: number, country: string): boolean',
    contract:
      "Use each country's legal age: 21 in the US ('us'), 18 in the UK ('uk'), 16 in Germany ('de'). Return true if the buyer is at least that age.",
    parameters: [int('age', 10, 30), oneOf('country', ['us', 'uk', 'de'])],
    grid: [
      [15, 16, 17, 18, 20, 21, 22],
      ['us', 'uk', 'de'],
    ],
    smell: 'changed-default',
    before: 'return age >= 21;',
    right: "return age >= (country === 'us' ? 21 : country === 'uk' ? 18 : 16);",
    wrong: "return age >= (country === 'us' ? 21 : country === 'uk' ? 16 : 18);",
    reference: 'const minimum: Record<string, number> = { us: 21, uk: 18, de: 16 };\n  return age >= minimum[country];',
  },
  {
    name: 'remove-flag',
    ticket: 'Roll the new checkout out to everyone',
    group: 'Checkout',
    filename: 'flags.ts',
    context: 'The storefront calls this to pick which checkout to show.',
    functionName: 'useNewCheckout',
    signature: 'userId: number, flagOn: boolean): boolean',
    contract: 'The new checkout is on for every user, whatever the old flag says. Return true for everyone.',
    parameters: [int('userId', 1, 1000), bool('flagOn')],
    grid: [[1, 2, 3, 10, 999], TF],
    smell: 'removed-guard',
    before: 'if (!flagOn) return false;\n  return userId % 2 === 0;',
    right: 'return true;',
    wrong: 'return userId % 2 === 0;',
    reference: 'return userId === userId;',
  },
  {
    name: 'double-points',
    ticket: 'Double points on orders of $100 or more',
    group: 'Loyalty',
    filename: 'points.ts',
    context: 'The order service calls this after payment to credit loyalty points.',
    functionName: 'pointsFor',
    signature: 'cents: number): number',
    contract:
      'Customers earn 1 point per whole dollar spent, doubled on orders of $100.00 or more. cents is the order total.',
    parameters: [int('cents', 0, 100000)],
    grid: [[0, 99, 100, 9999, 10000, 10001, 25000]],
    smell: 'boundary',
    before: 'return Math.floor(cents / 100);',
    right: 'const points = Math.floor(cents / 100);\n  return cents >= 10000 ? points * 2 : points;',
    wrong: 'const points = Math.floor(cents / 100);\n  return cents > 10000 ? points * 2 : points;',
    reference:
      'const dollars = (cents - (cents % 100)) / 100;\n  if (cents < 10000) return dollars;\n  return dollars + dollars;',
  },
  {
    name: 'vat-rates',
    ticket: 'EU tax rate goes to 21%; the UK stays at 20%',
    group: 'Checkout',
    filename: 'vat.ts',
    context: 'The checkout calls this to look up the tax rate for the shipping region.',
    functionName: 'taxRateBps',
    signature: 'region: string): number',
    contract: "Tax rates in basis points: US ('us') 800, UK ('uk') 2000, EU ('eu') 2100.",
    parameters: [oneOf('region', ['us', 'eu', 'uk'])],
    grid: [['us', 'eu', 'uk']],
    smell: 'changed-default',
    before: "return region === 'us' ? 800 : 2000;",
    right: "return region === 'us' ? 800 : region === 'uk' ? 2000 : 2100;",
    wrong: "return region === 'us' ? 800 : region === 'eu' ? 2000 : 2100;",
    reference:
      "switch (region) {\n    case 'us':\n      return 800;\n    case 'uk':\n      return 2000;\n    default:\n      return 2100;\n  }",
  },
  {
    name: 'low-stock',
    ticket: 'Warn about low stock at 10 or fewer (was under 5)',
    group: 'Inventory',
    filename: 'stock.ts',
    context: 'The product page calls this to show a "low stock" badge.',
    functionName: 'lowStock',
    signature: 'quantity: number): boolean',
    contract: 'Show a low-stock warning when 10 or fewer items are left.',
    parameters: [int('quantity', 0, 500)],
    grid: [[0, 4, 5, 9, 10, 11, 50]],
    smell: 'boundary',
    before: 'return quantity < 5;',
    right: 'return quantity <= 10;',
    wrong: 'return quantity < 10;',
    reference: 'return !(quantity > 10);',
  },
  {
    name: 'lockout',
    ticket: 'Lock accounts after 5 failed sign-ins (was 3)',
    group: 'Auth',
    filename: 'lockout.ts',
    context: 'The sign-in handler calls this after each failed attempt.',
    functionName: 'isLocked',
    signature: 'failedAttempts: number): boolean',
    contract: 'An account locks after 5 failed sign-in attempts: the 5th failure locks it.',
    parameters: [int('failedAttempts', 0, 20)],
    grid: [[0, 2, 3, 4, 5, 6, 10]],
    smell: 'off-by-one',
    before: 'return failedAttempts >= 3;',
    right: 'return failedAttempts >= 5;',
    wrong: 'return failedAttempts > 5;',
    reference: 'return failedAttempts > 4;',
  },
  {
    name: 'password-length',
    ticket: 'Passwords must be at least 12 characters (was 8)',
    group: 'Auth',
    filename: 'password.ts',
    context: 'The sign-up form calls this before accepting a new password.',
    functionName: 'passwordLongEnough',
    signature: 'length: number): boolean',
    contract: 'Passwords must be at least 12 characters long. length is the password length.',
    parameters: [int('length', 0, 64)],
    grid: [[0, 7, 8, 11, 12, 13, 64]],
    smell: 'boundary',
    before: 'return length >= 8;',
    right: 'return length >= 12;',
    wrong: 'return length > 12;',
    reference: 'return length > 11;',
  },
];

// The checked-in trained fly the talk quotes, not the live demo memory, which visitors may have taught since.
const memoryPath = join(ROOT, 'data/trained-memory.json');
const outPath = join(ROOT, process.env.CHECK === 'refactor' ? 'data/intent-refactor.json' : 'data/intent.json');
if (!process.env.FORCE && (await readFile(outPath).catch(() => null)))
  throw new Error(`${outPath} exists: this set is scored once. FORCE=1 re-scores, and the report should say so.`);

// The tidy-ups for CHECK=refactor, each applied to the right change: swap a comparison, invert a ternary, name a value.
const REFACTORS: Record<string, string> = {
  'free-shipping': 'return 5000 <= totalCents;',
  'trial-length': 'return 14 > daysSinceSignup;',
  'session-timeout': 'const lengthInMinutes = rememberMe ? 60 * 24 : 30;\n  return lengthInMinutes * 60;',
  retries: 'return !isIdempotent ? 0 : 5;',
  'public-pages': 'if (!isPublic) return signedIn && isMember;\n  return true;',
  'member-coupon':
    'if (hasCoupon && isMember) return 15;\n  if (isMember) return 10;\n  if (hasCoupon) return 5;\n  return 0;',
  'tax-rounding': 'const total = cents * 1.08;\n  return Math.round(total);',
  backoff: 'const exponent = attempt - 1;\n  return 200 * 2 ** exponent;',
  'invoice-id': "const digits = String(n).padStart(6, '0');\n  return 'INV-' + digits;",
  'hotfix-deploy': 'return (isHotfix || approved) && testsPass;',
  'page-size': 'const capped = Math.min(requested, 100);\n  return Math.max(1, capped);',
  'order-total': 'const tax = Math.floor((subtotal * 8) / 100);\n  return subtotal + tax + shipping;',
  'delete-account': 'return !isAdmin ? isSelf : !isSelf;',
  'priority-label':
    "if (level === 'low') return 'Low';\n  if (level === 'medium') return 'Medium';\n  if (level === 'high') return 'High';\n  return 'Urgent';",
  'late-fee': 'return 3 < daysLate ? 500 : 0;',
  'rate-limit': 'const limit = isPremium ? 1000 : 100;\n  return countInWindow < limit;',
  'price-format': "const dollars = (cents / 100).toFixed(2);\n  return '$' + dollars;",
  'drinking-age': "const minimumAge = country === 'us' ? 21 : country === 'uk' ? 18 : 16;\n  return age >= minimumAge;",
  'remove-flag': 'const enabled = true;\n  return enabled;',
  'double-points': 'const earned = Math.floor(cents / 100);\n  return cents >= 10000 ? earned * 2 : earned;',
  'vat-rates': "if (region === 'us') return 800;\n  if (region === 'uk') return 2000;\n  return 2100;",
  'low-stock': 'return 10 >= quantity;',
  lockout: 'return 5 <= failedAttempts;',
  'password-length': 'return 12 <= length;',
};
const refactorCheck = process.env.CHECK === 'refactor';

const fn = (s: Scenario, body: string) => `export function ${s.functionName}(${s.signature} {\n  ${body}\n}`;
const sweep = (grid: Scalar[][]) =>
  grid.reduce<Scalar[][]>((rows, column) => rows.flatMap(r => column.map(v => [...r, v])), [[]]);
const cases: ReviewCase[] = SCENARIOS.flatMap(s =>
  (refactorCheck ? (['refactor'] as const) : (['right', 'wrong'] as const)).map(kind =>
    validateGrownCase({
      id: `intent-${s.name}-${kind}`,
      title: s.ticket,
      group: s.group,
      filename: s.filename,
      context: s.context,
      before: fn(s, kind === 'refactor' ? s.right : s.before),
      after: fn(s, kind === 'refactor' ? REFACTORS[s.name] : s[kind]),
      functionName: s.functionName,
      contract: s.contract,
      parameters: s.parameters,
      oracle: 'reference',
      format: 'text',
      reference: fn(s, s.reference),
      sweep: sweep(s.grid),
      smell: s.smell,
      grown: { model: 'hand-written', at: '2026-10-14', scenario: s.name },
      ...(kind === 'wrong' ? {} : { control: true }),
    }),
  ),
);

// Prove every label before anything is scored: the ticket changes behavior (before disagrees with the new reference
// somewhere), the right change matches the reference on every input, the wrong one misses it on at least one.
const value = (r: { value?: Scalar; error?: string }) => (r.error ? THROWS : r.value);
const failures: string[] = [];
for (const c of cases) {
  const runs = await executeRuns(c, c.sweep!);
  const changes = runs.some(r => value(r.before) !== r.expected);
  const miss = runs.find(r => value(r.after) !== r.expected);
  if (refactorCheck) {
    if (changes || miss) failures.push(`${c.id}: the tidy-up is not behavior-preserving`);
    continue;
  }
  if (!changes) failures.push(`${c.id}: the ticket does not change behavior on any input`);
  if (c.control && miss) failures.push(`${c.id}: the right change misses the contract at ${JSON.stringify(miss.args)}`);
  if (!c.control && !miss) failures.push(`${c.id}: the wrong change never misses the contract`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`${cases.length} cases from ${SCENARIOS.length} tickets; every label proven by execution`);
if (refactorCheck && Object.keys(REFACTORS).length !== SCENARIOS.length) throw new Error('One tidy-up per ticket');

// Describe with Jev once, cached apart from the training cache.
const odorsPath = join(ROOT, '.runs/odors.intent.json');
type Cached = Record<string, { model: string; at: string; features: Descriptors }>;
const cached = JSON.parse(await readFile(odorsPath, 'utf8').catch(() => '{}')) as Cached;
for (const c of cases.filter(c => !cached[c.id])) {
  const encoded = await encodeWithJev(c);
  cached[c.id] = { model: encoded.model, at: new Date().toISOString(), features: encoded.features };
  await atomicJSON(odorsPath, cached);
}

// The spreadsheet: a logistic regression on the fly's own training split, as in npm run baseline.
const trainingOdors = JSON.parse(await readFile(join(ROOT, '.runs/odors.json'), 'utf8')) as Cached;
const training = JSON.parse(await readFile(join(ROOT, 'data/training.json'), 'utf8')) as {
  results: { caseId: string; set: string; control: boolean }[];
};
const model = fitLogistic(
  training.results
    .filter(r => r.set === 'training')
    .map(r => ({ features: hear(trainingOdors[r.caseId].features), regression: !r.control })),
);
const band = (p: number) =>
  p >= VERDICT_RULE.objection ? 'changes_requested' : p <= VERDICT_RULE.approval ? 'no_objection' : 'abstain';

// Score the live fly, a few runs at a time.
type Row = {
  id: string;
  ticket: string;
  smell: string;
  kind: 'right' | 'wrong' | 'refactor';
  expected: 'no_objection' | 'changes_requested';
  fly: { verdict: string; share: number; feedHz: number; behavior: string };
  spreadsheet: { p: number; verdict: string };
};
const rows: Row[] = new Array(cases.length);
let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < cases.length) {
      const i = next++;
      const c = cases[i];
      const brain = await smellBrain(odorize(cached[c.id].features, changedText(c)), { seed: 7, memoryPath });
      const v = reviewVerdict(brain);
      const p = predictLogistic(model, hear(cached[c.id].features));
      rows[i] = {
        id: c.id,
        ticket: c.title,
        smell: c.smell!,
        kind: refactorCheck ? 'refactor' : c.control ? 'right' : 'wrong',
        expected: c.control ? 'no_objection' : 'changes_requested',
        fly: {
          verdict: v.verdict,
          share: brain.avoidHz / Math.max(1e-9, brain.avoidHz + brain.approachHz),
          feedHz: brain.feedHz,
          behavior: v.behavior,
        },
        spreadsheet: { p, verdict: band(p) },
      };
    }
  }),
);

const tally = (pick: (r: Row) => string) => {
  if (refactorCheck)
    return {
      refactorsApproved: `${rows.filter(r => pick(r) === 'no_objection').length}/${rows.length}`,
      refactorsObjected: rows.filter(r => pick(r) === 'changes_requested').length,
      abstained: rows.filter(r => pick(r) === 'abstain').length,
    };
  const right = rows.filter(r => r.kind === 'right'),
    wrong = rows.filter(r => r.kind === 'wrong');
  const approved = right.filter(r => pick(r) === 'no_objection').length,
    caught = wrong.filter(r => pick(r) === 'changes_requested').length;
  return {
    rightApproved: `${approved}/${right.length}`,
    rightObjected: right.filter(r => pick(r) === 'changes_requested').length,
    wrongCaught: `${caught}/${wrong.length}`,
    wrongApproved: wrong.filter(r => pick(r) === 'no_objection').length,
    abstained: rows.filter(r => pick(r) === 'abstain').length,
    balanced: (approved / right.length + caught / wrong.length) / 2,
    /** Same verdict on both changes of a ticket: the vote did not depend on which one was right. */
    sameVerdictPairs: SCENARIOS.filter(s => {
      const [a, b] = rows.filter(r => r.id.startsWith(`intent-${s.name}-`));
      return Boolean(b) && pick(a) === pick(b);
    }).length,
  };
};
const summary = { fly: tally(r => r.fly.verdict), spreadsheet: tally(r => r.spreadsheet.verdict) };
for (const r of rows)
  console.log(
    `  ${r.id.padEnd(34)} ${r.kind.padEnd(5)} fly ${r.fly.verdict.padEnd(17)} ${r.fly.share.toFixed(2)} MN9 ${r.fly.feedHz.toFixed(0).padStart(3)}   spreadsheet ${r.spreadsheet.verdict.padEnd(17)} ${r.spreadsheet.p.toFixed(2)}`,
  );
for (const [who, s] of Object.entries(summary))
  if (refactorCheck) console.log(`${who}: ${JSON.stringify(s)}`);
  else
    console.log(
      `${who}: right changes approved ${s.rightApproved} (objected to ${s.rightObjected}), wrong changes caught ${s.wrongCaught} (approved ${s.wrongApproved}), abstained ${s.abstained}, balanced ${((s.balanced ?? 0) * 100).toFixed(1)}%, same verdict on both changes of ${s.sameVerdictPairs}/${SCENARIOS.length} tickets`,
    );
await atomicJSON(outPath, {
  at: new Date().toISOString(),
  note: 'Generated by npm run intent: hand-written tickets that change intended behavior, each with a right and a wrong change of the same kind, labels proven by execution against an independent reference, scored once against the live memory. Never taught.',
  memory: 'data/trained-memory.json',
  summary,
  rows,
  cases,
});
