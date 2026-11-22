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
```

`npm run data:check` 检查合成资料能否读取并核对相关记录的引用。资料校验脚本可以独立运行。
