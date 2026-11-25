import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { parseAll, splitComposite, toNumber } from '../src/parse.js'
import { buildEntities, reconcileCapacity, combineIncludeProbability } from '../src/links.js'
import { estimateProcess, estimateAll, classifySample, evidenceTier } from '../src/stats.js'
import { jointSupply, detectDuplicateConfirmations, JOINT_STATE } from '../src/joint.js'
import { advisorBudgets, planNextRound, disclosureView } from '../src/allocation.js'
import { snapshotAnswer, verifySnapshot, applyReceipt, retainReviewedWindow } from '../src/receipts.js'
import { buildProject, explainCandidate } from '../src/project.js'

const tableNames = ['frame', 'samples', 'link_updates', 'routes', 'outlets', 'capacity', 'commitments']

async function loadRaw() {
  const raw = {}
  for (const name of tableNames) {
    raw[name] = JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'))
  }
  return raw
}

const raw = await loadRaw()
const data = parseAll(raw)
const links = buildEntities(data.frame, data.link_updates)
const capacity = reconcileCapacity(data.capacity, links.plantToEntity)
const project = buildProject(data, {})

test('问号与组合编号按来源格式解析，不臆造数值', () => {
  assert.equal(toNumber('?'), null)
  assert.equal(toNumber('0.5'), 0.5)
  assert.deepEqual(splitComposite('F3+F4'), ['F3', 'F4'])
  assert.deepEqual(splitComposite('?'), [])
})

test('同线以厂址识别：F2/F4 合并为一个独立能力单位', () => {
  const entity = links.plantToEntity.get('F2')
  assert.equal(entity.id, 'F2+F4')
  assert.equal(links.plantToEntity.get('F4').id, 'F2+F4')
  assert.equal(entity.merged, true)
  // 两个品牌不能分别计成两个单位
  const bEntities = links.entities.filter(e => e.processes.includes('B'))
  assert.equal(bEntities.length, 1)
})

test('待核同线不改变独立性，只保留为待办证据', () => {
  assert.equal(links.pendingLinks.length, 1)
  assert.equal(links.pendingLinks[0].state, '待核')
  assert.notEqual(links.plantToEntity.get('F1').id, links.plantToEntity.get('F3').id)
})

test('同线合并后容量按单位取并集上限，不叠加两家', () => {
  const f2f4 = capacity.find(c => c.entityId === 'F2+F4' && c.process === 'B')
  assert.equal(f2f4.coalesced, true)
  assert.deepEqual(f2f4.facilities.sort(), ['F2', 'F4'])
  // 原记录 F2 4h/used0、F4 4h/used2 → 合并后仍以 4h 为上限、已用 2h
  assert.equal(f2f4.hours, 4)
  assert.equal(f2f4.used, 2)
  assert.equal(f2f4.available, 2)
})

test('同线两厂各自被抽中时按单位合并入样概率', () => {
  assert.equal(combineIncludeProbability([0.5, 0.5]), 0.75)
  assert.equal(combineIncludeProbability([]), null)
})

test('访前抽样：抽签、推荐、拒访、未核的推断能力不同', () => {
  const draw = classifySample({ method: '抽签', p: 0.5, visit: '完成', result: '可供' })
  const recommend = classifySample({ method: '推荐', p: null, visit: '完成', result: '可供' })
  const refused = classifySample({ method: '抽签', p: 0.3, visit: '拒绝', result: '?' })
  const unverified = classifySample({ method: '推荐', p: null, visit: '未核', result: '?' })

  assert.equal(draw.usableForDesignNumerator, true)
  assert.equal(recommend.usableForDesignNumerator, false)
  assert.equal(recommend.disposition, 'nonprobability')
  assert.equal(refused.disposition, 'refused')
  assert.equal(refused.outcome, null)
  assert.equal(unverified.disposition, 'unverified')
  assert.ok(unverified.flags.includes('上门未核实'))
})

