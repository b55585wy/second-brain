import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRelevance, normalizedTerms, choosePracticeMaterial, rankMaterials, HEURISTIC_LIMITATION } from '../../server/relevance.mjs';
import { appFor, ok, request, profile, knowledge, output, settings, fakeServer, jobDone } from './helpers.mjs';

async function generate(app, extra = {}) {
  const p = await ok(app, 'GET', '/learning-profile'); const old = await ok(app, 'GET', '/daily-plan');
  return (await jobDone(app, await ok(app, 'POST', '/daily-plan/generate', {
    expectedProfileRevision: p.revision, expectedPlanRevision: old.revision, ...extra }, 202))).result.plan;
}
const literalFact = (id, text) => ({ id, question: text, answer: text, sourceRefs: [] });
const source = text => [{ kind: 'manual', title: text, url: null, excerpt: text }];

test('English normalization, stopwords and Chinese 2–4 character fragments are deterministic', () => {
  assert.ok(normalizedTerms('OPTIMIZE Queries databases').has('query'));
  assert.ok(normalizedTerms('OPTIMIZE Queries databases').has('database'));
  assert.equal(normalizedTerms('learn the skills and practice goals').size, 0);
  const chinese = normalizedTerms('学习数据库索引');
  for (const term of ['数据', '数据库', '数据库索', '索引']) assert.ok(chinese.has(term));
  assert.ok(!chinese.has('学习')); assert.ok([...chinese].every(term => [...term].length >= 2 && [...term].length <= 4));
  assert.equal(assessRelevance(literalFact('a', '数据库索引可减少扫描'), { goals: ['优化数据库查询'], skills: ['索引'] }).status, 'matched');
  assert.equal(assessRelevance(literalFact('b', '学习知识和目标'), { goals: ['数据库索引'], skills: [] }).status, 'unmatched');
});

test('explicit skills outweigh generic overlap and require their nonempty literal evidence', () => {
  const p = { goals: ['Database architecture'], skills: ['Python'] };
  const generic = literalFact('generic', 'database architecture'); const skill = literalFact('skill', 'Python tables');
  assert.equal(rankMaterials([generic, skill], p)[0].fact.id, 'skill');
  assert.equal(choosePracticeMaterial([generic, skill], p).fact.id, 'skill');
  assert.equal(assessRelevance(skill, { goals: ['Database architecture'], skills: ['the'] }).status, 'unmatched');
  assert.equal(assessRelevance(literalFact('partial', 'distributed code'), { goals: ['biology'], skills: ['distributed systems'] }).status, 'unmatched');
});

test('career refines ordering only after explicit goal/skill evidence and never invents a goal', () => {
  const back = literalFact('a', 'SQL backend'); const front = literalFact('b', 'SQL frontend');
  for (const career of ['backend', 'frontend']) {
    assert.equal(assessRelevance(literalFact('career', career), { goals: ['biology'], skills: [], careerDirection: career }).status, 'unmatched');
    assert.equal(assessRelevance(back, { goals: [], skills: [], careerDirection: career }).status, 'unconfigured');
    assert.equal(choosePracticeMaterial([back, front], { goals: ['SQL'], skills: [], careerDirection: career }).fact.id, career === 'backend' ? 'a' : 'b');
  }
  assert.equal(choosePracticeMaterial([back], { goals: [], careerDirection: 'SQL backend' }), null);
});

