# 1.x 历史实现

这里保存迁移前的 connectors、handlers、security、ConfigLoader 及其专属测试，仅用于历史回归；不属于 v2 的安全接口，不应被现役模块导入，也不进入 npm 发布包。

旧实现包含动态连接、SQL 首词授权、通用写入及原始错误响应等行为，不能作为新增功能的模板。`src/utils/async.ts`、`src/utils/concurrency.ts` 与对应现役测试留在项目主源码目录。

运行 `npm run test:legacy` 单独构建和验证历史模块。`npm test` 分别报告现役与历史测试；发布校验同时拒绝 legacy 路径和执行入口导入缺口。保留历史文件中的既有改动，不提供 1.x 运行入口或兼容性承诺。
