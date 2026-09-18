import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON, ROOT } from './io.ts';
import { REVIEW_CASES, DEFAULT_REVIEW_CASE, changedRange } from './review-cases.ts';
import { parseFeatures, reviewBrain, reviewVerdict } from './review-brain.ts';
import { encodeWithJev } from './review-jev.ts';
import { executeProbe, proposeProbe } from './review-verify.ts';
import type { ReviewState } from './review-types.ts';

export type ReviewAction = { action: 'review'; caseId: string; mode: 'jev' | 'manual'; features?: unknown }
  | { action: 'disconnect' | 'repeat' }
  | { action: 'verify'; vote?: 'yes' | 'no' | 'unsure' };

export class ReviewShow {
  state: ReviewState;
  busy = false;
  private notify: (state: ReviewState) => void;
  private dependencies: { encode: typeof encodeWithJev; simulate: typeof reviewBrain; investigate: typeof proposeProbe };
  constructor(notify: (state: ReviewState) => void = () => {}, dependencies = { encode: encodeWithJev, simulate: reviewBrain, investigate: proposeProbe }) {
    this.notify = notify;
    this.dependencies = dependencies;
    this.state = {
      phase: 'idle', busy: false, review: DEFAULT_REVIEW_CASE,
      headline: 'Your least qualified reviewer has arrived.',
      explanation: 'A real diff. Four descriptive signals. A simulated fly brain. Then an executable attempt to prove the verdict.',
      source: null, features: null, encoderModel: null, brain: null, verdict: null,
      ablation: null, repeat: null, verification: null, vote: null,
      hasJev: Boolean(process.env.TYPESAFE_API_KEY), hasInvestigator: Boolean(process.env.ANTHROPIC_API_KEY), runDir: null, log: [],
    };
  }

