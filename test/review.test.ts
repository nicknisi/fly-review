import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { RECEPTOR_KEYS, channelDiagnosis, parseFeatures, reviewVerdict } from '../src/review-brain.ts';
import type { Descriptors, ReviewBrain } from '../src/review-brain.ts';
import type { LessonEntry } from '../src/review-memory.ts';
import {
  LIVE_NOSE,
  RECEPTOR_GLOMERULUS,
  VERDICT_RECEPTORS,
  lexicalOdor,
  odorEntries,
  odorKey,
  odorize,
  tokenize,
} from '../src/review-odor.ts';
import { REVIEW_CASES, changedRange, changedText, customReviewCase, diffLines } from '../src/review-cases.ts';
import { encodeWithJev } from '../src/review-jev.ts';
import { emptyLedger, fold } from '../src/review-ledger.ts';
import { ReviewShow } from '../src/review-show.ts';
import { command } from '../src/io.ts';
import { executeProbe, parseProbe, proposeProbe } from '../src/review-verify.ts';

const testDir = await mkdtemp(join(tmpdir(), 'fly-review-tests-'));
after(() => rm(testDir, { recursive: true, force: true }));

/** Thirty descriptor probabilities: a mostly-quiet nose with a few receptors firing. */
const features = Object.fromEntries(
  RECEPTOR_KEYS.map(key => [
    key,
    ['changesComparison', 'touchesTiming', 'processesExternalInput'].includes(key) ? 0.8 : 0.1,
  ]),
) as Descriptors;
/** A mushroom-body reading. avoid/approach set the vote; the motor channels are for the drawing. */
const reading = (over: Partial<ReviewBrain> = {}): ReviewBrain => ({
  seed: 7,
  gain: 0.65,
  rates: [150],
  neurons: 176422,
  connections: 6287749,
  projection: [[1, 1]],
  feedHz: 0,
  groomHz: 0,
  escapeHz: 0,
  avoidHz: 117,
  approachHz: 79,
  noveltyHz: 0,
  activeKenyon: 203,
  activeKenyonIds: Array.from({ length: 203 }, (_, i) => 1000 + i),
  lesson: 'none',
  depressed: 0,
  rememberedSynapses: 0,
  spikes: 50,
  wallMs: 1,
  simulatedMs: 450,
  activity: [],
  frames: Array.from({ length: 10 }, (_, i) => ({
    timeMs: 225 + i * 25,
    feedHz: 0,
    groomHz: 0,
    escapeHz: 0,
    avoidHz: over.avoidHz ?? 117,
    approachHz: over.approachHz ?? 79,
    activeKenyon: 203,
    spikes: 5,
    inputSpikes: [1],
    activity: [],
  })),
  ...over,
});
const probe = { args: [1, 2, 50], expected: 1, rationale: 'TEST PROBE: round the subtotal only once.' };

test('diff rendering preserves old and new lines and identifies the actual changed range', () => {
  const review = REVIEW_CASES[0];
  const diff = diffLines(review.before, review.after);
  assert.equal(
    diff
      .filter(l => l.kind !== 'added')
      .map(l => l.text)
      .join('\n'),
    review.before,
  );
  assert.equal(
    diff
      .filter(l => l.kind !== 'removed')
      .map(l => l.text)
      .join('\n'),
    review.after,
  );
  assert.equal(changedRange(review), 'checkout.ts:6–8');
  assert.equal(diffLines('x', 'x').filter(l => l.kind !== 'same').length, 0);
});

test('the live nose never lets a verdict receptor reach the antenna; the lexical nose hears no Jev at all', () => {
  const sure = { ...features, restructuresOnly: 0.99, renameOnly: 0.99 };
  const text = 'const total = a + b;';
  const glomerulus = (k: (typeof VERDICT_RECEPTORS)[number]) => odorKey(RECEPTOR_GLOMERULUS[k]);
  assert.equal(LIVE_NOSE, 'neutral');
  for (const k of VERDICT_RECEPTORS) {
    assert.equal(odorize(sure, text)[glomerulus(k)], undefined, `${k} is silent through the live nose`);
    assert.ok(odorize(sure, text, 'full')[glomerulus(k)] > 0, `${k} is heard through the full nose`);
  }
  assert.deepEqual(odorize(sure, text, 'lexical'), lexicalOdor(tokenize(text)));
});