test('different explicit career/goal/skill profiles select distinct related facts from the same materials and retain every source/candidate', async t => {
  const app = await appFor(t);
  const sql = await knowledge(app, { question: 'SQL query indexes', answer: 'SQL backend indexes reduce scans', sourceRefs: source('SQL reference') }, true);
  const python = await knowledge(app, { question: 'Python dataframe analysis', answer: 'Python pandas tables', sourceRefs: source('Python reference') }, true);
  const unrelated = await knowledge(app, { question: 'Botany leaves', answer: 'Leaf biology', sourceRefs: source('Botany reference') }, true);
  await knowledge(app, { question: 'SQL draft', answer: 'unreviewed SQL', sourceRefs: source('Draft reference') });
  const sourceCount = app.store.all('source').length;
  const initialRevision = app.store.require('knowledge', sql.id).revision;
  await profile(app, { goals: ['Optimize SQL queries'], skills: ['SQL'], careerDirection: 'backend' });
  let plan = await generate(app); assert.deepEqual(plan.items[0].knowledgeIds, [sql.id]); assert.ok(plan.items[0].provenance.sourceRefs.length);
  let list = await ok(app, 'GET', '/knowledge'); assert.equal(list.total, 4); assert.equal(list.items[0].id, sql.id);
  assert.equal(list.items.find(item => item.id === unrelated.id).relevance.status, 'unmatched');
  await profile(app, { goals: ['Analyze Python tables'], skills: ['Python'], careerDirection: 'analytics' });
  plan = await generate(app); assert.deepEqual(plan.items[0].knowledgeIds, [python.id]);
  const one = await ok(app, 'GET', `/knowledge/${python.id}`);
  assert.deepEqual(one.relevance.matchedSkills, ['Python']); assert.ok(one.relevance.reason.includes(HEURISTIC_LIMITATION));
  assert.ok(one.sourceRefs.length); assert.equal(app.store.all('source').length, sourceCount); assert.equal(app.store.all('knowledge').length, 4);
  assert.equal(app.store.require('knowledge', sql.id).revision, initialRevision); assert.equal(app.store.require('knowledge', sql.id).relevance, undefined);
});

test('no goals is explicitly unconfigured even with career/skills; unrelated or empty materials produce honest goal templates', async t => {
  const app = await appFor(t);
  await knowledge(app, { question: 'SQL backend', answer: 'SQL evidence', sourceRefs: source('SQL') }, true);
  await profile(app, { careerDirection: 'SQL backend', skills: ['SQL'] });
  let plan = await generate(app); assert.ok(plan.notices.some(item => item.code === 'NO_GOALS')); assert.equal(plan.items.length, 0);
  assert.equal((await ok(app, 'GET', '/knowledge')).items[0].relevance.status, 'unconfigured');
  await profile(app, { goals: ['Botany leaves'], skills: ['biology'] });
  plan = await generate(app); assert.ok(plan.notices.some(item => item.code === 'NO_RELEVANT_KNOWLEDGE'));
  assert.deepEqual(plan.items[0].knowledgeIds, []); assert.deepEqual(plan.items[0].provenance.sourceRefs, []);
  let practice = (await ok(app, 'GET', '/practices')).items.find(item => item.id === plan.items[0].practiceId);
  assert.equal(practice.kind, 'artifact'); assert.ok(practice.selectionReason.includes('不引用材料')); assert.ok(!practice.prompt.includes('SQL'));
  const empty = await appFor(t); await profile(empty, { goals: ['Draw botany leaves'] });
  plan = await generate(empty); practice = (await ok(empty, 'GET', '/practices')).items[0];
  assert.equal(practice.kind, 'artifact'); assert.deepEqual(practice.sourceRefs, []); assert.deepEqual(plan.items[0].knowledgeIds, []);
});

test('practice selection excludes rejected/draft/archived-project material and deduplicates selected facts', async t => {
  const app = await appFor(t); await profile(app, { goals: ['SQL'], skills: ['SQL'] });
  const project = await ok(app, 'POST', '/projects', { title: 'archived', goal: 'SQL', status: 'active' }, 201);
  await knowledge(app, { projectId: project.id, question: 'SQL archived', answer: 'SQL' }, true);
  await ok(app, 'DELETE', `/projects/${project.id}`, { expectedRevision: project.revision });
  const rejected = await knowledge(app, { question: 'SQL rejected', answer: 'SQL' });
  await ok(app, 'POST', `/knowledge/${rejected.id}/decision`, { expectedRevision: rejected.revision, decision: 'reject' });
  await knowledge(app, { question: 'SQL draft', answer: 'SQL' });
  const accepted = await knowledge(app, { question: 'SQL accepted', answer: 'SQL' }, true);
  const plan = await generate(app);
  assert.deepEqual(plan.items[0].knowledgeIds, [accepted.id]);
  assert.equal(new Set(plan.items.flatMap(item => item.knowledgeIds)).size, plan.items.flatMap(item => item.knowledgeIds).length);
});