test('推荐来源即使完成也不能进入概率分子', () => {
  const estimate = estimateProcess({
    process: 'B',
    entities: links.entities,
    samples: data.samples,
  })
  const unit = estimate.sampledUnits.find(u => u.entityId === 'F2+F4')
  const recommendRow = unit.rows.find(r => r.method === '推荐')
  assert.equal(recommendRow.p, null)
  // 只有 F2 的抽签结果支撑该单位
  assert.deepEqual(unit.observedPlants, ['F2'])
  assert.equal(estimate.observedUnits, 1)
})

test('走访合格率不被写成整个园区合格率', () => {
  const b = estimateProcess({ process: 'B', entities: links.entities, samples: data.samples })
  assert.equal(b.visitedQualifiedShare, 1)
  assert.equal(b.claimScope.includes('不外推整个园区'), true)
  assert.ok(b.wholeParkClaimBlockedBy.length >= 0)

  const c = estimateProcess({ process: 'C', entities: links.entities, samples: data.samples })
  // C 有两个单位，只访问了 F5，覆盖不足，不能宣称整个园区
  assert.equal(c.frameSize, 2)
  assert.equal(c.canClaimWholePark, false)
  assert.equal(evidenceTier(c).includes('仅覆盖已入样范围'), true)
})

test('拒访与未核不进入有效覆盖，但保留为已抽取事实', () => {
  const a = estimateProcess({ process: 'A', entities: links.entities, samples: data.samples })
  // A 有 F1 与 F3；F3 被抽中但拒访。覆盖率仍算"已抽取"，但有效访问率下降。
  assert.equal(a.frameSize, 2)
  assert.equal(a.coveredUnits, 2)
  assert.equal(a.observedUnits, 1)
  assert.equal(a.response, 0.5)
  const f3 = a.sampledUnits.find(u => u.entityId === 'F3')
  assert.equal(f3.disposition, 'refused')
  assert.equal(f3.outcome, null)
  assert.equal(a.canClaimWholePark, false)
})

test('联合供货按组合观察，不用边际比例相乘', () => {
  const joint = jointSupply({
    processes: ['A', 'B'],
    entities: links.entities,
    samples: data.samples,
    capacity,
    commitments: data.commitments,
    window: 'W1',
    hoursRequired: 2,
    requirement: '并行',
  })
  assert.equal(joint.marginalProductUsed, false)
  assert.equal(joint.state, JOINT_STATE.FEASIBLE)
  assert.ok(joint.observedJointCount >= 1)
  assert.notEqual(joint.lowerBound, null)
  assert.ok(joint.boundsNote.includes('不得') || joint.boundsNote.includes('不代表'))
})

test('联合供货缺容量记录 → 无法判断，而不是按已有边际推定', () => {
  const joint = jointSupply({
    processes: ['B', 'C'],
    entities: links.entities,
    samples: data.samples,
    capacity,
    commitments: data.commitments,
    window: 'W2',
    hoursRequired: 2,
    requirement: '并行',
  })
  assert.equal(joint.state, JOINT_STATE.UNDETERMINED)
  assert.equal(joint.observedJointCount, 0)
})

test('同线合并后两家买方在同一窗口的确认被发现重复', () => {
  const duplicates = detectDuplicateConfirmations({
    commitments: data.commitments,
    entities: links.entities,
    capacity,
  })
  const f2f4 = duplicates.duplicates.find(d => d.entityId === 'F2+F4')
  assert.ok(f2f4, 'F2+F4 上的 O1/O2 必须被发现')
  assert.deepEqual(f2f4.buyers.sort(), ['P1', 'P2'])
  assert.equal(f2f4.overbooked, true)
  assert.ok(f2f4.why.includes('同线合并'))
})

test('共享设备的两项工序并行时无法判断', () => {
  const entities = [
    {
      id: 'X',
      plants: ['X'],
      processes: ['A', 'B'],
      equipmentByProcess: { A: ['E'], B: ['E'] },
      restricted: false,
    },
  ]
  const capacityX = [
    { entityId: 'X', process: 'A', window: 'W', hours: 8, used: 0, available: 8, permission: '公开' },
    { entityId: 'X', process: 'B', window: 'W', hours: 8, used: 0, available: 8, permission: '公开' },
  ]
  const parallel = jointSupply({
    processes: ['A', 'B'],
    entities,
    samples: [],
    capacity: capacityX,
    window: 'W',
    hoursRequired: 2,
    requirement: '并行',
  })
  assert.equal(parallel.state, JOINT_STATE.UNDETERMINED)
  assert.ok(parallel.explanation.includes('可重叠班次') || parallel.explanation.includes('无法判断'))
})

