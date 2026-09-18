import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parseFeatures, reviewVerdict } from '../src/review-brain.ts';
import type { ReviewBrain } from '../src/review-brain.ts';
import { REVIEW_CASES, changedRange, diffLines } from '../src/review-cases.ts';
import { encodeWithJev } from '../src/review-jev.ts';
import { ReviewShow } from '../src/review-show.ts';
import { command } from '../src/io.ts';
import { executeProbe, parseProbe, proposeProbe } from '../src/review-verify.ts';

const features = { externalInput: .5, persistentData: .5, timing: .5, visibleBehavior: .5 };
const probe = { args: [1, 2, 50], expected: 1, rationale: 'TEST PROBE: round the subtotal only once.' };

test('diff rendering preserves old and new lines and identifies the actual changed range', () => {
  const review = REVIEW_CASES[0];
  const diff = diffLines(review.before, review.after);
  assert.equal(diff.filter(l => l.kind !== 'added').map(l => l.text).join('\n'), review.before);
  assert.equal(diff.filter(l => l.kind !== 'removed').map(l => l.text).join('\n'), review.after);
  assert.equal(changedRange(review), 'checkout.ts:6–8');
  assert.equal(diffLines('x', 'x').filter(l => l.kind !== 'same').length, 0);
});

test('descriptive features are bounded independently; readout can reject, raise no objection, or abstain', () => {
  assert.deepEqual(parseFeatures(features), features);
  assert.throws(() => parseFeatures({ ...features, timing: NaN }));
  assert.throws(() => parseFeatures({ ...features, verdict: 'reject' }));
  assert.equal(reviewVerdict({ feedHz: 0, groomHz: 0, escapeHz: 0 }).verdict, 'abstain');
  assert.equal(reviewVerdict({ feedHz: 0, groomHz: 0, escapeHz: 400 }).verdict, 'changes_requested');
  assert.equal(reviewVerdict({ feedHz: 90, groomHz: 0, escapeHz: 0 }).verdict, 'no_objection');
  assert.throws(() => reviewVerdict({ feedHz: NaN, groomHz: 0, escapeHz: 0 }));
});

test('Jev request batches four Nouls, not a review decision; malformed answers fail closed', async () => {
  const previous = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'test-only';
  try {
    const mock: typeof fetch = async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      assert.equal(body.state.after, REVIEW_CASES[0].after);
      assert.equal(Object.keys(body.questions).length, 4);
      for (const question of Object.values(body.questions) as { type: string; instructions: string }[]) {
        assert.equal(question.type, 'noul'); assert.match(question.instructions, /not whether the patch/);
      }
      return Response.json({ model: 'test-jev', answers: Object.fromEntries(Object.entries(features).map(([k, noul]) => [k, { type: 'noul', noul }])) });
    };
    assert.deepEqual((await encodeWithJev(REVIEW_CASES[0], mock)).features, features);
    await assert.rejects(encodeWithJev(REVIEW_CASES[0], async () => Response.json({ model: 'test', answers: {} })), /invalid feature/);
    await assert.rejects(encodeWithJev(REVIEW_CASES[0], async () => new Response('', { status: 429 })), /Jev HTTP 429/);
  } finally { if (previous === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previous; }
});

test('independent investigator sees code and contract but no neural verdict', async () => {
  const previous = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'test-only';
  try {
    const mock: typeof fetch = async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      const state = JSON.parse(body.messages[0].content);
      assert.deepEqual(Object.keys(state).sort(), ['after', 'before', 'context', 'contract', 'functionName', 'parameters']);
      assert.equal(state.functionName, REVIEW_CASES[0].functionName);
      assert.equal(state.contract, REVIEW_CASES[0].contract);
      assert.equal(body.tool_choice.name, 'propose_probe');
      return Response.json({ model: 'test-investigator', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'propose_probe', input: probe }] });
    };
    assert.deepEqual((await proposeProbe(REVIEW_CASES[0], mock)).probe, probe);
    await assert.rejects(proposeProbe(REVIEW_CASES[0], async () => Response.json({ stop_reason: 'max_tokens', content: [] })), /complete typed probe/);
  } finally { if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous; }
});

