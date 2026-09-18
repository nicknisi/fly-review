import { REVIEW_CASES, DEFAULT_REVIEW_CASE, FEATURE_LABELS, FEATURE_QUESTIONS, diffLines, changedRange, formatReviewInput, formatReviewValue } from '../src/review-cases.js';
import type { FeatureKey, Features, ReviewBrain, BrainAnatomy } from '../src/review-brain.js';
import type { ReviewState } from '../src/review-types.js';
import { BrainView } from './brain-view.js';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const text = (id: string, value: string) => { if (el(id).textContent !== value) el(id).textContent = value; };
const keys = Object.keys(FEATURE_LABELS) as FeatureKey[];
const shortLabels = ['Outside input', 'Stored data', 'Timing', 'Visible behavior'];
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const view = new BrainView(el<HTMLCanvasElement>('neural'), label => {
  text('renderer', label);
  text('interaction-hint', label.startsWith('WebGL ·') ? 'Drag / arrow keys to rotate · +/− zoom' : 'Same measured data · flat projection');
  requestAnimationFrame(updateRotation);
});
view.rotating = !reduce.matches;
let state: ReviewState | null = null;
let mode: 'jev' | 'manual' | null = null;
let selected = DEFAULT_REVIEW_CASE.id, connected = false;
let boundRun: string | null = null, previousRun: string | null = null, knownRun: string | null = null;
let awaitingRun = false, pendingVerification = false, presenting = false;
let knownAblation: ReviewBrain | null = null;
let recording: ReviewBrain | null = null;
let playbackKind: 'original' | 'disconnected' = 'original';
let playing = false, revealed = false, elapsed = 0, lastAnimation = 0, frameIndex = 0;
let sounding = false, audio: AudioContext | null = null;
let uiStamp = '';
const emptyActivity: [number, number, number, number][] = [];
const manual: Features = { externalInput: .5, persistentData: .5, timing: .5, visibleBehavior: .5 };
const active = () => state?.review.id === selected && state.runDir === boundRun ? state : null;
for (const groupName of ['AI agent disasters','Time and data','Control experiment','Checkout classics']) {
  const group = document.createElement('optgroup'); group.label = groupName;
  for (const review of REVIEW_CASES.filter(review=>review.group===groupName)) {
    const option = document.createElement('option'); option.value = review.id; option.textContent = review.title;
    group.append(option);
  }
  el<HTMLSelectElement>('example').append(group);
}
el<HTMLSelectElement>('example').value=selected;
for (const [index, key] of keys.entries()) {
  const row = document.createElement('div'); row.className = 'feature';
  const label = document.createElement('label'); label.htmlFor = `input-${key}`; label.textContent = FEATURE_LABELS[key];
  const value = document.createElement('output'); value.className = 'reading'; value.id = `value-${key}`;
  const input = document.createElement('input'); input.type = 'range'; input.id = `input-${key}`; input.min = '0'; input.max = '100'; input.value = '50'; input.disabled = true;
  const rate = document.createElement('span'); rate.className = 'encoded-rate'; rate.id = `rate-${key}`;
  input.addEventListener('input', () => { manual[key] = Number(input.value) / 100; renderFeatures(); });
  row.append(label, value, input, rate); el('features').append(row);
  const question = document.createElement('li'); question.textContent = FEATURE_QUESTIONS[key]; el('questions').append(question);
  const card = document.createElement('div'); card.className = 'signal-card'; card.id = `signal-${key}`;
  const name = document.createElement('span'); name.textContent = shortLabels[index];
  const descriptor = document.createElement('b'); descriptor.id = `descriptor-${key}`; card.append(name, descriptor); el('signal-cards').append(card);
}
function renderDiff() {
  const review = REVIEW_CASES.find(c => c.id === selected)!;
  text('filename',review.filename); text('contract',review.contract);
  text('hunk-range', changedRange(review)); text('caller-context', review.context);
  el('diff').replaceChildren(...diffLines(review.before, review.after).map(line => {
    const row = document.createElement('span'); row.className = `diff-line ${line.kind}`;
    const gutter = document.createElement('span'); gutter.className = 'gutter';
    gutter.textContent = `${line.afterLine ?? line.beforeLine ?? ''} ${line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}`;
    row.append(gutter, document.createTextNode(line.text)); return row;
  }));
}
function renderFeatures() {
  const s = active();
  for (const [index, key] of keys.entries()) {
    const value = mode === 'manual' ? manual[key] : s?.features?.[key];
    const input = el<HTMLInputElement>(`input-${key}`); input.disabled = mode !== 'manual' || Boolean(state?.busy);
    if (mode === 'jev') input.value = String((value ?? 0) * 100);
    text(`value-${key}`, value === undefined ? 'Awaiting Jev' : `${Math.round(value * 100)}%`);
    const saved = s?.features?.[key];
    text(`rate-${key}`, value === undefined ? 'No input yet' : `${(value * 180).toFixed(0)} Hz → group ${index + 1}${s?.brain ? ` (${s.brain.groups[index]} neurons)` : ''}${saved !== undefined && mode === 'manual' && Math.abs(saved - value) > .0001 ? `; last trial ${(saved * 180).toFixed(0)} Hz` : ''}`);
    if (saved !== undefined) {
      const descriptor = saved >= .65 ? 'Likely' : saved <= .35 ? 'Unlikely' : 'Unclear';
      text(`descriptor-${key}`, descriptor); el(`signal-${key}`).classList.toggle('likely', saved >= .65);
      el(`signal-${key}`).title = `${FEATURE_LABELS[key]}: ${Math.round(saved * 100)}%. A property probability, not a bug probability.`;
    }
  }
  el('signal-cards').hidden = !s?.features;
  const displayedSource=s?.source??mode;
  text('describe-title', displayedSource === 'manual' ? 'You supply signals.' : 'Jev describes.');
  text('input-story', displayedSource === 'manual' ? 'These are human-set signals. No model interprets this code in manual mode.' : s?.features ? 'Jev described these properties, not code quality. The brain gets signals, not source code.' : 'Jev will turn four properties of this change into input signals. The fly never reads the source code.');
  text('mode-explanation', mode === 'manual' ? 'Explicit human-set inputs. Sliders configure the next trial; stored recordings keep their original values.' : mode === 'jev' ? 'Four live Noul questions. None asks whether to approve or reject.' : 'Live Jev is unavailable. Select manual inputs explicitly to continue without it.');
  el<HTMLButtonElement>('review').disabled = !mode || !connected || Boolean(state?.busy) || (mode === 'jev' && !state?.hasJev);
  text('review', state?.busy ? 'Experiment running…' : mode === 'manual' ? 'Send manual inputs ↗' : 'Ask the fly ↗');
  text('billing', mode === 'manual' ? 'Manual inputs. No Jev call. Real neural simulation.' : 'One live Jev call. Neural simulation runs locally.');
}

