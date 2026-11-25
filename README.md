# 供应商联合走访的盲区分析与样本轮换

工序清单按实际地址识别，不按品牌识别；抽签概率仅对应当季登记的可访问总体。 所有资料均为合成记录。文件编码为 UTF-8，数字、日期及标记在原始记录中均以字符串保存。问号表示来源未能提供该值；加号分隔来源系统使用的组合编号。

## 资料

公开和受限是交付资料级别。访问顾问持有受限许可才能访问受限资料，买方资料只可使用其许可相符的范围。p 是入样概率，不含拒访后概率；没有有效访问的方法不能直接写入概率样本分子。

- `frame.json` 记录字段为 `plant`、`group`、`area`、`process`、`equipment`、`for_partner`。
- `samples.json` 记录字段为 `season`、`plant`、`method`、`p`、`visit`、`result`、`process`。
- `link_updates.json` 记录字段为 `season`、`left`、`right`、`state`、`reason`。
- `routes.json` 记录字段为 `route`、`advisor`、`plants`、`size`、`permission`、`confirmed`。
- `outlets.json` 记录字段为 `buyer`、`need`、`distinct`、`permission`。
- `capacity.json` 记录字段为 `facility`、`process`、`window`、`hours`、`used`、`source`、`permission`。
- `commitments.json` 记录字段为 `order`、`buyer`、`processes`、`hours`、`window`、`requirement`、`status`。

## 运行

使用 Node.js 22。项目无需下载第三方依赖。

```sh
npm ci --offline --ignore-scripts
npm test
npm run data:check   # 只跑资料引用核对
npm run model        # 只跑业务模型测试
npm run report       # 输出季度面板
```

`npm run data:check` 检查合成资料能否读取并核对相关记录的引用。资料校验脚本可以独立运行。

## 结论链

每个结论都能追溯到"哪一步证据支撑、下一步怎么改变它"：

1. **访前抽样**（`src/stats.js`）：`抽签` 且有有效 `p` 的记录才进入概率估计；`推荐`、`拒访`、`上门未核` 分别标为非概率、拒访、未核实，不能直接当分子。拒访仍算"已抽取"，但会拉低有效访问率。
2. **现场核实**（`src/links.js`）：以厂址为识别单位。`确认同线` 会把两个厂并成一个独立能力单位，产能取并集上限而不是相加，入样概率按单位合并（`1-(1-p1)(1-p2)`）；`待核` 只保留为待办证据。走访后发现附属厂与已访单位同线，代表性和可替代独立程度随之重算。
3. **估计范围**（`src/stats.js`）：只公布"已入样且有效访问的独立单位"的描述；覆盖不足、有效访问率不足或单位过少时，`canClaimWholePark` 为 false 并列出阻断原因。走访合格率单独给出，并明确不外推整个园区。
4. **联合供货**（`src/joint.js`）：只按"独立单位组合"的联合观察计数，`marginalProductUsed` 永远为 false，禁止用两个边际比例相乘。区间同时给出已观察下界与谨慎上界。容量不足判"不可行"；缺容量记录或并行工序共用设备但缺可重叠班次判"无法判断"；顺序工序可共用设备，但合计工时不足同样判"无法判断"。
5. **重复确认**（`src/joint.js`）：同线合并后，两家买方指向同一单位同一窗口时给出占用告警；答复按答复时点冻结，待审申请只保留一段已确认窗口。
6. **下一轮名单**（`src/allocation.js`）：按分层覆盖、联合证明缺口、同线两端兼查、上次拒访/未核综合打分，并用距离成本抵消"好走/大厂优先"的偏差。已接受路线（含被拒）计入顾问名额，未接受路线不预占。同线单位已在名单中时不重复占额，而是把确认名额留给需要两端兼查的工序。原始抽取与拒访事实完整保留。
7. **截止日**（`src/allocation.js`）：仍无法补足的分层进入 `noCommittableAlternative`，明确标注"不可用作可承诺替代"。
8. **披露与留证**（`src/allocation.js`、`src/receipts.js`）：公开读者只看宏观结论和"哪类工序无法对外承诺"，看不到受限产量，也不提供"总量减公开窗口"的反推入口。答复快照带哈希，篡改会被 `verifySnapshot` 识别；新回执只调整下一轮优先级，不改写既往答复。

## 命令行追问

```sh
node src/cli.js --process B            # B 工序：缺抽样覆盖、联合证明还是披露许可
node src/cli.js --processes B+C       # 整组联合证明
node src/cli.js --reader 受限          # 受限读者的披露视图
node src/cli.js --season S1            # 只看某一季的访问记录
```

`explainCandidate` 返回的 `missing` 会直接列出 `samplingCoverage`、`jointProof`、`disclosurePermission` 中哪些还缺，`howNextVisitsChangeConclusion` 给出哪些下一轮访问会改变结论。
