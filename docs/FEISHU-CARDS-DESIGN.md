# Feishu Card 2.0 UI Review

## Design plan

All four templates use Card 2.0, `default` width, a blue header, blue/grey content blocks, and two to five root visual groups. Dynamic rich text is escaped and bounded; titles and button labels use `plain_text`. No icons, images, links, animations, backend imports, storage, network calls, or business policy are included.

The practice card makes the prompt the focal block, followed by one root-level answer form or the submitted answer status, then learning actions. The advice card groups the summary and optional collapsed limitations separately from 已做到, 待改进, 下一步, and decision actions. The flashcard has a question-first state and a distinct revealed-answer/self-rating state. The status card pairs one status block with allowlisted, narrow-screen action rows or a neutral fallback block.

## P0–P7 checks

### Practice card

- **P0 — 符合诉求：通过。** 今日学习 header、目标/时间副标题、主问题、1000 字多行回答、完成方式、提交、普通聊天长文提示、记忆闪卡和查看建议均有明确组件。提交后移除全部编辑控件并显示传入状态。
- **P1 — 层级：通过。** 唯一加粗主焦点是 prompt；目标和时间位于 header subtitle；辅助提示使用 notation/grey。
- **P2 — 分组：通过。** prompt、表单或回答状态、次级动作分别为独立根组，无 `hr` 平铺。
- **P3 — 复杂度：通过。** 三个根视觉块，蓝色仅用于主焦点/header，其余为 grey；包含背景容器和表单/按钮。
- **P4 — 对比：通过。** prompt 加粗，正文常规，辅助文本 notation，无动态 Markdown 标题。
- **P5 — 对齐：通过。** body 统一 12px 组间距和 padding；块内使用 4px/8px，无散设 margin。
- **P6 — 语义：通过。** blue 表示学习主内容，grey 表示次要信息；保存/评分之外没有状态色或误导性成功色。
- **P7 — 健壮：通过。** 单块使用 weighted column；动作行使用 flow/auto，表单仅位于 body 根节点，无 stretch 或固定内容宽度。

### Advice card

- **P0 — 符合诉求：通过。** 摘要、已做到、待改进、下一步、最多三条折叠限制、保存、暂不采纳和闪卡均齐备；重复决策禁用并保留人类可读历史。
- **P1 — 层级：通过。** 摘要是唯一主焦点，三个建议块标题加粗，决策状态为 notation/grey。
- **P2 — 分组：通过。** 摘要/限制、三个建议主题和动作各自分组，限制不挤入主摘要文本。
- **P3 — 复杂度：通过。** 五个根视觉块；每组最多两条 strengths/improvements、一条 nextAction、三条 limitations，使用背景和按钮结构。
- **P4 — 对比：通过。** 摘要和组标题加粗，正文常规，状态文本较小。
- **P5 — 对齐：通过。** 统一 body/块间距，动作列由 flow 容器管理，无散设 margin。
- **P6 — 语义：通过。** 主操作仅保存按钮使用 primary_filled；其他动作 default；没有正确性或掌握程度的色彩暗示。
- **P7 — 健壮：通过。** 三动作窄屏自动换行；长限制默认折叠；动态条目和文本均有数量/字节上限。

### Flashcard card

- **P0 — 符合诉求：通过。** 翻面前仅有问题、可选状态和翻面按钮；序列化对象完全不含答案或评分动作。翻面后显示答案及四个指定自我评分。
- **P1 — 层级：通过。** question 是唯一主焦点；status 和 remaining 为次要信息； revealed 状态以参考答案支撑，不制造第二个大焦点。
- **P2 — 分组：通过。** 问题、答案和两行评分分块；翻面前为问题/动作两组。
- **P3 — 复杂度：通过。** 翻面后四个根视觉块，蓝/灰背景加按钮结构；无多余动画或装饰。
- **P4 — 对比：通过。** 问题和参考答案标题加粗，答案正文常规，状态为 notation/grey。
- **P5 — 对齐：通过。** 统一根间距，评分按钮由两个 flow 行管理，无散设 margin。
- **P6 — 语义：通过。** 仅 rate_good 为 primary_filled；评分文案明确是自我反馈，不声称 AI 判定掌握。
- **P7 — 健壮：通过。** 两个评分按钮一行并允许窄屏换行；无 stretch；问题和答案分别限制字符及转义后字节。

### Status card

- **P0 — 符合诉求：通过。** 标题和消息清晰，调用方动作经 allowlist 过滤，支持 create_flashcard/refresh 等；无动作时提供中性提示，不发明业务动作。
- **P1 — 层级：通过。** message 为唯一加粗主焦点，title/subtitle 提供上下文。
- **P2 — 分组：通过。** 状态与动作或中性提示分组；动作最多两行，不与状态混排。
- **P3 — 复杂度：通过。** 两至三个根视觉块，最多八个动作；有背景容器与按钮结构。
- **P4 — 对比：通过。** 主消息加粗，无动作提示使用 notation/grey。
- **P5 — 对齐：通过。** 统一根间距，四个以内动作组成 flow 行，无散设 margin。
- **P6 — 语义：通过。** 最多一个 primary_filled 主按钮，其余 default；disabled 原样呈现。
- **P7 — 健壮：通过。** 动作自动换行，标签和消息有界；无 URL 执行、stretch 或固定宽内容。

## Automated verification

`node --test card-ui/feishu-cards.test.mjs`: **15 tests passed, 0 failed**.

Coverage includes exact exports/root schema/config/headers, serializability, form placement and unique names, special submit shape, all allowlisted callback actions and ratings, submitted transition, advice decisions and empty states, pre/post reveal isolation, malicious Markdown/HTML/mentions/links, worst-case Unicode/escaping below 30 KB and 200 tagged elements, and caller-input immutability.

`git diff --check -- card-ui`: **passed**.

## Parent verification still required

Parent must copy/export the module as `server/feishu-cards.mjs`, integrate server authorization and callback handling, and run SDK/schema validation plus actual Feishu client checks on desktop/mobile and light/dark modes. Parent should verify real form submission, callback nonce derivation, disabled states, collapsed details, and narrow layouts with the supported client versions.

No real card was sent and no screenshot, SDK render, actual-client behavior, or card-button success is claimed here.