function play(brain: ReviewBrain, kind: 'original' | 'disconnected') {
  recording = brain; playbackKind = kind; elapsed = 0; frameIndex = 0; playing = !reduce.matches;
  if (kind === 'original') revealed = reduce.matches;
  if (reduce.matches) { elapsed = 6000; frameIndex = 9; }
  if (brain.geometry3d?.length && brain.links3d) view.setAnatomy({ neurons: brain.neurons, connections: brain.connections, geometry3d: brain.geometry3d, links3d: brain.links3d });
  el<HTMLButtonElement>('pause').disabled = false; el<HTMLInputElement>('scrub').disabled = false;
  uiStamp = ''; updateStory();
  if(reduce.matches)presentVote();
}
function presentVote(){
  if(!presenting||playbackKind!=='original')return;
  presenting=false;
  if(matchMedia('(max-width: 780px)').matches&&!el<HTMLDetailsElement>('inspect').open)el('verdict').scrollIntoView({behavior:reduce.matches?'instant':'smooth',block:'nearest'});
}
function beep() {
  if (!sounding) return;
  audio ??= new AudioContext(); void audio.resume();
  [392,330,262].forEach((frequency,i) => { const oscillator=audio!.createOscillator(), gain=audio!.createGain(), at=audio!.currentTime+i*.09; oscillator.type='triangle'; oscillator.frequency.value=frequency; gain.gain.setValueAtTime(.035,at); gain.gain.exponentialRampToValueAtTime(.001,at+.14); oscillator.connect(gain); gain.connect(audio!.destination); oscillator.start(at); oscillator.stop(at+.15); });
}

