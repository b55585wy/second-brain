import { truncate } from './validation.mjs';

export function adviceMessage(feedback) {
  const observations = feedback.observations ?? [];
  const summarize = items => items.slice(0, 2).map(item => `• ${truncate(item.comment, 200)}`).join('\n');
  const strengths = summarize(observations.filter(item => item.finding === 'met'));
  const improvements = summarize(observations.filter(item => item.finding !== 'met'));
  const next = truncate(feedback.nextActions?.[0] ?? '按评价要点补充一个具体例子和检查方法。', 300);
  const coverage = feedback.limitations?.find(item => item.startsWith('点评范围：'));
  return ['回答已保存｜AI 建议', truncate(feedback.summary, 400),
    `已做到\n${strengths || '本次回答还缺少可确认的达标依据。'}`,
    `待改进\n${improvements || '可结合下一步继续检查应用是否成立。'}`,
    `下一步\n${next}`, coverage,
    '这些是针对本次回答的建议，未自动核验事实或判断长期掌握。'].filter(Boolean).join('\n\n');
}
