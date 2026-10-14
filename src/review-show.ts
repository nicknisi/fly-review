import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { atomicJSON, hash, RUNS_ROOT } from './io.ts';
import {
  REVIEW_CASES,
  DEFAULT_REVIEW_CASE,
  CUSTOM_CASE_ID,
  changedRange,
  customReviewCase,
  flyName,
} from './review-cases.ts';
import type { ReviewCase } from './review-cases.ts';
import { changedText } from './review-cases.ts';
import type { Features, FlyVerdict, ReviewBrain } from './review-brain.ts';
import {
  channelDiagnosis,
  MEMORY_PATH,
  parseFeatures,
  pokeBrain,
  reviewVerdict,
  smellBrain,
  smellSequence,
} from './review-brain.ts';
import { reviewUnits, standsOut, tallyVotes, unitState } from './review-hunks.ts';
import type { ReviewUnit } from './review-hunks.ts';
import {
  checkSnapshot,
  describeTeaching,
  emptyMemory,
  lessonFor,
  loadMemoryLog,
  promoteMemory,
  resetMemory,
  snapshotMemory,
  summarizeTeaching,
} from './review-memory.ts';
import type { LessonEntry, Memory, MemorySnapshot } from './review-memory.ts';
import { odorize } from './review-odor.ts';
import { POKE_PRESETS, parsePokeStimuli } from './review-pokes.ts';
import type { PokePreset } from './review-pokes.ts';
import {
  PULL_REQUEST_CASE_ID,
  fetchPullRequest,
  githubToken,
  parsePullRequestRef,
  postReview,
  pullRequestCase,
  pullRequestKey,
  reviewComment,
} from './review-github.ts';
import type { PullRequest } from './review-github.ts';
import { encodeUnitWithJev, encodeWithJev, jevState } from './review-jev.ts';
import { appendLedger, emptyLedger, fold, loadLedger } from './review-ledger.ts';
import type { Ledger, LedgerEntry } from './review-ledger.ts';
import { executeProbe, proposeProbe } from './review-verify.ts';
import type { NearestLesson, ReviewState } from './review-types.ts';

import { parseReviewAction } from './review-action.ts';
import type { ReviewAction } from './review-action.ts';
export type { ReviewAction } from './review-action.ts';
export const DEFAULT_SEED = 7;
const PR_CACHE_MS = 5 * 60_000;

function parseSeed(value: unknown): number {
  if (value === undefined) return DEFAULT_SEED;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 9999)
    throw new Error('A fly is a seed from 1 to 9999');
  return value;
}

/**
 * Exactly what a live review sends to TypeSafe. A pull request goes as one request per hunk, each with the title and
 * description as context, so that is what the disclosure shows; a single change goes as one request.
 */
export function disclosurePayload(review: ReviewCase) {
  if (!review.pullRequest) return jevState(review);
  const plan = reviewUnits(review.pullRequest);
  return {
    note: `Sent as ${plan.units.length} separate requests, one per ${plan.granularity}, each carrying the pull request title and description.${plan.skipped ? ` ${plan.skipped} smaller files are not sent.` : ''}`,
    requests: plan.units.map(unit => unitState(review.pullRequest!, unit)),
  };
}

export class ReviewShow {
  state: ReviewState;
  private operating = false;
  get busy(): boolean {
    return this.operating;
  }
  private notify: (state: ReviewState) => void;
  private dependencies: {
    encode: typeof encodeWithJev;
    encodeUnit: typeof encodeUnitWithJev;
    smell: typeof smellBrain;
    smellSequence: typeof smellSequence;
    poke: typeof pokeBrain;
    rememberLesson: (entry: LessonEntry, after: MemorySnapshot, before: MemorySnapshot) => Promise<void>;
    memoryPath: string;
    runsPath: string;
    loadLessons: () => Promise<LessonEntry[]>;
    forget: () => Promise<void>;
    investigate: typeof proposeProbe;
    record: (entry: LedgerEntry) => Promise<void>;
    fetchPullRequest: typeof fetchPullRequest;
    postReview: typeof postReview;
    githubToken: typeof githubToken;
    persist: typeof atomicJSON;
  };
  private pullRequests = new Map<string, PullRequest>();
  constructor(notify: (state: ReviewState) => void = () => {}, dependencies: Partial<ReviewShow['dependencies']> = {}) {
    this.notify = notify;
    this.dependencies = {
      encode: encodeWithJev,
      encodeUnit: encodeUnitWithJev,
      smell: smellBrain,
      smellSequence,
      poke: pokeBrain,
      rememberLesson: (entry, after, before) =>
        promoteMemory(after, entry, before, dependencies.memoryPath ?? MEMORY_PATH),
      forget: () => resetMemory(dependencies.memoryPath ?? MEMORY_PATH),
      memoryPath: MEMORY_PATH,
      runsPath: RUNS_ROOT,
      loadLessons: () => loadMemoryLog(dependencies.memoryPath ?? MEMORY_PATH),
      investigate: proposeProbe,
      record: appendLedger,
      fetchPullRequest,
      postReview,
      githubToken,
      persist: atomicJSON,
      ...dependencies,
    };
    this.state = {
      phase: 'idle',
      busy: false,
      review: DEFAULT_REVIEW_CASE,
      headline: 'Your least qualified reviewer has arrived.',
      explanation:
        'A real diff. Thirty neutral descriptors. A simulated fly brain. Then an executable attempt to test the verdict.',
      source: null,
      features: null,
      encoderModel: null,
      brain: null,
      verdict: null,
      channels: null,
      odor: null,
      lesson: null,
      teaching: null,
      memory: emptyMemory(),
      nearest: null,
      attention: null,
      memoryInput: null,
      history: [],
      recordingHistorical: false,
      memoryComparison: null,
      odorCodeVersion: 'male-cns-v1.0:53-glomeruli:kc-top5:v1',
      ablation: null,
      repeat: null,
      verification: null,
      vote: null,
      hasJev: Boolean(process.env.TYPESAFE_API_KEY),
      hasInvestigator: Boolean(process.env.ANTHROPIC_API_KEY) && process.env.FLY_REVIEW_PUBLIC !== '1',
      hasGitHub: false,
      public: process.env.FLY_REVIEW_PUBLIC === '1',
      posted: null,
      poke: null,
      pokePair: null,
      poking: false,
      runDir: null,
      log: [],
      ledger: emptyLedger(),
    };
  }