function updateStory() {
  const s = active(), hasVote = Boolean(s?.brain && revealed), busy = Boolean(state?.busy);
  el('verdict').hidden = !hasVote;
  for (const id of ['disconnect','repeat']) el<HTMLButtonElement>(id).disabled = !hasVote || busy || !connected;
  el<HTMLButtonElement>('verify').disabled = !hasVote || busy || !s?.hasInvestigator || !connected;
  el<HTMLButtonElement>('replay').disabled = !s?.brain || busy;
  el('play-original').hidden = playbackKind !== 'disconnected';
  el<HTMLButtonElement>('play-original').disabled = busy;
  text('pause', playing ? 'Pause' : 'Play');
  const inspectingAblation = playbackKind === 'disconnected' && Boolean(recording);
  let step = 1;
  if (s?.phase === 'simulating' || s?.brain) step = 2;
  if (hasVote && (s?.phase === 'investigating' || s?.verification)) step = 3;
  for (const li of document.querySelectorAll<HTMLElement>('[data-step]')) { const n=Number(li.dataset.step); li.classList.toggle('active',n===step); li.classList.toggle('done',n<step); if(n===step)li.setAttribute('aria-current','step');else li.removeAttribute('aria-current'); }
  document.querySelectorAll<HTMLElement>('#signal-rail i').forEach((rail,index)=>{
    const probability=s?.features?.[keys[index]]??0;
    rail.classList.toggle('off',probability===0);
    rail.dataset.strength=probability>=.65?'high':probability<=.35?'low':'medium';
  });
  el('signal-rail').classList.toggle('on', !reduce.matches && Boolean(s?.features&&Object.values(s.features).some(p=>p>0)) && (s?.phase === 'simulating' || (playing && elapsed < 1200)));
  if (!s?.brain) {
    text('scene-label', s?.phase === 'simulating' ? 'Neural simulation running' : 'Anatomy only · no activity yet');
    text('scene-title', s?.phase === 'encoding' ? s.source === 'jev' ? 'Jev describes. The fly waits.' : 'Your inputs. The real network.' : s?.phase === 'simulating' ? 'The fly gets its signals.' : 'The fly gets the vote.');
    text('scene-subtitle', s?.phase === 'encoding' ? 'No hidden approve/reject answer from the encoder.' : s?.phase === 'simulating' ? 'Running the real connectivity. Highlights appear only after activity is recorded.' : 'Real neuron positions. Drag to explore the nervous system.');
  } else if (inspectingAblation) {
    text('scene-label', 'Control trial · connections disabled'); text('scene-title', 'Same signals. Connections off.');
    text('scene-subtitle', 'Measured input activity can remain. This trial does not replace the original review.');
  } else if (!revealed) {
    text('scene-label', elapsed < 1200 ? 'Description → stimulation' : 'Recorded simulated activity · slowed playback');
    text('scene-title', elapsed < 1200 ? 'Properties become input signals.' : 'The fly model is responding.');
    text('scene-subtitle', elapsed < 1200 ? 'Signal routing is schematic. The neuron positions are real.' : 'Bright cells actually fired in this recorded time window. No invented spike paths.');
  } else {
    text('scene-label', 'Recorded trial complete'); text('scene-title', 'One network. One vote.');
    text('scene-subtitle', 'Our fixed readout turns this neural activity into a verdict. It is not an understanding of the code.');
  }
  if (s?.verdict && hasVote) {
    const v = s.verdict.verdict;
    el('verdict').dataset.vote = v;
    text('verdict-tag', `The fly’s original vote · ${changedRange(s.review)}`);
    text('verdict-title', v === 'changes_requested' ? 'Changes requested.' : v === 'no_objection' ? 'No objection.' : 'The fly abstains.');
    text('reviewer-comment', v === 'changes_requested' ? 'Explanation unavailable. Reviewer is a fruit fly.' : v === 'no_objection' ? 'Please don’t put “a fly approved it” in the incident report.' : 'Not enough downstream activity to issue a verdict.');
    text('readout-explanation', s.verdict.explanation);
    text('score', `Untrained objection score ${s.verdict.score.toFixed(3)}; threshold 0.65. This is NOT a probability of a bug.`);
    document.querySelectorAll('.diff-line.added').forEach(line=>line.classList.toggle('review-focus',v==='changes_requested'));
  }
  el('verification-section').hidden = !hasVote || !(s?.verification || s?.phase === 'investigating');
  if (s?.phase === 'investigating') {
    text('receipt-title','Writing a test. Not asking another opinion.'); text('receipt-explanation','Claude gets the code and its contract, not the fly’s verdict. The runner checks the original and changed functions.'); text('receipt-status','Investigating');
  }
  el('receipt').hidden = !s?.verification;
  if (s?.phase === 'error') { text('headline','The experiment stopped.'); text('explanation',s.explanation); }
  else if (s?.phase === 'encoding') { text('headline',s.source==='jev'?'Jev is describing the change.':'Using your manual signals.'); text('explanation',s.source==='jev'?'Four properties. No approve/reject question.':'No model is interpreting the code in this mode.'); }
  else if (s?.phase === 'simulating' || s?.phase === 'ablating') { text('headline',s.phase==='ablating'?'Testing the network’s contribution.':'Running the neural simulation.'); text('explanation','Measured data is on its way. The visible movement is the camera, not invented neural activity.'); }
  else if (playing && !revealed) { text('headline','Watch the actual recorded response.'); text('explanation','The computation is finished. This is a slow replay of its measured activity.'); }
  else if (s?.phase === 'investigating') { text('headline','Testing the fly’s vote.'); text('explanation','An independent AI proposes a case. The runner checks the original and changed code.'); }
  else if (s?.verification) { text('headline','A verdict is not evidence.'); text('explanation','The independently executed test result is below.'); }
  else if (hasVote) { text('headline','The fly has voted. Was it right?'); text('explanation','A separate investigator will propose a test. Ordinary code checks the claim.'); }
  else { text('headline','One diff. One fly. One questionable opinion.'); text('explanation','Ask for a review, then put the verdict to a test.'); }
}

