export const HEURISTIC_LIMITATION = '仅按字面匹配，不判断正确性或掌握程度，也不构成全面语义判断。';

const ENGLISH_STOPWORDS = new Set(('a an the and or of to for in on at with by from is are be as it this that my our your '
  + 'learn learning improve understand practice goal goals skill skills knowledge material materials how what why '
  + 'use using write explain build make create better develop development').split(' '));
const CHINESE_STOPWORDS = ['学习', '目标', '技能', '提升', '掌握', '了解', '理解', '练习', '方法', '问题', '知识', '材料', '如何', '怎样', '一个', '进行', '能够', '相关', '使用', '给出', '解释', '内容', '我们', '自己', '以及', '通过', '可以'];
const clip = value => [...value].slice(0, 80).join('');
const labels = values => [...new Set((values ?? []).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];

function englishTerm(word) {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 4 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

export function normalizedTerms(value) {
  let content = String(value ?? '').normalize('NFKC').toLowerCase();
  const terms = new Set((content.match(/[a-z][a-z0-9+#]*/g) ?? [])
    .filter(word => !ENGLISH_STOPWORDS.has(word)).map(englishTerm));
  for (const stopword of CHINESE_STOPWORDS) content = content.replaceAll(stopword, ' ');
  for (const run of content.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...run];
    for (let length = 2; length <= 4; length++) {
      for (let start = 0; start + length <= chars.length; start++) terms.add(chars.slice(start, start + length).join(''));
    }
  }
  return terms;
}

function overlap(label, terms, strong = false) {
  const selected = [...normalizedTerms(label)];
  const count = selected.filter(term => terms.has(term)).length;
  return selected.length && (!strong || count === selected.length) ? count : 0;
}

export function assessRelevance(material, profile) {
  const goals = labels(profile.goals);
  const skills = labels(profile.skills);
  const empty = { matchedGoals: [], matchedSkills: [], score: 0, careerScore: 0 };
  if (!goals.length) return { ...empty, status: 'unconfigured', reason: `尚未配置明确学习目标，请先设置目标。${HEURISTIC_LIMITATION}` };
  const terms = normalizedTerms([material.question, material.answer].filter(Boolean).join('\n'));
  const matchedGoals = goals.filter(goal => overlap(goal, terms));
  const matchedSkills = skills.filter(skill => overlap(skill, terms, true));
  if (!matchedGoals.length && !matchedSkills.length) return { ...empty, status: 'unmatched', reason: `未找到明确目标或技能的字面证据。${HEURISTIC_LIMITATION}` };
  const evidence = [matchedGoals.length ? `匹配目标「${clip(matchedGoals[0])}」` : '', matchedSkills.length ? `匹配明确技能「${clip(matchedSkills[0])}」` : ''].filter(Boolean).join('；');
  return { status: 'matched', matchedGoals, matchedSkills,
    score: matchedSkills.length * 1000 + matchedGoals.length * 10 + Math.min(9, matchedGoals.reduce((sum, goal) => sum + overlap(goal, terms), 0)),
    careerScore: overlap(profile.careerDirection ?? '', terms), reason: `${evidence}。${HEURISTIC_LIMITATION}` };
}

export function relevanceDto(relevance) {
  const { status, reason, matchedGoals, matchedSkills } = relevance;
  return { status, reason, matchedGoals, matchedSkills };
}

export function rankMaterials(materials, profile) {
  return materials.map(fact => ({ fact, relevance: assessRelevance(fact, profile) }))
    .sort((a, b) => b.relevance.score - a.relevance.score || b.relevance.careerScore - a.relevance.careerScore);
}

function coverage(completed, field, value) {
  return completed.filter(practice => practice[field] === value).length;
}

function leastCovered(values, completed, field) {
  return [...values].sort((a, b) => coverage(completed, field, a) - coverage(completed, field, b))[0] ?? '';
}

function choicesFor({ fact, relevance }, profile, completed) {
  const goals = relevance.matchedGoals.length ? relevance.matchedGoals : [leastCovered(labels(profile.goals), completed, 'goal')];
  const skills = relevance.matchedSkills.length ? relevance.matchedSkills : [''];
  return goals.flatMap(goal => skills.map(skill => ({ fact, relevance, goal, skill,
    coverage: coverage(completed, 'goal', goal) + (skill ? coverage(completed, 'skill', skill) : 0) })));
}

export function choosePracticeMaterial(materials, profile, completed = []) {
  const goal = leastCovered(labels(profile.goals), completed, 'goal');
  if (!goal) return null;
  const choices = rankMaterials(materials, profile).filter(item => item.relevance.status === 'matched')
    .flatMap(item => choicesFor(item, profile, completed));
  choices.sort((a, b) => a.coverage - b.coverage || b.relevance.score - a.relevance.score
    || b.relevance.careerScore - a.relevance.careerScore || String(a.fact.id).localeCompare(String(b.fact.id)));
  const choice = choices[0];
  if (!choice) return { fact: null, goal, skill: leastCovered(labels(profile.skills), completed, 'skill'),
    reason: `未找到匹配目标或技能的已接受材料，仅依据明确目标「${clip(goal)}」生成通用产物模板，不引用材料。${HEURISTIC_LIMITATION}` };
  return { fact: choice.fact, goal: choice.goal, skill: choice.skill,
    reason: `优先覆盖较少完成练习的目标或技能。${choice.relevance.reason}${choice.relevance.matchedGoals.length ? '' : '所选目标与材料的联系仍需用户建立。'}` };
}