test('共享设备顺序占用时，单项容量不足则整组不可行', () => {
  const entities = [
    {
      id: 'X',
      plants: ['X'],
      processes: ['A', 'B'],
      equipmentByProcess: { A: ['E'], B: ['E'] },
      restricted: false,
    },
  ]
  // 每项只剩 1h，低于需求 2h，即使顺序安排也不可行
  const tight = [
    { entityId: 'X', process: 'A', window: 'W', hours: 5, used: 4, available: 1, permission: '公开' },
    { entityId: 'X', process: 'B', window: 'W', hours: 5, used: 4, available: 1, permission: '公开' },
  ]
  const result = jointSupply({
    processes: ['A', 'B'],
    entities,
    samples: [],
    capacity: tight,
    window: 'W',
    hoursRequired: 2,
    requirement: '顺序',
  })
  assert.equal(result.state, JOINT_STATE.INFEASIBLE)
})

test('共享设备顺序占用：单项够但合计不够时无法判断', () => {
  const entities = [
    {
      id: 'X',
      plants: ['X'],
      processes: ['A', 'B'],
      equipmentByProcess: { A: ['E'], B: ['E'] },
      restricted: false,
    },
  ]
  // 每项可用 3h（各够 2h），但共用设备合计需 4h，超过单项可用 3h
  const tight = [
    { entityId: 'X', process: 'A', window: 'W', hours: 3, used: 0, available: 3, permission: '公开' },
    { entityId: 'X', process: 'B', window: 'W', hours: 3, used: 0, available: 3, permission: '公开' },
  ]
  const result = jointSupply({
    processes: ['A', 'B'],
    entities,
    samples: [],
    capacity: tight,
    window: 'W',
    hoursRequired: 2,
    requirement: '顺序',
  })
  assert.equal(result.state, JOINT_STATE.UNDETERMINED)
  assert.ok(result.explanation.includes('顺序') || result.explanation.includes('无法判断'))
})

test('已接受访问计入顾问名额，未接受路线不预占', () => {
  const budgets = advisorBudgets(data.routes)
  const a1 = budgets.get('A1')
  assert.equal(a1.used, 1) // 只有 R3 confirmed
  assert.equal(a1.limit, 3) // R1(2) + R3(1) 约好限额
  assert.equal(a1.remaining, 2)
  const a2 = budgets.get('A2')
  assert.equal(a2.used, 0)
  assert.equal(a2.remaining, 2)
})

test('下一轮名单不因好走/大厂而集中，并保留真实抽取与拒访', () => {
  const plan = project.nextRound
  assert.ok(plan.assigned.length > 0)
  assert.ok(plan.preservedFacts.trueDraws.length > 0)
  assert.ok(plan.preservedFacts.refusals.some(r => r.plant === 'F3'))
  // F3 拒访但仍被排入，因为需要补覆盖并两端兼查
  assert.ok(plan.assigned.some(a => a.entityId === 'F3'))
})

test('截至截止日无法补足的分层明确不可作可承诺替代', () => {
  const plan = planNextRound({
    frame: data.frame,
    entities: links.entities,
    samples: data.samples,
    linkInfo: links,
    routes: [],
    jointResults: project.jointResults,
    season: null,
    deadlineReached: true,
  })
  // 无顾问额度时必然有未覆盖分层
  assert.ok(plan.deadlineGaps.length > 0)
  assert.ok(plan.noCommittableAlternative.length > 0)
  for (const gap of plan.noCommittableAlternative) {
    assert.equal(gap.usableAsCommittedAlternative, false)
    assert.ok(gap.message.includes('不可用作可承诺替代'))
  }
})