test('actual execution proves a regression, rejects a fabricated expectation, and does not certify a harmless refactor', async () => {
  const bug = await executeProbe(REVIEW_CASES[0], probe, 'test');
  assert.equal(bug.status, 'confirmed');
  assert.equal(bug.counterexample?.before.value, 1);
  assert.equal(bug.counterexample?.after.value, 2);
  assert.equal(bug.runs.length, 49);
  const invented = await executeProbe(REVIEW_CASES[0], { ...probe, expected: 999 }, 'test');
  assert.equal(invented.modelExpectedCorrect, false);
  assert.equal(invented.counterexample?.expected, 1);
  const refactor = await executeProbe(REVIEW_CASES[1], probe, 'test');
  assert.equal(refactor.status, 'unsubstantiated');
  assert.match(refactor.explanation, /not proof/);
  const brokenOriginal = await executeProbe({ ...REVIEW_CASES[0], before: 'export function calculateTotal() { return -1; }' }, probe, 'test');
  assert.equal(brokenOriginal.status, 'inconclusive');
  assert.throws(() => parseProbe({ ...probe, args: [1, -1, 50] }, REVIEW_CASES[0]));
});

test('review flow labels manual input, preserves original verdict during ablation, and executes verification', async () => {
  const previous = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'test-only';
  let calls = 0;
  const inProgressReceipts: unknown[] = [];
  const show = new ReviewShow(state => { if (state.phase === 'investigating') inProgressReceipts.push(state.verification); }, {
    encode: async () => { throw new Error('Manual mode must not invoke Jev'); },
    investigate: async () => ({ probe, model: 'test-only' }),
    simulate: async (_features, seed = 7, gain = .65): Promise<ReviewBrain> => {
      calls++;
      const rate = gain ? 400 : 0;
      return { seed, gain, rates: [90,90,90,90], groups: [274,261,263,257], neurons:176422, connections:6287749, projection:[[1,1]], feedHz:0,groomHz:0,escapeHz:rate,spikes:50,wallMs:calls,simulatedMs:450,activity:[],frames:Array.from({length:10},(_,i)=>({timeMs:225+i*25,feedHz:0,groomHz:0,escapeHz:rate,spikes:5,inputSpikes:[1,1,1,1],activity:[]})) };
    },
  });
  try {
    await show.act({ action: 'review', mode: 'manual', caseId: 'rounding', features });
    assert.equal(show.state.source, 'manual');
    assert.equal(show.state.encoderModel, null);
    const original = structuredClone(show.state.brain);
    await show.act({ action: 'disconnect' });
    assert.deepEqual(show.state.brain, original);
    assert.equal(show.state.ablation?.escapeHz, 0);
    await show.act({ action: 'repeat' });
    assert.equal(show.state.repeat?.identical, true);
    await show.act({ action: 'verify', vote: 'yes' });
    assert.equal(show.state.verification?.status, 'confirmed');
    assert.equal(show.state.vote, 'yes');
    const persisted = JSON.parse(await readFile(join(show.state.runDir!, 'review.json'), 'utf8'));
    assert.equal(persisted.busy, false);
    assert.match(await readFile(join(show.state.runDir!, 'regression.test.ts'), 'utf8'), /assert.equal/);
    await assert.rejects(command(process.execPath, [join(show.state.runDir!, 'regression.test.ts')]), /2 !== 1/);
    await show.act({ action: 'verify' });
    assert.ok(inProgressReceipts.length >= 4);
    assert.ok(inProgressReceipts.every(receipt => receipt === null), 'A fresh investigation must not show a previous result as its own');
  } finally {
    if (show.state.runDir) await rm(show.state.runDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test('missing Jev credentials cannot silently become manual input', async () => {
  const previous = process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY;
  try {
    const show = new ReviewShow();
    await assert.rejects(show.act({ action: 'review', mode: 'jev', caseId: 'rounding' }), /Manual mode must be selected explicitly/);
    assert.equal(show.state.runDir, null);
  } finally { if (previous !== undefined) process.env.TYPESAFE_API_KEY = previous; }
});