test('real completed attempts rotate goal and skill coverage while same-day regeneration reuses practice and historical reasons', async t => {
  const app = await appFor(t);
  await knowledge(app, { question: 'SQL', answer: 'SQL', sourceRefs: source('SQL') }, true);
  await knowledge(app, { question: 'Python', answer: 'Python', sourceRefs: source('Python') }, true);
  const configured = await profile(app, { goals: ['SQL', 'Python'], skills: ['SQL', 'Python'] });
  let plan = await generate(app); const first = app.store.require('practice', plan.items[0].practiceId); const before = structuredClone(first);
  plan = await generate(app); assert.equal(plan.items[0].practiceId, first.id);
  const artifact = await output(app, { practiceId: first.id, content: 'actual saved artifact', status: 'final' });
  const attempt = await ok(app, 'POST', `/practices/${first.id}/attempts`, { output: 'actual completed explanation', assistanceLevel: 'none', evidenceRefs: [] }, 201);
  const next = app.learning.practiceSelection(); assert.notEqual(next.goal, first.goal); assert.notEqual(next.skill, first.skill);
  plan = await generate(app); assert.equal(plan.items[0].practiceId, first.id); assert.equal(plan.items[0].state, 'completed');
  const changed = await profile(app, { timeZone: 'Etc/UTC' });
  plan = await generate(app); const second = app.store.require('practice', plan.items[0].practiceId);
  assert.notEqual(second.id, first.id); assert.notEqual(second.goal, first.goal); assert.equal(second.provenance.profileRevision, changed.revision);
  const saved = app.store.require('practice', first.id);
  assert.equal(saved.provenance.label, before.provenance.label); assert.equal(saved.provenance.profileRevision, configured.revision);
  assert.equal((await ok(app, 'GET', `/practices/${first.id}/attempts`)).items[0].output, attempt.output);
  assert.equal((await ok(app, 'GET', '/outputs')).items.find(item => item.id === artifact.id).content, artifact.content);
  const practices = await ok(app, 'GET', '/practices');
  assert.equal(practices.items.find(item => item.id === first.id).selectionReason, before.provenance.label);
  assert.ok((await ok(app, 'GET', '/learning-profile/revisions')).items.some(item => item.profileRevision === configured.revision));
});

for (const budget of [0, 1, 15, 120]) test(`grounded daily practice respects a ${budget}-minute budget`, async t => {
  const app = await appFor(t); await profile(app, { goals: ['SQL'], skills: ['SQL'], dailyBudgetMinutes: budget });
  await knowledge(app, { question: 'SQL', answer: 'SQL', sourceRefs: source('SQL evidence') }, true);
  const plan = await generate(app); assert.ok(plan.scheduledMinutes <= budget); assert.equal(plan.unallocatedMinutes, budget - plan.scheduledMinutes);
  assert.equal(plan.items.reduce((sum, item) => sum + item.estimatedMinutes, 0), plan.scheduledMinutes);
});