test('买方视图知道哪类工序无法对外承诺，但看不到受限产量', () => {
  const view = disclosureView({
    readerLevel: '公开',
    frame: data.frame,
    entities: links.entities,
    estimates: project.estimates,
    jointResults: project.jointResults,
    capacity,
    commitments: data.commitments,
  })
  assert.equal(view.antiDifferencing.exposedRestrictedTotals, false)
  assert.ok(view.restrictions.length > 0)
  // 受限工序只给状态，不给产量
  assert.equal(view.processes.B.state, '受限明细不可见')
  assert.equal(view.processes.B.wholeParkBounds, undefined)
  assert.ok(view.commitments.every(c => c.visible === false || c.processes.every(p => view.processes[p]?.state !== '受限明细不可见')))
})

test('受限读者获得受限明细，反推保护仍生效', () => {
  const view = disclosureView({
    readerLevel: '受限',
    frame: data.frame,
    entities: links.entities,
    estimates: project.estimates,
    jointResults: project.jointResults,
    capacity,
    commitments: data.commitments,
  })
  assert.equal(view.level, '受限细节 + 宏观')
  assert.notEqual(view.processes.B.state, '受限明细不可见')
  assert.equal(view.antiDifferencing.exposedRestrictedTotals, false)
})

test('答复按答复时点冻结，新回执不追溯改写', () => {
  const result = project.jointResults['O1:A+B']
  const snapshot = snapshotAnswer({
    buyer: 'P1',
    jointKey: 'O1:A+B',
    result,
    answeredAt: '2026-11-20T10:00:00Z',
    disclosureLevel: '公开',
  })
  assert.equal(verifySnapshot(snapshot).valid, true)

  const tampered = { ...snapshot, state: '不可行' }
  assert.equal(verifySnapshot(tampered).valid, false)

  const impact = applyReceipt({
    receipt: {
      receiptId: 'R',
      receivedAt: '2026-11-25T10:00:00Z',
      processes: ['A', 'B'],
      reason: '回执',
      outcome: '接受',
    },
    previousSnapshots: [snapshot],
    jointResults: {
      'O2:B+C': { processes: ['B', 'C'], state: '不可行' },
    },
  })
  assert.equal(impact.doesNotRewritePastAnswers, true)
  assert.deepEqual(impact.changedConclusions, [])
  assert.ok(impact.priorityShifts.length > 0)
})

test('在审采购申请保留一段已确认窗口', () => {
  const review = retainReviewedWindow({
    commitments: data.commitments,
    applications: [{ id: 'AP1', buyer: 'P3', window: 'W1', processes: ['B'], hours: 1 }],
    capacity,
    reserveHours: 1,
  })
  assert.equal(review[0].retainedHours, 1)
  assert.ok(review[0].confirmedWindowRetained.length > 0)
})

test('顾问能追问缺的是抽样覆盖、联合证明还是披露许可', () => {
  const panel = explainCandidate(project, { process: 'B', processes: ['B', 'C'], readerLevel: '公开' })
  assert.ok(panel.missing.includes('jointProof'))
  assert.ok(panel.missing.includes('disclosurePermission'))
  assert.ok(panel.answer.startsWith('缺 '))
  assert.ok(panel.howNextVisitsChangeConclusion.length > 0)
})

test('单工序提问也会把相关联合组的缺口列出来', () => {
  const panel = explainCandidate(project, { process: 'C', readerLevel: '公开' })
  assert.ok(panel.joint)
  assert.ok(panel.gaps.jointProof.length > 0)
})

test('多季：按季筛选访问记录，身份修正仍按已核实事实应用', () => {
  const s1 = buildProject(data, { season: 'S1' })
  const s2 = buildProject(data, { season: 'S2' })
  // S1 时点尚不知同线，仍按两家独立；S2 已知 F2/F4 同线
  assert.equal(s1.linkInfo.plantToEntity.get('F2').id, 'F2')
  assert.equal(s2.linkInfo.plantToEntity.get('F2').id, 'F2+F4')
  // S1 的 B 只有 F2 一条抽签，F4 的推荐记录属于 S1 但仍为非概率
  const s1b = s1.estimates.B
  assert.ok(s1b.observedUnits >= 1)
})
