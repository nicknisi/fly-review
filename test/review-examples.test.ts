import assert from 'node:assert/strict';
import test from 'node:test';
import { REVIEW_CASES, DEFAULT_REVIEW_CASE, formatReviewInput, formatReviewValue } from '../src/review-cases.ts';
import { contractExpected, deterministicInputs, validateArgs } from '../src/review-oracles.ts';
import { executeProbe, parseProbe } from '../src/review-verify.ts';
import { encodeWithJev } from '../src/review-jev.ts';

const find = (id: string) => REVIEW_CASES.find(c=>c.id===id)!;

test('every bundled example has a valid baseline and the intended independently executable behavior', async () => {
  const controls = new Set(['refactor','leg-count']);
  for (const review of REVIEW_CASES) {
    const sweep = deterministicInputs(review);
    assert.ok(sweep.length >= 1 && sweep.length <= 49);
    for (const args of sweep) assert.deepEqual(validateArgs(review,args),args);
    const probe = { args:sweep[0], expected:contractExpected(review,sweep[0]), rationale:'TEST: use the case contract, never the fly verdict.' };
    const result = await executeProbe(review,probe,'test-only');
    assert.equal(result.status,controls.has(review.id)?'unsubstantiated':'confirmed',review.id);
    assert.ok(result.runs.every(r=>!r.before.error&&r.before.value===r.expected),review.id);
    assert.equal(result.runs.length,sweep.length+1);
    assert.ok(result.testCode.includes(`from './${review.filename}'`));
    assert.ok(result.testCode.includes(`assert.equal(${review.functionName}(`));
  }
  assert.equal(DEFAULT_REVIEW_CASE.id,'agent-tools');
});

test('probe validation handles booleans, enums, zero arguments, and rejects out-of-contract input', () => {
  const agent = find('agent-tools');
  assert.deepEqual(parseProbe({args:['bash',false],expected:false,rationale:'test'},agent).args,['bash',false]);
  assert.throws(()=>parseProbe({args:['bash','false'],expected:false,rationale:'test'},agent));
  assert.throws(()=>validateArgs(agent,['curl',false]));
  assert.throws(()=>validateArgs(find('audit-log'),['alice','not-a-demo-key']));
  assert.throws(()=>validateArgs(find('retry-delay'),[-1]));
  assert.throws(()=>validateArgs(find('token-expiry'),[0,Infinity]));
  assert.deepEqual(validateArgs(find('leg-count'),[]),[]);
  assert.throws(()=>validateArgs(find('leg-count'),[0]));
});

test('verification presents meaningful units and never coerces wrong scalar types into a pass-looking label', () => {
  assert.equal(formatReviewValue(find('agent-tools'),false),'Blocked');
  assert.equal(formatReviewValue(find('agent-tools'),true),'Allowed');
  assert.equal(formatReviewValue(find('agent-tools'),'false'),'"false"');
  assert.equal(formatReviewValue(find('retry-delay'),1000),'1,000 ms');
  assert.equal(formatReviewValue(find('retention'),true),'Delete');
  assert.equal(formatReviewValue(find('token-expiry'),true),'Expired');
  assert.equal(formatReviewValue(find('search-race'),false),'Ignore');
  assert.equal(formatReviewValue(find('audit-log'),'user=alice'),'"user=alice"');
  assert.match(formatReviewInput(find('agent-tools'),['bash',false]),/humanApproved: false/);
  assert.match(formatReviewInput(find('leg-count'),[]),/no inputs/);
});

test('Jev receives the selected case contract without reaction labels, oracle keys, or a supplied verdict', async () => {
  const previous = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY='test-only';
  try {
    const review = find('retry-delay');
    const mock: typeof fetch = async (_url,init)=>{
      const body=JSON.parse(init?.body as string);
      assert.equal(body.state.contract,review.contract);
      assert.equal(body.state.filename,'retry-delay.ts');
      assert.equal(body.state.after,review.after);
      assert.equal('oracle' in body.state,false);
      assert.equal('verdict' in body.state,false);
      assert.equal('title' in body.state,false);
      return Response.json({model:'test-jev',answers:Object.fromEntries(['externalInput','persistentData','timing','visibleBehavior'].map(k=>[k,{type:'noul',noul:.5}]))});
    };
    await encodeWithJev(review,mock);
  } finally {if(previous===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=previous;}
});

test('string arguments are passed as JSON literals rather than executable JavaScript', async () => {
  const attack = '\"); throw new Error("injected"); //';
  const review = { ...find('audit-log'), parameters:[{name:'userId',type:'enum' as const,values:[attack,'alice','bob']},{name:'apiKey',type:'enum' as const,values:['DEMO_KEY_A','DEMO_KEY_B']}] };
  const receipt=await executeProbe(review,{args:[attack,'DEMO_KEY_A'],expected:`user=${attack}`,rationale:'TEST quoted argument'},'test-only');
  assert.equal(receipt.runs[0].before.value,`user=${attack}`);
  assert.equal(receipt.status,'confirmed');
});