test('descriptors are bounded, the odor is sparse and deterministic, and the vote is the MBON balance', () => {
  assert.deepEqual(parseFeatures(features), features);
  assert.throws(() => parseFeatures({ ...features, changesComparison: NaN }));
  assert.throws(() => parseFeatures({ ...features, verdict: 'reject' }));
  const odor = odorize(features, 'return tool === "read" || humanApproved;\nreturn true;');
  const entries = odorEntries(odor);
  assert.equal(entries.length, 53);
  assert.equal(
    entries.filter(e => e.receptor && e.hz > 0).length,
    3,
    'only receptors above the floor reach the antenna',
  );
  assert.ok(entries.filter(e => !e.receptor && e.hz > 0).length >= 3, 'the tokens drive lexical glomeruli');
  assert.deepEqual(
    odorize(features, 'return tool === "read" || humanApproved;\nreturn true;'),
    odor,
    'same change, same smell',
  );
  assert.deepEqual(tokenize('return a >= b && !c;'), ['return', 'a', '>=', 'b', '&&', '!', 'c', ';']);
  assert.deepEqual(lexicalOdor(['export', 'function', 'return', '(', ')']), {}, 'background tokens are adapted out');
  assert.equal(reviewVerdict({ avoidHz: 0, approachHz: 0, feedHz: 0 }).verdict, 'abstain');
  assert.equal(
    reviewVerdict({ avoidHz: 117, approachHz: 79, feedHz: 0 }).verdict,
    'abstain',
    'a naive fly has no opinion',
  );
  assert.equal(reviewVerdict({ avoidHz: 124, approachHz: 20, feedHz: 0 }).verdict, 'changes_requested');
  assert.equal(reviewVerdict({ avoidHz: 124, approachHz: 20, feedHz: 0 }).behavior, 'still');
  assert.equal(reviewVerdict({ avoidHz: 17, approachHz: 90, feedHz: 0 }).verdict, 'no_objection');
  assert.match(reviewVerdict({ avoidHz: 17, approachHz: 90, feedHz: 0 }).explanation, /did not reach/);
  const reached = reviewVerdict({ avoidHz: 60, approachHz: 90, feedHz: 36 });
  assert.equal(reached.verdict, 'no_objection', 'the body decides when it reaches for the smell');
  assert.equal(reached.behavior, 'reached');
  assert.match(reached.explanation, /reached for it/);
  assert.equal(reviewVerdict({ avoidHz: 60, approachHz: 90, feedHz: 4 }).behavior, 'still', 'below the reach line');
  assert.throws(() => reviewVerdict({ avoidHz: NaN, approachHz: 0, feedHz: 0 }));
  assert.throws(() => reviewVerdict({ avoidHz: 1, approachHz: 0, feedHz: -1 }));
});