function render(s: ReviewState) {
  const first = state === null; state = s;
  if(first){boundRun=s.runDir;selected=s.review.id;el<HTMLSelectElement>('example').value=selected;if(s.hasJev){mode='jev';el<HTMLInputElement>('jev-mode').checked=true;}renderDiff();}
  if(awaitingRun&&s.runDir!==previousRun&&s.review.id===selected){boundRun=s.runDir;awaitingRun=false;}
  const a=active();
  if(!a&&recording)clearRecording();
  el('api-notice').hidden=s.hasJev;
  el<HTMLInputElement>('jev-mode').disabled=!s.hasJev||s.busy; el<HTMLInputElement>('manual-mode').disabled=s.busy;
  el<HTMLSelectElement>('example').disabled=s.busy;
  document.querySelectorAll('.diff-line.added').forEach(line=>line.classList.toggle('scan',a?.phase==='encoding'));
  text('connection',connected?'Connected · live experiment':'Disconnected · reconnecting');
  text('provenance',a?.source==='jev'?`Live ${a.encoderModel??'Jev'} · real connectome`:a?.source==='manual'?'Manual inputs · real connectome · no Jev call':'Live Jev → real neural simulation → independent test');
  text('investigator-note',s.hasInvestigator?'One live Claude call. Then independent code execution.':'Set ANTHROPIC_API_KEY to enable the investigator.');
  if(a?.brain&&s.runDir!==knownRun){knownRun=s.runDir;knownAblation=a.ablation;play(a.brain,'original');}
  if(a?.ablation&&!knownAblation){knownAblation=a.ablation;play(a.ablation,'disconnected');}
  el('comparison').hidden=!a?.ablation;
  if(a?.ablation&&a.brain){
    const before=a.brain.feedHz+a.brain.groomHz+a.brain.escapeHz, after=a.ablation.feedHz+a.ablation.groomHz+a.ablation.escapeHz;
    text('comparison-title',before>0&&after===0?'The inputs arrived. The verdict disappeared.':'Connections disabled. Here is what changed.');
    text('comparison-detail',before>0&&after===0?'Same signals and seed. Switching off synaptic transmission removed all three downstream outputs. The network participated; that does not mean it understood the code.':`Original downstream total: ${before} Hz. Disconnected total: ${after} Hz. A silent original or surviving output does not establish the expected contribution.`);
  }
  text('repeat-result',a?.repeat?a.repeat.identical?'Fresh simulation reproduced the rates, time bins, sampled positions, and activity. Only compute time was excluded.':'The fresh simulation differed. This trial is not reproducible.':'');
  if(a?.verification){
    const r=a.verification,target=r.counterexample??r.runs[0],vote=a.verdict?.verdict;
    text('receipt-status',r.status.toUpperCase());
    text('receipt-title',r.status==='confirmed'?vote==='changes_requested'?'This objection checks out.':vote==='abstain'?'The test found a bug after abstention.':'The fly missed a real bug.':r.status==='unsubstantiated'?'We couldn’t substantiate a defect.':'The evidence is inconclusive.');
    text('receipt-explanation',r.status==='confirmed'?'The same valid input passes before the change and fails after it. That is a reproduced regression.':r.explanation);
    text('test-input',formatReviewInput(a.review,target.args));
    document.querySelector<HTMLElement>('.test-results')!.dataset.format=a.review.format;
    text('test-expected',formatReviewValue(a.review,target.expected));text('test-before',target.before.error??formatReviewValue(a.review,target.before.value));text('test-after',target.after.error??formatReviewValue(a.review,target.after.value));
    for(const [name,result] of [['before',target.before],['after',target.after]] as const){const passed=!result.error&&result.value===target.expected;el(`${name}-result`).className=passed?'pass':'fail';text(`${name}-pass`,passed?'PASS':'FAIL');}
    text('coverage',`${r.runs.length} executed cases: one AI-proposed input and ${r.runs.length-1} case-specific deterministic cases. No demonstrated defect is not proof of correctness.`);
    text('test-code',r.testCode);text('probe-detail',`${r.model} proposed ${a.review.functionName}(${r.probe.args.map(arg=>JSON.stringify(arg)).join(', ')}), expecting ${JSON.stringify(r.probe.expected)}. Unverified rationale: ${r.probe.rationale}`);
    text('model-expectation',r.modelExpectedCorrect?'The proposed expected value matched the independent contract.':'The AI’s expected value was wrong. The runner used the contract instead.');
    if(pendingVerification){pendingVerification=false;requestAnimationFrame(()=>el('verification-section').scrollIntoView({behavior:reduce.matches?'instant':'smooth',block:'nearest'}));}
  }
  el('log').replaceChildren(...(a?.log??[]).map(entry=>{const li=document.createElement('li'),time=document.createElement('time');time.textContent=new Date(entry.at).toLocaleTimeString('en-US',{hour12:false});li.append(time,document.createTextNode(entry.text));return li;}));
  text('evidence',a?.runDir?`Saved evidence: ${a.runDir}/review.json, events.jsonl, ${a.review.filename}, and regression.test.ts after investigation.`:'No review has run for this selection.');
  if(s.phase==='error'){text('error',s.explanation);el('error').hidden=false;pendingVerification=false;}
  renderFeatures();updateStory();
}