  private async publish(text?: string, data?: unknown) {
    this.state.busy = this.busy;
    if (text) {
      this.state.log.unshift({ at: new Date().toISOString(), text });
      this.state.log = this.state.log.slice(0, 16);
      if (this.state.runDir) await appendFile(join(this.state.runDir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), text, data }) + '\n', { mode: 0o600 });
    }
    this.notify(this.state);
  }

  async act(request: ReviewAction): Promise<void> {
    if (this.busy) throw new Error('Wait for the current review operation to finish.');
    // Validate before mutating the current run, including explicit mode and credentials.
    if (request.action === 'review') {
      if (!REVIEW_CASES.some(c => c.id === request.caseId)) throw new Error('Unknown review example');
      if (!['jev', 'manual'].includes(request.mode)) throw new Error('Select live Jev or explicit manual inputs');
      if (request.mode === 'jev' && !process.env.TYPESAFE_API_KEY) throw new Error('Set TYPESAFE_API_KEY to use Jev. Manual mode must be selected explicitly.');
      if (request.mode === 'manual') parseFeatures(request.features);
    } else {
      if (!this.state.brain || !this.state.features) throw new Error('Run a review first.');
      if (request.action === 'verify' && !process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY for independent investigation.');
      if (request.action === 'verify' && request.vote && !['yes', 'no', 'unsure'].includes(request.vote)) throw new Error('Invalid prediction');
    }
    this.busy = true;
    try {
      if (request.action === 'review') await this.review(request);
      else if (request.action === 'verify') {
        this.state.phase = 'investigating';
        this.state.verification = null;
        this.state.vote = request.vote ?? null;
        this.state.headline = 'Make the accusation earn its place.';
        this.state.explanation = 'Claude receives the diff and contract, NOT the fly verdict. It proposes an input; an independent runner checks original and changed code.';
        await this.publish('Independent investigation started. The investigator was not given the fly verdict.');
        const { probe, model } = await this.dependencies.investigate(this.state.review);
        await this.publish('Investigator proposed a probe. Executing both versions and the case-specific deterministic sweep.', { probe, model });
        this.state.verification = await executeProbe(this.state.review, probe, model);
        this.state.phase = 'verified';
        this.state.headline = this.state.verification.status === 'confirmed' ? 'A regression was reproduced.' : this.state.verification.status === 'unsubstantiated' ? 'The accusation did not earn its place.' : 'The evidence is inconclusive.';
        this.state.explanation = this.state.verification.explanation;
        await writeFile(join(this.state.runDir!, 'regression.test.ts'), this.state.verification.testCode, { mode: 0o600 });
        await this.publish(this.state.headline, this.state.verification);
      } else {
        const disconnected = request.action === 'disconnect';
        this.state.phase = disconnected ? 'ablating' : 'simulating';
        this.state.headline = disconnected ? 'Same inputs. Same seed. No synaptic transmission.' : 'Repeat the experiment, not the animation.';
        this.state.explanation = disconnected ? 'The driven neurons can still spike. We are measuring whether activity still reaches the downstream readouts.' : 'This runs the simulator again with the exact saved feature values and seed. Compute time may differ; spike data should not.';
        await this.publish(this.state.headline);
        const reading = await this.dependencies.simulate(this.state.features!, this.state.brain!.seed, disconnected ? 0 : .65);
        if (disconnected) {
          this.state.ablation = reading;
          const before = this.state.brain!.feedHz + this.state.brain!.groomHz + this.state.brain!.escapeHz;
          const after = reading.feedHz + reading.groomHz + reading.escapeHz;
          this.state.headline = before > 0 && after === 0 ? 'The inputs fired. The verdict disappeared.' : 'Ablation measured. Inspect the difference.';
          this.state.explanation = before > 0 && after === 0 ? 'With the same input rates and seed, disabling synaptic transmission removed all three downstream readouts. This shows network participation, not code understanding.' : 'Do not assume the ablation proves a contribution: a silent original trial or surviving output needs a different explanation.';
        } else {
          const strip = ({ wallMs: _wallMs, ...value }: typeof reading) => value;
          this.state.repeat = { identical: JSON.stringify(strip(reading)) === JSON.stringify(strip(this.state.brain!)), reading };
          this.state.headline = this.state.repeat.identical ? 'Same inputs. Same spikes. Same verdict.' : 'The replay did not reproduce the recorded activity.';
          this.state.explanation = this.state.repeat.identical ? 'A new neural run reproduced the measured rates, time bins, and sampled activity. Only compute time was excluded from the comparison.' : 'The discrepancy is recorded. Do not treat this trial as reproducible.';
        }
        this.state.phase = this.state.verification ? 'verified' : 'ready';
        await this.publish(this.state.headline, { reading, identical: this.state.repeat?.identical });
      }
    } catch (error) {
      this.state.phase = 'error'; this.state.headline = 'Stopped. No invented model output.'; this.state.explanation = String(error);
      await this.publish(this.state.explanation);
      throw error;
    } finally {
      this.busy = false; this.state.busy = false;
      if (this.state.runDir) await atomicJSON(join(this.state.runDir, 'review.json'), this.state);
      await this.publish();
    }
  }

  private async review(request: Extract<ReviewAction, { action: 'review' }>) {
    const review = REVIEW_CASES.find(c => c.id === request.caseId)!;
    await mkdir(join(ROOT, '.runs'), { recursive: true });
    const runDir = await mkdtemp(join(ROOT, '.runs/review-'));
    this.state = { ...new ReviewShow().state, review, runDir, source: request.mode, phase: 'encoding', busy: true };
    await writeFile(join(runDir, 'before.ts'), review.before, { mode: 0o600 });
    await writeFile(join(runDir, 'after.ts'), review.after, { mode: 0o600 });
    await writeFile(join(runDir, review.filename), review.after, { mode: 0o600 });
    this.state.headline = request.mode === 'jev' ? 'Jev is describing the change. Not reviewing it.' : 'Human-set inputs. No Jev call.';
    this.state.explanation = request.mode === 'jev' ? 'Four independent probability questions describe the code. None asks whether it is buggy or should be approved.' : 'These probabilities came from the sliders, not a model or the code. Equal manual inputs produce equal neural responses across different diffs.';
    await this.publish(this.state.headline, { review });
    if (request.mode === 'jev') {
      const result = await this.dependencies.encode(review);
      this.state.features = result.features; this.state.encoderModel = result.model;
      await this.publish('Received live Jev feature probabilities.', result);
    } else {
      this.state.features = parseFeatures(request.features);
      await this.publish('Operator supplied manual feature probabilities. No automatic code interpretation occurred.', this.state.features);
    }
    this.state.phase = 'simulating'; this.state.headline = 'The code description becomes neural stimulation.';
    this.state.explanation = 'Each probability controls a fixed mixed population of input neurons at 0–180 Hz. Running real connectivity with simplified neuron equations.';
    await this.publish(this.state.headline);
    this.state.brain = await this.dependencies.simulate(this.state.features, 7, .65);
    this.state.verdict = reviewVerdict(this.state.brain);
    this.state.phase = 'ready';
    this.state.headline = this.state.verdict.verdict === 'changes_requested' ? `Changes requested: ${changedRange(review)}.` : this.state.verdict.verdict === 'no_objection' ? 'No objection from the fly. That is not a safety certificate.' : 'The fly abstained.';
    this.state.explanation = this.state.verdict.explanation;
    await this.publish(this.state.headline, { brain: this.state.brain, verdict: this.state.verdict });
  }
}