test('channel diagnosis reports the odor code, the MBON balance, and the memory', () => {
  const naive = channelDiagnosis(reading());
  assert.deepEqual(
    naive.channels.map(c => c.silent),
    [true, true, true],
  );
  assert.match(naive.summary, /203 Kenyon cells carried this odor/);
  assert.match(naive.summary, /neither won \(share 0.60/);
  assert.match(naive.summary, /no memory yet/);
  const taught = channelDiagnosis(reading({ avoidHz: 124, approachHz: 20, rememberedSynapses: 999 }));
  assert.match(taught.summary, /avoidance won \(share 0.86/);
  assert.match(taught.summary, /999 synapses carry memory/);
  assert.match(channelDiagnosis(reading({ groomHz: 196 })).channels[1].hz.toString(), /196/);
});

test('the ledger folds votes and verifications into counts without keeping code', () => {
  const ledger = emptyLedger();
  fold(ledger, {
    type: 'vote',
    at: 't',
    runDir: 'r1',
    caseId: 'audit-log',
    custom: false,
    feedHz: 54,
    groomHz: 0,
    escapeHz: 430,
    verdict: 'no_objection',
  });
  fold(ledger, {
    type: 'vote',
    at: 't',
    runDir: 'r2',
    caseId: 'leg-count',
    custom: false,
    feedHz: 0,
    groomHz: 0,
    escapeHz: 80,
    verdict: 'changes_requested',
  });
  fold(ledger, {
    type: 'verification',
    at: 't',
    runDir: 'r1',
    caseId: 'audit-log',
    verdict: 'no_objection',
    status: 'confirmed',
  });
  fold(ledger, {
    type: 'verification',
    at: 't',
    runDir: 'r2',
    caseId: 'leg-count',
    verdict: 'changes_requested',
    status: 'unsubstantiated',
  });
  assert.equal(ledger.trials, 2);
  assert.deepEqual(ledger.fired, [1, 0, 2]);
  assert.deepEqual(ledger.escapeRange, [80, 430]);
  assert.equal(ledger.missed, 1);
  assert.equal(ledger.falseAlarms, 1);
  assert.equal(ledger.caught, 0);
});

test('a pasted change becomes a reviewable case with no oracle, and bad input is refused', () => {
  const review = customReviewCase({
    filename: ' pricing.ts ',
    before: 'export function f(a: number) {\r\n  return a;\r\n}',
    after: 'export function f(a: number) {\n  return a + 1;\n}',
    context: '',
  });
  assert.equal(review.id, 'custom');
  assert.equal(review.oracle, null);
  assert.equal(review.contract, null);
  assert.equal(review.filename, 'pricing.ts');
  assert.equal(review.functionName, 'f');
  assert.equal(review.context, 'No caller context was provided.');
  assert.doesNotMatch(review.before, /\r/);
  const base = { filename: 'x.ts', before: 'a', after: 'b', context: '' };
  assert.throws(() => customReviewCase({ ...base, after: 'a' }), /identical/);
  assert.throws(() => customReviewCase({ ...base, filename: '../x.ts' }), /Filename/);
  assert.throws(() => customReviewCase({ ...base, filename: 'before.ts' }), /Filename/);
  assert.throws(() => customReviewCase({ ...base, filename: 'x.js' }), /Filename/);
  assert.throws(() => customReviewCase({ ...base, before: 'x'.repeat(12_001) }), /12,000/);
  assert.throws(() => customReviewCase({ ...base, before: '   ' }), /need code/);
  assert.throws(() => customReviewCase(null));
  assert.throws(() => customReviewCase({ ...base, before: 42 }), /must be text/);
});

test('Jev request batches thirty descriptive Nouls, not a review decision; malformed answers fail closed', async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-only';
  try {
    const mock: typeof fetch = async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      assert.equal(body.state.after, REVIEW_CASES[0].after);
      assert.equal(Object.keys(body.questions).length, 30);
      for (const question of Object.values(body.questions) as { type: string; instructions: string }[]) {
        assert.equal(question.type, 'noul');
        assert.match(question.instructions, /do not judge whether the change is good/);
      }
      return Response.json({
        model: 'test-jev',
        answers: Object.fromEntries(Object.entries(features).map(([k, noul]) => [k, { type: 'noul', noul }])),
      });
    };
    assert.deepEqual((await encodeWithJev(REVIEW_CASES[0], mock)).features, features);
    await assert.rejects(
      encodeWithJev(REVIEW_CASES[0], async () => Response.json({ model: 'test', answers: {} })),
      /invalid feature/,
    );
    await assert.rejects(
      encodeWithJev(REVIEW_CASES[0], async () => new Response('', { status: 429 })),
      /Jev HTTP 429/,
    );
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test('independent investigator sees code and caller context but neither the contract nor the neural verdict', async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-only';
  try {
    const mock: typeof fetch = async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      const state = JSON.parse(body.messages[0].content);
      assert.deepEqual(Object.keys(state).sort(), ['after', 'before', 'context', 'functionName', 'parameters']);
      assert.equal(state.functionName, REVIEW_CASES[0].functionName);
      assert.equal('contract' in state, false);
      assert.doesNotMatch(init?.body as string, /round ONCE/);
      assert.match(body.system, /NOT given the specification/);
      assert.equal(body.tool_choice.name, 'propose_probe');
      return Response.json({
        model: 'test-investigator',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'propose_probe', input: probe }],
      });
    };
    assert.deepEqual((await proposeProbe(REVIEW_CASES[0], mock)).probe, probe);
    await assert.rejects(
      proposeProbe(REVIEW_CASES[0], async () => Response.json({ stop_reason: 'max_tokens', content: [] })),
      /complete typed probe/,
    );
    const pasted = customReviewCase({ filename: 'x.ts', before: 'a', after: 'b', context: '' });
    await assert.rejects(proposeProbe(pasted, mock), /fly vote only/);
    await assert.rejects(executeProbe(pasted, { args: [], expected: 1, rationale: 'x' }, 'test'), /fly vote only/);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test('actual execution proves a regression, rejects a fabricated expectation, and does not certify a harmless refactor', async () => {
  const bug = await executeProbe(REVIEW_CASES[0], probe, 'test');
  assert.equal(bug.status, 'confirmed');
  assert.equal(bug.counterexample?.before.value, 1);
  assert.equal(bug.counterexample?.after.value, 2);
  assert.equal(bug.runs.length, 49);
  assert.equal(bug.probeFoundRegression, true);
  assert.equal(bug.sweepFoundRegression, true);
  assert.match(bug.explanation, /own input exposed it/);
  // A blind guess that happens to agree before and after: the sweep still reproduces the regression, and says so.
  const missedProbe = await executeProbe(
    REVIEW_CASES[0],
    { args: [100, 1, 0], expected: 100, rationale: 'TEST: a case both versions agree on.' },
    'test',
  );
  assert.equal(missedProbe.status, 'confirmed');
  assert.equal(missedProbe.probeFoundRegression, false);
  assert.equal(missedProbe.sweepFoundRegression, true);
  assert.match(missedProbe.explanation, /did not expose it; the deterministic sweep did/);
  assert.notDeepEqual(missedProbe.counterexample?.args, [100, 1, 0]);
  const invented = await executeProbe(REVIEW_CASES[0], { ...probe, expected: 999 }, 'test');
  assert.equal(invented.modelExpectedCorrect, false);
  assert.equal(invented.counterexample?.expected, 1);
  const refactor = await executeProbe(REVIEW_CASES[1], probe, 'test');
  assert.equal(refactor.status, 'unsubstantiated');
  assert.match(refactor.explanation, /not proof/);
  const brokenOriginal = await executeProbe(
    { ...REVIEW_CASES[0], before: 'export function calculateTotal() { return -1; }' },
    probe,
    'test',
  );
  assert.equal(brokenOriginal.status, 'inconclusive');
  assert.throws(() => parseProbe({ ...probe, args: [1, -1, 50] }, REVIEW_CASES[0]));
});

test('review flow labels manual input, preserves original verdict during ablation, and executes verification', async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-only';
  let calls = 0,
    forgotten = 0;
  const lessons: string[] = [];
  const remembered: LessonEntry[] = [];
  const inProgressReceipts: unknown[] = [];
  const recorded: unknown[] = [];
  const show = new ReviewShow(
    state => {
      if (state.phase === 'investigating') inProgressReceipts.push(state.verification);
    },
    {
      runsPath: testDir,
      memoryPath: join(testDir, 'memory.json'),
      encode: async () => {
        throw new Error('Manual mode must not invoke Jev');
      },
      investigate: async () => ({ probe, model: 'test-only' }),
      record: async entry => {
        recorded.push(entry);
      },
      smell: async (_odor, options = {}) => {
        calls++;
        const { seed = 7, gain = 0.65, lesson = 'none' } = options;
        if (lesson !== 'none') lessons.push(lesson);
        // Naive: undecided. After a punishment: avoidance wins. Disconnected: silent.
        const taught = lessons.filter(l => l === 'punish').length;
        return reading({
          seed,
          gain,
          wallMs: calls,
          avoidHz: gain ? 117 + 7 * taught : 0,
          approachHz: gain ? Math.max(20, 79 - 59 * taught) : 0,
          lesson,
          depressed: lesson === 'none' ? 0 : 999,
          rememberedSynapses: lesson === 'none' ? 999 * taught : 999 * (taught + (lesson === 'punish' ? 0 : 0)),
          ppl1Hz: lesson === 'punish' ? 226 : 0,
          pamHz: lesson === 'reward' ? 200 : 0,
          teaching:
            lesson === 'none'
              ? null
              : {
                  pathway: lesson === 'punish' ? 'bitter+ppl1' : 'sugar+pam',
                  ppl1Spikes: lesson === 'punish' ? 1876 : 0,
                  pamSpikes: lesson === 'reward' ? 28428 : 0,
                  alphaPrime3Spikes: 0,
                  compartments: {
                    MBON11: { group: 'approach', depressed: 700, meanFactor: 0.43, dopamine: 0.96 },
                    MBON14: { group: 'approach', depressed: 200, meanFactor: 0.48, dopamine: 0.82 },
                    MBON30: { group: 'avoid', depressed: 99, meanFactor: 0.49, dopamine: 0.83 },
                  },
                },
        });
      },
      rememberLesson: async entry => {
        remembered.push(entry);
      },
      loadLessons: async () => [...remembered],
      forget: async () => {
        forgotten++;
        lessons.length = 0;
        remembered.length = 0;
      },
    },
  );
  try {
    await show.act({ action: 'review', mode: 'manual', caseId: 'rounding', features });
    assert.equal(show.state.source, 'manual');
    assert.equal(show.state.encoderModel, null);
    assert.equal(show.state.verdict?.verdict, 'abstain', 'a fly with no memory has no opinion');
    assert.match(show.state.channels?.summary ?? '', /no memory yet/);
    assert.ok(show.state.odor && Object.keys(show.state.odor).length > 3, 'the review presented an odor');
    assert.equal(show.state.ledger.trials, 1);
    const original = structuredClone(show.state.brain);
    await show.act({ action: 'disconnect' });
    assert.deepEqual(show.state.brain, original);
    assert.equal(show.state.ablation?.avoidHz, 0);
    await show.act({ action: 'repeat' });
    assert.equal(show.state.repeat?.identical, true);
    await show.act({ action: 'verify', vote: 'yes' });
    assert.equal(show.state.verification?.status, 'confirmed');
    assert.equal(show.state.vote, 'yes');
    assert.equal(recorded.length, 2);
    // Dopamine: a reproduced regression punishes this odor, and only this run's verification does the teaching.
    assert.deepEqual(lessons, ['punish']);
    assert.equal(show.state.lesson?.lesson, 'punish');
    assert.equal(show.state.lesson?.depressed, 999);
    assert.equal(show.state.memory.lessons.length, 1);
    assert.equal(show.state.memory.rememberedSynapses, 999);
    assert.equal(remembered.length, 1);
    assert.match(
      show.state.log[0].text,
      /Bitter on its proboscis while it smelled this: its PPL1 dopamine neurons fired at 226 Hz, and 999 synapses of the 203 Kenyon cells carrying the odor were depressed where that dopamine landed \(900 onto approach MBONs, 99 onto avoidance\)/,
    );
    assert.equal(show.state.lesson?.teaching?.pathway, 'bitter+ppl1');
    assert.deepEqual(show.state.lesson?.teaching?.byGroup, { avoid: 99, approach: 900, novelty: 0 });
    assert.equal(show.state.lesson?.teaching?.compartments[0].mbon, 'MBON11', 'strongest dopamine first');
    assert.equal(show.state.teaching?.lesson, 'punish', 'the teaching trial is recorded for playback');
    // The causal check: same change, same description, same seed; only the memory differs.
    const before = show.state.brain!;
    await show.act({ action: 'recall' });
    assert.equal(show.state.brain?.seed, before.seed);
    assert.deepEqual(show.state.features, features);
    assert.deepEqual(
      show.state.odor,
      odorize(features, changedText(REVIEW_CASES.find(c => c.id === 'rounding')!)),
      'recall presents the identical odor',
    );
    assert.equal(show.state.verdict?.verdict, 'changes_requested', 'after punishment the same odor is avoided');
    assert.equal(show.state.memory.lessons.length, 1, 'recall teaches nothing');
    assert.match(show.state.log.map(l => l.text).join('\n'), /smells the same change again/);
    await show.act({ action: 'reset-memory' });
    assert.equal(forgotten, 1);
    assert.deepEqual(show.state.memory, { rememberedSynapses: 0, lessons: [] });
    await show.act({ action: 'recall' });
    assert.equal(show.state.verdict?.verdict, 'abstain', 'reset the memory and the effect disappears');
    await assert.rejects(show.act({ action: 'reset-memory' }), /nothing to forget/);
    await show.act({ action: 'review', mode: 'manual', caseId: 'rounding', features });
    await show.act({ action: 'verify', vote: 'yes' });
    const persisted = JSON.parse(await readFile(join(show.state.runDir!, 'review.json'), 'utf8'));
    assert.equal(persisted.busy, false);
    assert.match(await readFile(join(show.state.runDir!, 'regression.test.ts'), 'utf8'), /assert.equal/);
    await assert.rejects(command(process.execPath, [join(show.state.runDir!, 'regression.test.ts')]), /2 !== 1/);
    await show.act({ action: 'verify' });
    assert.ok(inProgressReceipts.length >= 6);
    assert.ok(
      inProgressReceipts.every(receipt => receipt === null),
      'A fresh investigation must not show a previous result as its own',
    );
    // A pasted change is voted on with the same simulator, saved under its own filename, and refused verification.
    const custom = {
      filename: 'pricing.ts',
      before: 'export function price(): number {\n  return 1;\n}',
      after: 'export function price(): number {\n  return 2;\n}',
      context: 'Called at checkout.',
    };
    const previousRun = show.state.runDir!;
    await show.act({ action: 'review', mode: 'manual', caseId: 'custom', features, custom });
    assert.equal(show.state.review.custom, true);
    assert.equal(show.state.review.oracle, null);
    assert.ok(show.state.ledger.trials >= 4, 'the ledger carries across runs');
    assert.equal(await readFile(join(show.state.runDir!, 'pricing.ts'), 'utf8'), custom.after);
    await assert.rejects(show.act({ action: 'verify' }), /fly vote only/);
    assert.equal(show.state.phase, 'ready', 'a refused verification does not disturb the recorded vote');
    await rm(previousRun, { recursive: true, force: true });
    await assert.rejects(
      show.act({
        action: 'review',
        mode: 'manual',
        caseId: 'custom',
        features,
        custom: { ...custom, after: custom.before },
      }),
      /identical/,
    );
  } finally {
    if (show.state.runDir) await rm(show.state.runDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test('missing Jev credentials cannot silently become manual input', async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const show = new ReviewShow();
    await assert.rejects(
      show.act({ action: 'review', mode: 'jev', caseId: 'rounding' }),
      /Manual mode must be selected explicitly/,
    );
    assert.equal(show.state.runDir, null);
  } finally {
    if (previous !== undefined) process.env.TYPESAFE_API_KEY = previous;
  }
});

test('a poke stimulates one named sensory population, is recorded beside the review, and never touches the vote', async () => {
  const calls: unknown[] = [];
  const show = new ReviewShow(() => {}, {
    runsPath: testDir,
    memoryPath: join(testDir, 'memory.json'),
    encode: async () => {
      throw new Error('no Jev in this test');
    },
    smell: async (_odor, options = {}) => reading({ seed: options.seed ?? 7, gain: options.gain ?? 0.65 }),
    poke: async (stimuli, seed, gain) => {
      calls.push({ stimuli, seed, gain });
      return reading({ groomHz: 196, avoidHz: 0, approachHz: 0, stimuli, rates: [150] });
    },
    record: async () => {},
    rememberLesson: async () => {},
    forget: async () => {},
  });
  try {
    await show.act({ action: 'poke', stimuli: { antennae: 150 } });
    assert.deepEqual(calls, [{ stimuli: { antennae: 150 }, seed: 7, gain: 0.65 }]);
    assert.equal(show.state.poke?.brain.groomHz, 196);
    assert.equal(show.state.poke?.channels.channels[1].hz, 196);
    assert.equal(show.state.poking, false);
    assert.equal(show.state.brain, null, 'a poke is not a review');
    assert.equal(show.state.runDir, null);
    assert.match(show.state.log[0].text, /Poke result: A 0 Hz, B 196 Hz, C 0 Hz/);
    await show.act({ action: 'review', mode: 'manual', caseId: 'leg-count', features });
    assert.equal(show.state.poke?.brain.groomHz, 196, 'the last poke survives a new review');
    assert.equal(show.state.verdict?.verdict, 'abstain');
    await assert.rejects(show.act({ action: 'poke', stimuli: { wings: 150 } }), /Unknown poke/);
    await assert.rejects(show.act({ action: 'poke', stimuli: { eyes: 999 } }), /1 to 200 Hz/);
    await assert.rejects(show.act({ action: 'poke', stimuli: {} }), /one to 3/);
    await assert.rejects(
      show.act({ action: 'poke', stimuli: { eyes: 100, sugar: 100, feet: 100, brush: 100 } }),
      /one to 3/,
    );
    assert.equal(show.state.verdict?.verdict, 'abstain', 'refused pokes leave the review alone');
  } finally {
    if (show.state.runDir) await rm(show.state.runDir, { recursive: true, force: true });
  }
});