  /** Full lesson entries, Kenyon-cell ids included; the state carries them without the ids. */
  private lessons: LessonEntry[] = [];
  private async refreshLessons(): Promise<Memory> {
    this.lessons = await this.dependencies.loadLessons();
    return {
      rememberedSynapses: this.lessons.at(-1)?.rememberedSynapses ?? 0,
      lessons: this.lessons.map(({ kenyonIds: _ids, ...entry }) => entry),
    };
  }
  /** Which taught odors this trial's Kenyon-cell code resembles. Overlap of codes, not attribution of the vote. */
  private nearestLessons(brain: ReviewBrain): NearestLesson[] {
    const active = new Set(brain.activeKenyonIds);
    return this.lessons
      .filter(l => l.kenyonIds?.length)
      .map(l => {
        const shared = l.kenyonIds!.filter(id => active.has(id)).length;
        return {
          caseId: l.caseId,
          title: l.title,
          lesson: l.lesson,
          source: l.source,
          smell: l.smell,
          shared,
          overlap: shared / (active.size + l.kenyonIds!.length - shared),
        };
      })
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 5);
  }
  /** Load what has taught the fly so far. The synapse factors themselves live in memory.json and are read by the bridge. */
  async loadMemory(): Promise<void> {
    this.state.memory = await this.refreshLessons();
    this.notify(this.state);
  }
  /** Discover GitHub credentials once at startup; the flag only unlocks fetching private pull requests and posting. */
  async loadGitHub(): Promise<boolean> {
    this.state.hasGitHub = Boolean(await this.dependencies.githubToken());
    this.notify(this.state);
    return this.state.hasGitHub;
  }
  /** Fetch (or reuse for five minutes) a pull request so the page can show exactly what the encoder will see. */
  async pullRequest(reference: unknown): Promise<PullRequest> {
    const ref = parsePullRequestRef(reference),
      key = pullRequestKey(ref);
    const cached = this.pullRequests.get(key);
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < PR_CACHE_MS) return cached;
    const pr = await this.dependencies.fetchPullRequest(ref);
    this.pullRequests.set(key, pr);
    return pr;
  }

  private async caseFor(request: Extract<ReviewAction, { action: 'review' }>): Promise<ReviewCase> {
    const review =
      request.caseId === PULL_REQUEST_CASE_ID
        ? pullRequestCase(await this.pullRequest(request.pullRequest))
        : request.caseId === CUSTOM_CASE_ID
          ? customReviewCase(request.custom)
          : REVIEW_CASES.find(c => c.id === request.caseId);
    if (!review) throw new Error('Unknown review example');
    // Generated, binary, and over-budget files are never shown to Jev; a pull request made only of them leaves the fly
    // nothing to smell, so say so here, before disclosure or a model call, rather than fail inside the simulator.
    if (request.mode === 'jev' && review.pullRequest && !reviewUnits(review.pullRequest).units.length)
      throw new Error(
        `Nothing for the fly to smell: every changed file was left out (${review.pullRequest.files
          .map(f => `${f.filename}: ${f.omitted ?? 'no patch'}`)
          .join(', ')}). Pick a pull request that changes code.`,
      );
    return review;
  }

  /** Preparing disclosure fetches code if needed, but never sends it to a model. */
  async disclosure(input: unknown) {
    const request = parseReviewAction(input);
    if (request.action !== 'review' || request.mode !== 'jev') throw new Error('Disclosure is for a live review');
    const review = await this.caseFor(request);
    const payload = disclosurePayload(review);
    return { hash: hash(JSON.stringify(payload)), provider: 'TypeSafe (api.typesafe.ai)', payload };
  }

  /** Load the fly's record from disk. Call once at startup; the in-memory ledger is folded forward from there. */
  async loadLedger(): Promise<Ledger> {
    this.state.ledger = await loadLedger();
    this.notify(this.state);
    return this.state.ledger;
  }
  private async record(entry: LedgerEntry) {
    await this.dependencies.record(entry);
    fold(this.state.ledger, entry);
  }

  private async publish(text?: string, data?: unknown) {
    this.state.busy = this.busy;
    if (text) {
      this.state.log.unshift({ at: new Date().toISOString(), text });
      this.state.log = this.state.log.slice(0, 16);
      if (this.state.runDir)
        await appendFile(
          join(this.state.runDir, 'events.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), text, data }) + '\n',
          { mode: 0o600 },
        );
    }
    this.notify(this.state);
  }

  async act(input: unknown): Promise<void> {
    if (this.busy) throw new Error('Wait for the current review operation to finish.');
    this.operating = true;
    try {
      const request = parseReviewAction(input);
      // Validate before mutating the current run, including explicit mode and credentials.
      let review: ReviewCase | null = null,
        seed = DEFAULT_SEED;
      if (request.action === 'review') {
        review = await this.caseFor(request);
        if (!['jev', 'manual'].includes(request.mode)) throw new Error('Select live Jev or explicit manual inputs');
        if (request.mode === 'jev' && !process.env.TYPESAFE_API_KEY)
          throw new Error('Set TYPESAFE_API_KEY to use Jev. Manual mode must be selected explicitly.');
        if (request.mode === 'manual') parseFeatures(request.features);
        if (
          request.mode === 'jev' &&
          review.custom &&
          request.disclosure !== hash(JSON.stringify(disclosurePayload(review)))
        )
          throw new Error(
            'Confirm disclosure of this exact code payload to TypeSafe before reviewing. Changed content needs renewed acknowledgment.',
          );
        seed = parseSeed(request.seed);
      } else if (request.action === 'poke') {
        parsePokeStimuli(request.stimuli);
        seed = parseSeed(request.seed);
      } else if (request.action === 'add-bitter') {
        const sugar = this.state.poke;
        if (!sugar || Object.keys(sugar.stimuli).length !== 1 || !sugar.stimuli.sugar)
          throw new Error('Start with a sugar-only poke before adding bitter.');
        seed = sugar.brain.seed;
      } else if (request.action === 'reset-memory') {
        // validated below
      } else {
        if (!this.state.brain || !this.state.features) throw new Error('Run a review first.');
        if (request.action === 'verify' && this.state.review.oracle === null)
          throw new Error('Verification needs a written contract and an oracle. Pasted changes get a fly vote only.');
        if (request.action === 'verify' && !process.env.ANTHROPIC_API_KEY)
          throw new Error('Set ANTHROPIC_API_KEY for independent investigation.');
        if (
          request.action === 'verify' &&
          request.vote !== undefined &&
          !['yes', 'no', 'unsure'].includes(request.vote)
        )
          throw new Error('Invalid prediction');
        if (request.action === 'post-review' && (!this.state.review.pullRequest || !this.state.verdict))
          throw new Error('Only a pull request the fly has voted on can receive its review.');
        if (request.action === 'post-review' && this.state.posted)
          throw new Error('The fly already posted this review.');
      }
      if (
        request.action === 'reset-memory' &&
        !this.state.memory.lessons.length &&
        !this.state.memory.rememberedSynapses
      )
        throw new Error('The fly has nothing to forget.');
      try {
        if (request.action === 'review')
          await this.review(request.mode, review!, seed, {
            features: request.mode === 'manual' ? parseFeatures(request.features) : null,
            encoderModel: null,
            reuse: false,
            disclosure: request.disclosure,
          });
        else if (request.action === 'poke' || request.action === 'add-bitter') {
          // A poke is not a review. It stimulates one real sensory population and records what reaches the readouts, so
          // the three channels can be seen doing their actual jobs. The current review, if any, is left untouched.
          const sugar = request.action === 'add-bitter' ? this.state.poke! : null;
          const stimuli = parsePokeStimuli(
            request.action === 'poke' ? request.stimuli : { sugar: sugar!.stimuli.sugar, bitter: 150 },
          );
          await mkdir(this.dependencies.runsPath, { recursive: true });
          const pokeDir = await mkdtemp(join(this.dependencies.runsPath, 'poke-'));
          const memoryInput = await snapshotMemory(
            sugar ? await checkSnapshot(sugar.memoryInput) : this.dependencies.memoryPath,
            join(pokeDir, 'memory-before.json'),
            !sugar,
          );
          const described = Object.entries(stimuli)
            .map(([name, hz]) => `${POKE_PRESETS[name as PokePreset].label.toLowerCase()} at ${hz} Hz`)
            .join(', ');
          this.state.poking = true;
          await this.publish(`Poke: ${described}. Simulating.`);
          const brain = await this.dependencies.poke(stimuli, seed, 0.65, memoryInput.path);
          const recording = {
            at: new Date().toISOString(),
            stimuli,
            brain,
            channels: channelDiagnosis(brain),
            receiptId: basename(pokeDir),
            memoryInput,
          };
          await atomicJSON(join(pokeDir, 'poke.json'), recording);
          this.state.poke = recording;
          this.state.pokePair = sugar ? { sugar, mixed: recording } : null;
          if (sugar) await atomicJSON(join(pokeDir, 'comparison.json'), this.state.pokePair);
          this.state.poking = false;
          await this.publish(
            `Poke result: A ${brain.feedHz.toFixed(0)} Hz, B ${brain.groomHz.toFixed(0)} Hz, C ${brain.escapeHz.toFixed(0)} Hz.`,
            { stimuli, feedHz: brain.feedHz, groomHz: brain.groomHz, escapeHz: brain.escapeHz },
          );
        } else if (request.action === 'reset-memory') {
          await this.dependencies.forget();
          this.state.memory = emptyMemory();
          this.lessons = [];
          this.state.lesson = null;
          this.state.teaching = null;
          this.state.memoryComparison = null;
          this.state.recordingHistorical = Boolean(this.state.brain);
          this.state.headline = 'The fly has forgotten everything.';
          this.state.explanation =
            'Every KC → MBON synapse is back to its connectome strength. The wiring is untouched. The displayed vote is a historical recording; rerun the frozen inputs to measure the naive fly.';
          await this.publish(this.state.headline);
        } else if (request.action === 'compare-memory') {
          const dir = await mkdtemp(join(this.state.runDir!, 'comparison-'));
          const memoryInput = await snapshotMemory(
            this.dependencies.memoryPath,
            join(dir, 'memory-current.json'),
            true,
          );
          this.state.phase = 'simulating';
          await this.publish(
            'Same odor and seed. Comparing current memory with no memory, without teaching or forgetting.',
          );
          const current = await this.dependencies.smell(this.state.odor!, {
            seed: this.state.brain!.seed,
            memoryPath: memoryInput.path,
            lesson: 'none',
          });
          const naive = await this.dependencies.smell(this.state.odor!, {
            seed: this.state.brain!.seed,
            memoryPath: null,
            lesson: 'none',
          });
          await checkSnapshot(memoryInput);
          this.state.memoryComparison = { current, naive, memoryInput };
          await atomicJSON(join(dir, 'comparison.json'), {
            odor: this.state.odor,
            seed: this.state.brain!.seed,
            ...this.state.memoryComparison,
          });
          this.state.phase = this.state.verification ? 'verified' : 'ready';
          await this.publish(
            'Memory comparison saved. A difference reflects all current memory, not one selected lesson. The fly still remembers.',
          );
        } else if (request.action === 'recall') {
          // The causal check: same change, same frozen description, same seed, only the memory may differ.
          const { review: current, features, source, encoderModel, attention } = this.state;
          await this.review(source!, current, this.state.brain!.seed, {
            features: features!,
            encoderModel,
            reuse: true,
            recall: true,
            unitFeatures: attention?.units.map(u => u.features) ?? null,
          });
        } else if (request.action === 'second-opinion') {
          // Same change, same description, a different fly: a fresh seed and a fresh run. No new Jev call.
          const { review: current, features, source, encoderModel, attention } = this.state;
          let next = seed;
          do next = 1 + Math.floor(Math.random() * 9999);
          while (next === this.state.brain!.seed);
          await this.review(source!, current, next, {
            features: features!,
            encoderModel,
            reuse: true,
            unitFeatures: attention?.units.map(u => u.features) ?? null,
          });
        } else if (request.action === 'post-review') {
          const pr = this.state.review.pullRequest!;
          this.state.headline = 'Posting the fly’s review to GitHub.';
          this.state.explanation =
            'A comment-only review: the vote, the descriptive receptors, and the readout. GitHub does not let a fly block a merge.';
          await this.publish(this.state.headline);
          const body = reviewComment(pr, {
            features: this.state.features!,
            brain: this.state.brain!,
            verdict: this.state.verdict!,
            encoderModel: this.state.encoderModel,
            source: this.state.source!,
            attention: this.state.attention,
          });
          const { url } = await this.dependencies.postReview(pr, body);
          this.state.posted = { url, at: new Date().toISOString() };
          this.state.headline = 'The fly has left its review.';
          this.state.explanation = `Posted to ${pullRequestKey(pr.ref)} as a comment. The vote is on the record; the evidence stays on this machine.`;
          await writeFile(join(this.state.runDir!, 'github-review.md'), body, { mode: 0o600 });
          await this.publish(this.state.headline, this.state.posted);
        } else if (request.action === 'verify') {
          this.state.phase = 'investigating';
          this.state.verification = null;
          this.state.vote = request.vote ?? null;
          this.state.headline = 'Make the accusation earn its place.';
          this.state.explanation =
            'Claude receives the diff and caller context, not the contract and not the fly verdict. It bets on one input; the runner executes both versions and the deterministic sweep.';
          await this.publish(
            'Independent investigation started. The investigator was given neither the contract nor the fly verdict.',
          );
          const { probe, model } = await this.dependencies.investigate(this.state.review);
          await this.publish(
            'Investigator proposed a probe. Executing both versions and the case-specific deterministic sweep.',
            { probe, model },
          );
          this.state.verification = await executeProbe(this.state.review, probe, model);
          this.state.phase = 'verified';
          const r = this.state.verification;
          this.state.headline =
            r.status === 'confirmed'
              ? r.probeFoundRegression
                ? 'A regression was reproduced. The investigator found it blind.'
                : 'A regression was reproduced. The sweep found it; the investigator missed.'
              : r.status === 'unsubstantiated'
                ? 'The accusation did not earn its place.'
                : 'The evidence is inconclusive.';
          this.state.explanation = r.explanation;
          await writeFile(join(this.state.runDir!, 'regression.test.ts'), r.testCode, { mode: 0o600 });
          if (this.state.verdict)
            await this.record({
              type: 'verification',
              at: new Date().toISOString(),
              runDir: this.state.runDir,
              caseId: this.state.review.id,
              verdict: this.state.verdict.verdict,
              status: r.status,
            });
          await this.publish(this.state.headline, r);
          // Dopamine. The same odor is presented again with a taste on the proboscis: bitter after a real break, sugar
          // after a designated control held. Inside that run the fly's own dopamine neurons fire and the synapses of the
          // Kenyon cells carrying the odor are depressed where the connectome delivers that dopamine. Unknown outcomes
          // teach nothing.
          const taught = lessonFor(r.status, Boolean(this.state.review.control));
          if (taught.lesson === 'none') {
            await this.publish(`No lesson. ${taught.reason}`);
          } else {
            await this.publish(
              `${taught.lesson === 'punish' ? 'Bitter with the smell (punishment)' : 'Sugar with the smell (reward)'}. ${taught.reason}`,
            );
            const lessonDir = await mkdtemp(join(this.state.runDir!, 'lesson-'));
            const before = await snapshotMemory(
              this.dependencies.memoryPath,
              join(lessonDir, 'memory-before.json'),
              true,
            );
            let after = await snapshotMemory(before.path, join(lessonDir, 'memory-after.json'));
            const learned = await this.dependencies.smell(this.state.odor!, {
              seed: this.state.brain!.seed,
              lesson: taught.lesson,
              memoryPath: after.path,
            });
            after = await snapshotMemory(after.path, after.path);
            const entry: LessonEntry = {
              at: new Date().toISOString(),
              runDir: this.state.runDir,
              caseId: this.state.review.id,
              title: this.state.review.title,
              lesson: taught.lesson,
              reason: taught.reason,
              activeKenyon: learned.activeKenyon,
              depressed: learned.depressed,
              rememberedSynapses: learned.rememberedSynapses,
              beforeHash: before.hash,
              afterHash: after.hash,
              source: 'verification',
              kenyonIds: learned.activeKenyonIds,
              teaching: summarizeTeaching(learned),
            };
            const receipt = {
              before,
              after,
              entry,
              verification: r,
              odor: this.state.odor,
              seed: this.state.brain!.seed,
            };
            await atomicJSON(join(lessonDir, 'lesson.json'), { ...receipt, status: 'prepared' });
            try {
              await this.dependencies.rememberLesson(entry, after, before);
              await atomicJSON(join(lessonDir, 'lesson.json'), { ...receipt, status: 'committed' });
            } catch (error) {
              throw new Error(
                `Teaching was interrupted. Inspect the prepared receipt at ${join(lessonDir, 'lesson.json')} and the live memory hash before retrying. ${String(error)}`,
              );
            }
            this.state.lesson = entry;
            this.state.teaching = learned;
            this.state.memoryComparison = null;
            this.state.memory = { ...(await this.refreshLessons()), rememberedSynapses: learned.rememberedSynapses };
            await this.publish(
              `${describeTeaching(taught.lesson, entry.teaching, learned.depressed, learned.activeKenyon)} ${learned.rememberedSynapses.toLocaleString()} synapses now carry memory.`,
              entry,
            );
          }
        } else {
          const disconnected = request.action === 'disconnect';
          this.state.phase = disconnected ? 'ablating' : 'simulating';
          this.state.headline = disconnected
            ? 'Same inputs. Same seed. No synaptic transmission.'
            : 'Repeat the experiment, not the animation.';
          this.state.explanation = disconnected
            ? 'Same saved odor, seed, and input memory. We are measuring whether activity still reaches the mushroom-body voting readout.'
            : 'This runs the simulator again with the exact saved odor, seed, and input-memory snapshot. Compute time may differ; spike data should not.';
          await this.publish(this.state.headline);
          if (!this.state.memoryInput)
            throw new Error('This recording has no saved input memory; it cannot be replayed exactly.');
          const reading = await this.dependencies.smell(this.state.odor!, {
            seed: this.state.brain!.seed,
            gain: disconnected ? 0 : 0.65,
            memoryPath: await checkSnapshot(this.state.memoryInput),
          });
          if (disconnected) {
            this.state.ablation = reading;
            const before = this.state.brain!.avoidHz + this.state.brain!.approachHz;
            const after = reading.avoidHz + reading.approachHz;
            this.state.headline =
              before > 0 && after === 0
                ? 'The mushroom-body voting readout became silent.'
                : 'Ablation measured. Inspect the voting readout.';
            const inputSpikes = reading.frames.reduce(
              (sum, frame) => sum + frame.inputSpikes.reduce((a, b) => a + b, 0),
              0,
            );
            this.state.explanation = `Same odor, seed, and saved memory. MBON activity: ${before.toFixed(1)} → ${after.toFixed(1)} Hz; ablated vote: ${reviewVerdict(reading).verdict}. ${inputSpikes} recorded input spikes. Motor readouts are separate. ${before > 0 && after === 0 ? 'This supports network participation, not code understanding.' : 'A silent baseline or surviving voting output does not establish that the vote disappeared.'}`;
          } else {
            const strip = ({ wallMs: _wallMs, ...value }: typeof reading) => value;
            this.state.repeat = {
              identical: JSON.stringify(strip(reading)) === JSON.stringify(strip(this.state.brain!)),
              reading,
            };
            this.state.headline = this.state.repeat.identical
              ? 'Same inputs. Same spikes. Same verdict.'
              : 'The replay did not reproduce the recorded activity.';
            this.state.explanation = this.state.repeat.identical
              ? 'A new neural run reproduced the measured rates, time bins, and sampled activity. Only compute time was excluded from the comparison.'
              : 'The discrepancy is recorded. Do not treat this trial as reproducible.';
          }
          this.state.phase = this.state.verification ? 'verified' : 'ready';
          await this.publish(this.state.headline, { reading, identical: this.state.repeat?.identical });
        }
      } catch (error) {
        this.state.poking = false;
        this.state.phase = 'error';
        this.state.headline = 'Stopped. No invented model output.';
        this.state.explanation = String(error);
        await this.publish(this.state.explanation);
        throw error;
      } finally {
        try {
          if (this.state.runDir)
            await this.dependencies.persist(join(this.state.runDir, 'review.json'), { ...this.state, busy: false });
        } catch (error) {
          this.state.phase = 'error';
          this.state.headline = 'Evidence could not be saved.';
          this.state.explanation = `The recording is not a durable receipt. ${String(error)}`;
          throw error;
        }
      }
    } finally {
      this.operating = false;
      this.state.busy = false;
      this.notify(this.state);
    }
  }

  private async review(
    mode: 'jev' | 'manual',
    review: ReviewCase,
    seed: number,
    input: {
      features: Features | null;
      encoderModel: string | null;
      reuse: boolean;
      recall?: boolean;
      disclosure?: string;
      /** A pull request's saved per-hunk descriptions, so a second opinion or a recall makes no new Jev call. */
      unitFeatures?: Features[] | null;
    },
  ) {
    const reuse = input.reuse,
      recall = Boolean(input.recall);
    await mkdir(this.dependencies.runsPath, { recursive: true });
    const runDir = await mkdtemp(join(this.dependencies.runsPath, 'review-'));
    const { hasGitHub, poke, pokePair, memory, history, recordingHistorical, lesson } = this.state;
    this.state = {
      ...new ReviewShow().state,
      ledger: this.state.ledger,
      hasGitHub,
      poke,
      pokePair,
      memory,
      history: recall ? [...history] : [],
      review,
      runDir,
      source: mode,
      phase: 'encoding',
      busy: true,
    };
    if (input.disclosure)
      await atomicJSON(join(runDir, 'disclosure.json'), {
        provider: 'TypeSafe (api.typesafe.ai)',
        hash: input.disclosure,
        at: new Date().toISOString(),
      });
    if (review.pullRequest) {
      // File names inside a pull request are untrusted paths; the evidence bundle keeps the whole PR in two fixed files.
      await atomicJSON(join(runDir, 'pull-request.json'), review.pullRequest);
      await writeFile(
        join(runDir, 'pull-request.diff'),
        review.pullRequest.files
          .map(f => `diff --git a/${f.filename} b/${f.filename}\n${f.patch ?? `(patch omitted: ${f.omitted})`}`)
          .join('\n\n'),
        { mode: 0o600 },
      );
    } else {
      await writeFile(join(runDir, 'before.ts'), review.before, { mode: 0o600 });
      await writeFile(join(runDir, 'after.ts'), review.after, { mode: 0o600 });
      await writeFile(join(runDir, review.filename), review.after, { mode: 0o600 });
    }
    this.state.headline = recall
      ? `${flyName(seed)} smells the same change again.`
      : reuse
        ? `Second opinion: ${flyName(seed)}.`
        : mode === 'jev'
          ? 'Jev is describing the change. Not reviewing it.'
          : 'Human-set descriptors. No Jev call.';
    this.state.explanation = recall
      ? 'Same description, same seed, same odor. Only the memory may have changed since the last time.'
      : reuse
        ? 'Same description, different fly. A new seed changes the noise, not the wiring or the memory.'
        : mode === 'jev'
          ? 'Thirty descriptive questions about what changed. None asks whether it is buggy or should be approved.'
          : 'These descriptors came from the sliders, not a model or the code.';
    await this.publish(this.state.headline, {
      review: review.pullRequest ? { ...review, pullRequest: pullRequestKey(review.pullRequest.ref) } : review,
    });
    // A pull request is read hunk by hunk; a single change is one puff. Either way the memory file is read fresh first
    // (npm run memory:install may have replaced it), so the lessons shown match the factors the bridge is about to use.
    const plan = review.pullRequest && mode === 'jev' ? reviewUnits(review.pullRequest) : null;
    let unitFeatures: Features[] | null = null;
    let tallyVerdict: FlyVerdict | null = null;
    if (plan) {
      if (reuse) {
        if (!input.unitFeatures || input.unitFeatures.length !== plan.units.length)
          throw new Error('The saved per-hunk descriptions do not match this pull request');
        unitFeatures = input.unitFeatures;
        this.state.encoderModel = input.encoderModel;
        await this.publish(`Reusing the saved Jev descriptions of ${plan.units.length} hunks.`);
      } else {
        this.state.headline = `Jev is describing ${plan.units.length} ${plan.granularity}s. Not reviewing them.`;
        this.state.explanation = `Each ${plan.granularity} is described on its own, with the pull request's title and description as context. ${plan.skipped ? `${plan.skipped} smaller files were not smelled. ` : ''}Thirty descriptive questions per ${plan.granularity}; none asks whether it should be approved.`;
        await this.publish(this.state.headline, { units: plan.units.map(({ patch: _p, changed: _c, ...u }) => u) });
        unitFeatures = [];
        for (let i = 0; i < plan.units.length; i += 4) {
          const batch = await Promise.all(
            plan.units.slice(i, i + 4).map(unit => this.dependencies.encodeUnit(review.pullRequest!, unit)),
          );
          unitFeatures.push(...batch.map(b => b.features));
          this.state.encoderModel = batch[0]?.model ?? this.state.encoderModel;
          await this.publish(
            `Described ${Math.min(i + 4, plan.units.length)} of ${plan.units.length} ${plan.granularity}s.`,
          );
        }
      }
    } else if (reuse) {
      this.state.features = input.features;
      this.state.encoderModel = input.encoderModel;
      await this.publish(`Reusing the saved ${mode === 'jev' ? 'Jev description' : 'manual inputs'}.`, input.features);
    } else if (mode === 'jev') {
      const result = await this.dependencies.encode(review);
      this.state.features = result.features;
      this.state.encoderModel = result.model;
      await this.publish('Received live Jev descriptor probabilities.', result);
    } else {
      this.state.features = parseFeatures(input.features);
      await this.publish(
        'Operator supplied manual descriptor probabilities. No automatic code interpretation occurred.',
        this.state.features,
      );
    }
    this.state.memory = await this.refreshLessons();
    this.state.memoryInput = await snapshotMemory(
      this.dependencies.memoryPath,
      join(runDir, 'memory-before.json'),
      true,
    );
    if (plan && unitFeatures) {
      const odors = plan.units.map((unit, i) => odorize(unitFeatures![i], unit.changed));
      this.state.phase = 'simulating';
      this.state.headline = `${flyName(seed)} reads the diff, then reads it again.`;
      this.state.explanation = `${odors.length} puffs of odor in order. Each puff makes its smell a little more familiar; on the second reading the synapses are frozen and whatever still smells new is where the fly looks. The valence memory (${this.state.memory.rememberedSynapses.toLocaleString()} remembered synapses) answers every puff too.`;
      await this.publish(this.state.headline);
      this.state.brain = await this.dependencies.smellSequence(odors, {
        seed,
        memoryPath: this.state.memoryInput.path,
      });
      const sequence = this.state.brain.sequence!;
      // Every hunk gets the same vote a single change would, from its own readout on the frozen pass.
      const hunkVotes = sequence.hunks.map(h =>
        reviewVerdict({ avoidHz: h.avoidHz, approachHz: h.approachHz, feedHz: h.feedHz ?? 0 }),
      );
      const { majority, ...tally } = tallyVotes(hunkVotes);
      const stood = standsOut(sequence.hunks, sequence.looked);
      this.state.attention = {
        granularity: plan.granularity,
        skipped: plan.skipped,
        familiarity: sequence.familiarity,
        readings: sequence.readings,
        looked: sequence.looked,
        stands: stood.stands,
        tally,
        units: plan.units.map(({ patch: _p, changed: _c, ...unit }, i) => ({
          ...unit,
          reading: sequence.hunks[i],
          share:
            sequence.hunks[i].avoidHz + sequence.hunks[i].approachHz > 0
              ? sequence.hunks[i].avoidHz / (sequence.hunks[i].avoidHz + sequence.hunks[i].approachHz)
              : 0.5,
          vote: hunkVotes[i].verdict,
          reached: hunkVotes[i].behavior === 'reached',
          features: unitFeatures![i],
        })),
      };
      // When one hunk stands out, the vote is that hunk's. When none does, voting on the loudest would be arbitrary,
      // so the vote is the count across every hunk it read.
      tallyVerdict = stood.stands
        ? null
        : {
            verdict: majority,
            score: tally.total
              ? sequence.hunks.reduce(
                  (sum, h) => sum + (h.avoidHz + h.approachHz > 0 ? h.avoidHz / (h.avoidHz + h.approachHz) : 0.5),
                  0,
                ) / tally.total
              : 0.5,
            behavior: tally.reached * 2 > tally.total ? 'reached' : 'still',
            explanation: `No ${plan.granularity} stood out, so this is the count over all ${tally.total}: changes requested on ${tally.changes_requested}, no objection on ${tally.no_objection}, abstained on ${tally.abstain}${tally.reached ? `, reached for ${tally.reached}` : ''}. ${majority === 'changes_requested' ? 'A majority smelled like something it tasted bitter with.' : majority === 'no_objection' ? 'A majority smelled like something that came with sugar. That does not establish that the code is correct.' : 'No majority either way.'}`,
          };
      // The vote, the signal rail, and the nearest lessons all describe the hunk the fly looked at.
      this.state.features = unitFeatures[sequence.looked];
      this.state.odor = odors[sequence.looked];
      await atomicJSON(join(runDir, 'attention.json'), this.state.attention);
    } else {
      this.state.odor = odorize(this.state.features!, changedText(review));
      this.state.phase = 'simulating';
      this.state.headline = 'The description becomes an odor.';
      this.state.explanation = `${Object.keys(this.state.odor).length} of 53 glomeruli are driven: descriptors above 25% on their receptors, plus the hashed tokens of the changed lines. The mushroom body runs with ${this.state.memory.rememberedSynapses.toLocaleString()} remembered synapses.`;
      await this.publish(this.state.headline, this.state.odor);
      this.state.brain = await this.dependencies.smell(this.state.odor, {
        seed,
        memoryPath: this.state.memoryInput.path,
      });
    }
    this.state.verdict = tallyVerdict ?? reviewVerdict(this.state.brain);
    this.state.nearest = this.nearestLessons(this.state.brain);
    this.state.history.push({
      runId: basename(runDir),
      seed,
      memoryHash: this.state.memoryInput.hash,
      descriptorHash: hash(JSON.stringify(this.state.features)),
      verdict: this.state.verdict,
      label: recall
        ? recordingHistorical
          ? 'After forgetting (measured)'
          : lesson
            ? 'After teaching (measured)'
            : 'Same smell, current memory'
        : this.state.memoryInput.rememberedSynapses
          ? 'Initial vote (existing memory)'
          : 'Initial vote (naive memory)',
    });
    this.state.channels = channelDiagnosis(this.state.brain);
    this.state.phase = 'ready';
    const looked = this.state.attention?.units[this.state.attention.looked];
    const stood = this.state.attention
      ? standsOut(
          this.state.attention.units.map(u => u.reading),
          this.state.attention.looked,
        )
      : null;
    this.state.headline = looked
      ? stood!.stands
        ? `${flyName(seed)} looked at ${looked.filename}${looked.hunk === null ? '' : `, hunk ${looked.hunk + 1}`}.`
        : `${flyName(seed)}: nothing stood out in ${this.state.attention!.units.length} ${this.state.attention!.granularity}s.`
      : this.state.verdict.verdict === 'changes_requested'
        ? `${flyName(seed)}: changes requested, ${changedRange(review)}.`
        : this.state.verdict.verdict === 'no_objection'
          ? this.state.verdict.behavior === 'reached'
            ? `${flyName(seed)} reached for it. That is not a safety certificate.`
            : `${flyName(seed)}: no objection. That is not a safety certificate.`
          : `${flyName(seed)} abstained.`;
    this.state.explanation = looked
      ? stood!.stands
        ? `${stood!.why} (novelty ${looked.reading.noveltyHz.toFixed(0)} Hz against ${looked.reading.naiveNoveltyHz.toFixed(0)} Hz on first exposure). Its valence vote on that ${this.state.attention!.granularity}: ${this.state.verdict.explanation}`
        : `Novelty finds the one thing unlike the rest only when the rest are alike, and here ${stood!.why}. The loudest was ${looked.filename}${looked.hunk === null ? '' : `, hunk ${looked.hunk + 1}`}, at ${looked.reading.noveltyHz.toFixed(0)} of ${looked.reading.naiveNoveltyHz.toFixed(0)} Hz. ${this.state.verdict.explanation}`
      : this.state.verdict.explanation;
    const { feedHz, groomHz, escapeHz } = this.state.brain;
    await this.record({
      type: 'vote',
      at: new Date().toISOString(),
      runDir,
      caseId: review.id,
      custom: Boolean(review.custom),
      feedHz,
      groomHz,
      escapeHz,
      verdict: this.state.verdict.verdict,
    });
    await this.publish(this.state.headline, {
      brain: this.state.brain,
      verdict: this.state.verdict,
      channels: this.state.channels,
    });
  }
}
