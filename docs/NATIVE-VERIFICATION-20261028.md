# 真实 SiYuan 验收 · 2026-10-28

范围：本机官方 SiYuan3.8.8、用户确认的新工作区 runtime/zhixing1c2af369、实际主后端模块。原 notes 工作区/6806内核保持运行，未读写其笔记。业务测试使用隔离产品数据；日常知行数据库没有导入合成知识。

| 验收项 | 实际结果 |
| --- | --- |
| 安装 | 用户手动安装，版本、签名、桌面与内核已核实。 |
| 新工作区 | 先证明目录不存在、创建后为空；用户确认后由思源界面初始化。 |
| 连接 | 实际版本、访问、notebooks、Riff全部通过。当前本地策略允许空Token；错误非空Token拒绝，不声明已测试有效非空Token。 |
| 错误路径 | 空闲端口关闭后连接不可用、误连其他本地服务均报告unavailable；没有假报成功。 |
| 写入与读回 | 4条合成来源知识从draft/unverified显式接受后同步；新专用notebook/deck及文档所有权、问题、答案、来源读回一致。 |
| 原生评分 | 4张不同卡分别提交Again1/Hard2/Good3/Easy4，实际native code0响应；相同operationId回放没有再次发送评分。接受/同步/复习均未把事实验证改成supported。 |
| 重启持久化 | 正常关闭独立窗口，内核与端口退出；从思源界面重新打开同工作区。4篇内容和4张卡due/reps/lapses/state/lastReview与重启前基线一致。 |
| 导出与权限 | 实际导出排除秘密字段；新/旧凭据文件DACL修复为仅当前用户，内容不变；独立验收引用记录也已收紧ACL。 |

桌面未指定port时，本轮观察64007→53199；使用官方 --workspace/--port 参数后实际监听127.0.0.1:19006。日常使用 [open-siyuan.cmd](../open-siyuan.cmd)，再使用 [start.cmd](../start.cmd)。[官方内核说明](https://github.com/siyuan-note/siyuan/issues/17866)及[固定版本桌面代码](https://raw.githubusercontent.com/siyuan-note/siyuan/v3.8.8/app/electron/main.js)可核对固定端口能力；本项目没有修改思源源码、自动安装或注册系统服务。

证据：

- 完整脱敏汇总（本机留存：`../.tmp/native-acceptance-20261028/delivery-summary.json`）
- 原始核心流程（本机留存：`../.tmp/native-acceptance-20261028/run-uGXvwA/report.json`）：63项通过后在ACL检查停止，含111原生调用、恰好4次评分，旧失败保留。
- 工作区与私有ACL跟进（本机留存：`../.tmp/native-acceptance-20261028/run-uGXvwA/workspace-and-acl-followup.json`）
- 重启前快照（本机留存：`../.tmp/native-acceptance-20261028/run-uGXvwA/continuation-before-1793150716983-4e382cd2-69c0-47b4-af57-b58546114f6a.json`）：25项通过。
- 固定端口重启后快照（本机留存：`../.tmp/native-acceptance-20261028/run-uGXvwA/continuation-after-1793152245498-61c4d7cd-3af9-48b9-b1d8-88999ee335b6.json`）：28项通过，17次原生只读请求、0次写入。
- 真实连接错误路径（本机留存：`../.tmp/native-acceptance-20261028/connection-errors-wrA4UI/report.json`）、知行实际连接（本机留存：`../.tmp/native-acceptance-20261028/production-connection.json`）
- 最新总测试日志（本机留存：`../.tmp/final-delivery-20261028-78eb241d/aggregate.log`）：打包16、后端163、前端33全部通过。

完整Kramdown含思源界面会更新的IAL格式元数据，因此最初一个全文摘要检查失败。后续逐字核对生成的问题、答案、来源和代码块内容，仅忽略代码块之外的空白分隔与原生IAL行；原始失败和差异检查保留，不把正文变化归为格式。全部四卡调度比较仍精确匹配。

边界：未验证全部实时Codex历史、可选飞书真实凭据或外部模型输出质量；有效非空SiYuan Token配置没有实测。项目/来源/审核/练习/输出数据保持独立，当前记忆调度仍经SiYuan Riff适配器完成。未来商业许可与分发方式需要另行决定。