async function request(body: unknown) {
  el('error').hidden=true;
  try{const response=await fetch('/api/review/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error??`HTTP ${response.status}`);}
  catch(error){text('error',String(error));el('error').hidden=false;pendingVerification=false;presenting=false;}
}
function clearRecording() {
  recording=null;playing=false;revealed=false;elapsed=0;view.setActivity(emptyActivity);
  for(const id of ['verdict','comparison','verification-section'])el(id).hidden=true;
  for(const suffix of ['a','b','c']){el<HTMLMeterElement>(`output-${suffix}`).value=0;text(`rate-${suffix}`,'—');}
  el<HTMLButtonElement>('pause').disabled=true;el<HTMLInputElement>('scrub').disabled=true;el<HTMLInputElement>('scrub').value='0';
  text('neural-time','No recording yet');text('recording-note','');text('provenance','No review has run for this selection.');
  text('test-code','Run an independent investigation to generate a test.');text('probe-detail','');text('model-expectation','');text('readout-explanation','');text('score','');text('repeat-result','');text('evidence','No review has run for this selection.');el('log').replaceChildren();uiStamp='';
}
el('review').addEventListener('click',()=>{if(!mode)return;previousRun=state?.runDir??null;boundRun=null;awaitingRun=true;presenting=true;knownRun=null;knownAblation=null;clearRecording();void request({action:'review',caseId:selected,mode,...(mode==='manual'?{features:manual}:{})});if(matchMedia('(max-width: 780px)').matches&&!el<HTMLDetailsElement>('inspect').open)el('neural').scrollIntoView({behavior:reduce.matches?'instant':'smooth',block:'center'});});
for(const input of document.querySelectorAll<HTMLInputElement>('input[name="mode"]'))input.addEventListener('change',()=>{mode=input.value as 'jev'|'manual';renderFeatures();});
el('manual-shortcut').addEventListener('click',()=>{el<HTMLDetailsElement>('inspect').open=true;mode='manual';el<HTMLInputElement>('manual-mode').checked=true;renderFeatures();el('features').scrollIntoView({behavior:reduce.matches?'instant':'smooth',block:'center'});});
el('example').addEventListener('change',()=>{selected=el<HTMLSelectElement>('example').value;boundRun=null;awaitingRun=false;pendingVerification=false;presenting=false;clearRecording();renderDiff();renderFeatures();updateStory();});
el('verify').addEventListener('click',()=>{pendingVerification=true;void request({action:'verify'});});
el('disconnect').addEventListener('click',()=>void request({action:'disconnect'}));
el('repeat').addEventListener('click',()=>void request({action:'repeat'}));
for(const id of ['replay','play-original'])el(id).addEventListener('click',()=>{const brain=active()?.brain;if(brain)play(brain,'original');});
el('pause').addEventListener('click',()=>{if(elapsed>=6000)elapsed=0;playing=!playing;uiStamp='';updateStory();});
el('scrub').addEventListener('input',()=>{playing=false;frameIndex=Number(el<HTMLInputElement>('scrub').value);elapsed=1200+frameIndex*480;if(frameIndex===9&&playbackKind==='original')revealed=true;uiStamp='';updateStory();});
el('rotate').addEventListener('click',()=>{view.rotating=!view.rotating;updateRotation();});
el('reset-view').addEventListener('click',()=>view.resetView());
function updateRotation(){el<HTMLButtonElement>('reset-view').disabled=view.renderer!=='webgl';el<HTMLButtonElement>('rotate').disabled=reduce.matches||view.renderer!=='webgl';text('rotate',view.rotating&&!reduce.matches?'Pause orbit':'Rotate view');el('rotate').setAttribute('aria-pressed',String(view.rotating&&!reduce.matches));}
el('sound').addEventListener('click',()=>{sounding=!sounding;text('sound',sounding?'Sound on':'Sound off');el('sound').setAttribute('aria-pressed',String(sounding));if(sounding)beep();});
el('copy-test').addEventListener('click',async()=>{const r=active()?.verification;if(r)try{await navigator.clipboard.writeText(r.testCode);text('copy-test','Copied');}catch{el<HTMLDetailsElement>('inspect').open=true;el('test-code').scrollIntoView({block:'center'});text('copy-test','Select the test below to copy');}});
el('explain').addEventListener('click',()=>el<HTMLDialogElement>('explanation-dialog').showModal());el('close-explanation').addEventListener('click',()=>el<HTMLDialogElement>('explanation-dialog').close());

function draw(now: number) {
  const delta=lastAnimation?Math.min(100,now-lastAnimation):0;lastAnimation=now;
  if(playing)elapsed+=delta;
  if(recording&&active()?.brain){
    frameIndex=Math.max(0,Math.min(9,Math.floor((elapsed-1200)/480)));
    if(elapsed>=6000&&playing){playing=false;if(playbackKind==='original'){revealed=true;beep();}updateStory();presentVote();}
    const frame=recording.frames[frameIndex];
    view.setActivity(elapsed>=1200?(frame.activity3d??emptyActivity):emptyActivity);
    const stamp=`${knownRun}/${playbackKind}/${frameIndex}/${revealed}/${playing}/${elapsed<1200}`;
    if(stamp!==uiStamp){
      uiStamp=stamp;el<HTMLInputElement>('scrub').value=String(frameIndex);
      const final=revealed&&!playing&&playbackKind==='original',reading=final?recording:frame;
      for(const [suffix,value] of [['a',reading.feedHz],['b',reading.groomHz],['c',reading.escapeHz]] as const){el<HTMLMeterElement>(`output-${suffix}`).value=elapsed>=1200?value:0;text(`rate-${suffix}`,elapsed>=1200?`${value.toFixed(0)} Hz`:'—');}
      text('neural-time',elapsed<1200?'Input signals':final?'250 ms mean':`${frame.timeMs-25}–${frame.timeMs} ms`);
      text('recording-note',`${playbackKind==='disconnected'?'Disconnected':'Original'} trial: ${recording.spikes.toLocaleString()} spikes over 450 ms, ${recording.wallMs.toFixed(0)} ms compute. Playback shows measured 25 ms bins from 200–450 ms, approximately 19× slower. ${frame.activity3d?'3D positions and spike counts are recorded data.':'Legacy recording: rerun for 3D activity.'}`);
      updateStory();
    }
  }
  view.draw(now,reduce.matches,playbackKind==='disconnected'&&Boolean(recording));
  requestAnimationFrame(draw);
}
reduce.addEventListener('change',()=>{view.rotating=!reduce.matches;if(reduce.matches&&recording){elapsed=6000;frameIndex=9;playing=false;if(playbackKind==='original')revealed=true;uiStamp='';updateStory();presentVote();}updateRotation();});
void fetch('/anatomy.json').then(async response=>{if(!response.ok)throw new Error('Run npm run setup to generate the actual 3D anatomy.');return response.json() as Promise<BrainAnatomy>;}).then(anatomy=>{view.setAnatomy(anatomy);text('geometry-note',`${anatomy.geometry3d.length.toLocaleString()} sampled neuron-body positions and ${anatomy.links3d.length.toLocaleString()} actual connections are displayed. The full network still runs in the simulator. Bright points show measured firing; camera movement is not activity. Lines are schematic soma-to-soma segments, not axon shapes.`);updateRotation();updateStory();}).catch(error=>{text('anatomy-error',String(error));el('anatomy-error').hidden=false;});
const stream=new EventSource('/review-events');
stream.onopen=()=>{connected=true;if(state)render(state);};stream.onmessage=event=>render(JSON.parse(event.data) as ReviewState);stream.onerror=()=>{connected=false;text('connection','Disconnected · reconnecting');if(state)render(state);};
renderDiff();renderFeatures();updateRotation();requestAnimationFrame(draw);