test('GET decorations never alter revisions or enter strict exports and strict nested imports still reject them', async t => {
  const app = await appFor(t); await profile(app, { goals: ['SQL'] });
  const fact = await knowledge(app, { question: 'SQL', answer: 'SQL', sourceRefs: source('SQL evidence') }, true);
  const plan = await generate(app); const practiceId = plan.items[0].practiceId;
  const revision = app.store.require('practice', practiceId).revision;
  await ok(app, 'GET', '/knowledge'); await ok(app, 'GET', `/knowledge/${fact.id}`);
  const decorated = (await ok(app, 'GET', '/practices')).items[0]; assert.equal(decorated.selectionReason, decorated.provenance.label);
  assert.equal(app.store.require('practice', practiceId).revision, revision); assert.equal(app.store.require('knowledge', fact.id).revision, fact.revision);
  const document = JSON.parse((await ok(app, 'POST', '/exports', { scope: 'all', projectIds: [], includeSourceContent: true })).content);
  assert.equal(document.data.knowledge[0].relevance, undefined); assert.equal(document.data.practices[0].selectionReason, undefined);
  const target = await appFor(t); await ok(target, 'POST', '/imports', { document, mode: 'merge' });
  assert.equal((await ok(target, 'GET', '/practices')).items[0].selectionReason, decorated.selectionReason);
  for (const [entity, field] of [['knowledge', 'relevance'], ['practices', 'selectionReason']]) {
    const malformed = structuredClone(document); malformed.data[entity][0][field] = field === 'relevance' ? {} : 'injected';
    assert.equal((await request(target, 'POST', '/imports', { document: malformed, mode: 'merge' })).status, 422);
  }
});

test('external model materials require the unchanged explicit processing consent', async t => {
  let calls = 0;
  const upstream = await fakeServer(t, () => ({ choices: [{ message: { content: JSON.stringify({ kind: 'artifact', prompt: 'SQL exercise', estimatedMinutes: 1,
    rubric: [{ label: 'evidence', description: 'show SQL', expectedEvidence: ['output'] }] }) } }] }));
  const app = await appFor(t, { transport: { fetch: (url, init) => { calls++; return fetch(upstream.origin + '/chat/completions', init); } } });
  const p = await profile(app, { goals: ['SQL'] }); await knowledge(app, { question: 'SQL', answer: 'SQL' }, true);
  await settings(app, { model: { enabled: true, endpoint: 'https://api.deepseek.com/v1', model: 'test', apiKey: 'synthetic-external-key', allowExternalProcessing: false } });
  const ack = await ok(app, 'POST', '/daily-plan/generate', { expectedProfileRevision: p.revision, expectedPlanRevision: 0, mode: 'model', allowTemplateFallback: false }, 202);
  assert.equal((await jobDone(app, ack, 'failed')).error.code, 'MODEL_UNAVAILABLE'); assert.equal(calls, 0);
  await settings(app, { model: { allowExternalProcessing: true } });
  const plan = await generate(app, { mode: 'model', allowTemplateFallback: false });
  assert.equal(plan.items[0].provenance.mode, 'model'); assert.equal(calls, 1);
});

test('zero matching material stays a local generic artifact even when model mode is requested', async t => {
  let calls = 0;
  const app = await appFor(t, { transport: { fetch: () => { calls++; throw new Error('unexpected external processing'); } } });
  await profile(app, { goals: ['Botany leaves'], careerDirection: 'SQL backend' });
  await knowledge(app, { question: 'SQL', answer: 'SQL' }, true);
  const plan = await generate(app, { mode: 'model', allowTemplateFallback: false });
  const practice = app.store.require('practice', plan.items[0].practiceId);
  assert.equal(practice.kind, 'artifact'); assert.equal(practice.provenance.mode, 'template'); assert.equal(calls, 0);
  assert.deepEqual(practice.sourceRefs, []); assert.deepEqual(plan.items[0].knowledgeIds, []); assert.ok(practice.prompt.includes('仅为目标产物模板'));
});

test('completed skill coverage rotates material even when both facts serve one explicit goal', () => {
  const facts = [literalFact('a', 'storage SQL'), literalFact('b', 'storage Python')];
  const p = { goals: ['storage'], skills: ['SQL', 'Python'] };
  const first = choosePracticeMaterial(facts, p); assert.equal(first.skill, 'SQL');
  const next = choosePracticeMaterial(facts, p, [{ goal: first.goal, skill: first.skill }]);
  assert.equal(next.goal, first.goal); assert.equal(next.skill, 'Python'); assert.equal(next.fact.id, 'b');
});
