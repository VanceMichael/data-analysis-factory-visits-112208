// 下一轮访问名单：同时承担提高分层覆盖与保留可用比较。
// 约束：
// - 每个顾问有约好的路线限额；已接受的访问即使被拒也要计入已用名额。
// - 顾问的保密范围与其能接收的资料级别一致；代表团只有宏观能力时不能接收持密细节。
// - 同线证据出现后，不再把同一独立单位当两个候选：要么把确认名额留给需要两端兼查的工序，
//   要么调整尚未确认的样本（保留真实抽取与拒访事实）。
// - 到截止日仍无法补足的分层，明确标注不可用作可承诺替代。

const PERMISSION_ORDER = { 公开: 0, 受限: 1 }

function maxPermission(a, b) {
  return PERMISSION_ORDER[a] >= PERMISSION_ORDER[b] ? a : b
}

function minPermission(a, b) {
  return PERMISSION_ORDER[a] <= PERMISSION_ORDER[b] ? a : b
}

export function strataKey(row) {
  return `${row.area}|${row.process}`
}

// 由路线记录推导每位顾问的限额和已用名额。
// 约好的路线（含尚未接受的提案）给出季度限额；已接受（confirmed）的访问计入已用，
// 被拒的访问同样占用名额。未接受路线不预先占用额度。
export function advisorBudgets(routes, { limitOverrides = {} } = {}) {
  const budgets = new Map()
  for (const route of routes) {
    if (!budgets.has(route.advisor)) {
      budgets.set(route.advisor, {
        advisor: route.advisor,
        limit: 0,
        used: 0,
        permission: '公开',
        acceptedRoutes: [],
        proposedRoutes: [],
      })
    }
    const budget = budgets.get(route.advisor)
    const count = route.size ?? route.plants.length
    budget.permission = maxPermission(budget.permission, route.permission)
    budget.limit += count
    if (route.confirmed) {
      budget.used += count
      budget.acceptedRoutes.push({ route: route.route, plants: route.plants, countedAs: count })
    } else {
      budget.proposedRoutes.push({ route: route.route, plants: route.plants, countedAs: count })
    }
  }
  for (const budget of budgets.values()) {
    const override = limitOverrides[budget.advisor]
    budget.agreedLimit = budget.limit
    if (override !== undefined) budget.limit = override
    budget.remaining = Math.max(0, budget.limit - budget.used)
  }
  return budgets
}

function jointNeedProcesses(jointResults) {
  // 联合供货里"部分工序已观察、另一些缺"的组，需要把两端兼查的工序排进下一轮。
  const needs = new Map()
  for (const result of Object.values(jointResults ?? {})) {
    if (!result || result.state === '可行') continue
    for (const partial of result.observationSupport?.partiallyObservedUnits ?? []) {
      for (const process of partial.missing) {
        if (!needs.has(process)) needs.set(process, new Set())
        needs.get(process).add(result.processes.join('+'))
      }
    }
    for (const process of result.observationSupport?.unobservedProcesses ?? []) {
      if (!needs.has(process)) needs.set(process, new Set())
      needs.get(process).add(result.processes.join('+'))
    }
  }
  return needs
}

export function planNextRound({
  frame,
  entities,
  samples,
  linkInfo,
  routes,
  jointResults,
  season,
  deadlineReached = false,
  config = {},
}) {
  const budgets = advisorBudgets(routes, { limitOverrides: config.limitOverrides ?? {} })
  const assigned = []
  const deferred = []
  const blocked = []

  // 每层已有效访问的独立单位数。拒访/未核只算"尝试过"，不算覆盖。
  const validVisitedByStrata = new Map()
  const attemptedByStrata = new Map()
  for (const sample of samples) {
    if (season && sample.season !== season) continue
    const entity = entities.find(e => e.plants.includes(sample.plant))
    if (!entity) continue
    const row = frame.find(f => f.plant === sample.plant)
    if (!row) continue
    const key = strataKey(row)
    if (!attemptedByStrata.has(key)) attemptedByStrata.set(key, new Set())
    attemptedByStrata.get(key).add(entity.id)
    if (sample.visit === '完成') {
      if (!validVisitedByStrata.has(key)) validVisitedByStrata.set(key, new Set())
      validVisitedByStrata.get(key).add(entity.id)
    }
  }

  const strataSizes = new Map()
  for (const entity of entities) {
    for (const row of entity.frameRows) {
      const key = strataKey(row)
      strataSizes.set(key, (strataSizes.get(key) ?? 0) + 1)
    }
  }

  const validVisitedUnits = new Set()
  for (const sample of samples) {
    if (season && sample.season !== season) continue
    if (sample.visit !== '完成') continue
    const entity = entities.find(e => e.plants.includes(sample.plant))
    if (entity) validVisitedUnits.add(entity.id)
  }

  const needs = jointNeedProcesses(jointResults)
  const pendingLeft = new Set()
  for (const link of linkInfo.pendingLinks) {
    pendingLeft.add(link.left)
    pendingLeft.add(link.right)
  }

  const candidates = entities.map(entity => {
    const rows = entity.frameRows
    const strata = rows.map(strataKey)
    const coverageGap = strata.filter(k => (validVisitedByStrata.get(k)?.size ?? 0) === 0)
    const jointNeed = entity.processes.filter(p => needs.has(p))
    const bothEndsCheck = entity.plants.some(p => pendingLeft.has(p))
    const alreadyCovered = validVisitedUnits.has(entity.id)
    const acceptedButRefused = samples.some(
      s =>
        (!season || s.season === season) &&
        entity.plants.includes(s.plant) &&
        s.visit === '拒绝',
    )
    const acceptedUnverified = samples.some(
      s =>
        (!season || s.season === season) &&
        entity.plants.includes(s.plant) &&
        s.visit === '未核',
    )
    const permission = entity.permission
    return {
      entityId: entity.id,
      plants: entity.plants,
      permission,
      area: entity.area,
      strata,
      coverageGap,
      jointNeed,
      bothEndsCheck,
      alreadyCovered,
      acceptedButRefused,
      acceptedUnverified,
      distanceCost: entity.area === '远' ? 2 : 1,
      score:
        coverageGap.length * 3 +
        jointNeed.length * 2 +
        (bothEndsCheck ? 2 : 0) +
        (acceptedButRefused ? 2 : 0) +
        (acceptedUnverified ? 1 : 0) +
        (alreadyCovered ? 0 : 1),
    }
  })

  // 只因路线好走与本就是大厂而更可能入线：用显式成本抵消，避免线路只落在近处大厂。
  candidates.sort((a, b) => {
    const sa = a.score - a.distanceCost * 0.5
    const sb = b.score - b.distanceCost * 0.5
    if (sb !== sa) return sb - sa
    return a.entityId.localeCompare(b.entityId)
  })

  const advisorOrder = [...budgets.values()].sort((a, b) => a.advisor.localeCompare(b.advisor))
  const assignmentByEntity = new Map()

  for (const candidate of candidates) {
    if (candidate.score === 0) {
      deferred.push({
        entityId: candidate.entityId,
        plants: candidate.plants,
        reason: '已覆盖且无新增分层或联合证明需求',
      })
      continue
    }
    const advisors = advisorOrder.filter(
      a => PERMISSION_ORDER[a.permission] >= PERMISSION_ORDER[candidate.permission],
    )
    if (advisors.length === 0) {
      blocked.push({
        entityId: candidate.entityId,
        plants: candidate.plants,
        reason: `候选资料为${candidate.permission}，无顾问持有相应许可`,
        kind: 'permission',
      })
      continue
    }
    const target = advisors.find(a => a.remaining > 0)
    if (!target) {
      deferred.push({
        entityId: candidate.entityId,
        plants: candidate.plants,
        reason: '路线限额已用尽',
        kind: 'budget',
      })
      continue
    }
    const existing = assignmentByEntity.get(candidate.entityId)
    if (existing) {
      // 同一独立单位已在名单中：若还需要两端兼查，保留其已占名额但不重复占额；
      // 否则按重复同线处理。
      if (candidate.bothEndsCheck || candidate.jointNeed.length > 0) {
        const entry = assigned.find(a => a.entityId === candidate.entityId)
        if (entry) {
          entry.twoEndsCheck = true
          entry.notes = [
            ...(entry.notes ?? []),
            '同线证据出现：确认名额留给需要两端兼查的工序，不新增占用',
          ]
          entry.reason = `${entry.reason}；同线确认名额用于两端兼查`
        }
        continue
      }
      deferred.push({
        entityId: candidate.entityId,
        plants: candidate.plants,
        reason: '同线合并后同一独立单位已在名单中，不重复占用名额',
        kind: 'duplicate-line',
      })
      continue
    }
    target.remaining -= 1
    assignmentByEntity.set(candidate.entityId, target.advisor)
    assigned.push({
      entityId: candidate.entityId,
      plants: candidate.plants,
      advisor: target.advisor,
      permission: minPermission(target.permission, candidate.permission),
      reason: buildReason(candidate),
      deferred: false,
    })
  }

  // 冻结后的分层覆盖只认有效访问。
  const plannedCoverage = new Map(
    [...strataSizes.keys()].map(k => [k, new Set(validVisitedByStrata.get(k) ?? [])]),
  )
  for (const item of assigned) {
    for (const key of item.entityId.split('+').flatMap(p => {
      const row = frame.find(f => f.plant === p)
      return row ? [strataKey(row)] : []
    })) {
      if (!plannedCoverage.has(key)) plannedCoverage.set(key, new Set())
      plannedCoverage.get(key).add(item.entityId)
    }
  }
  const uncoveredStrata = [...strataSizes.keys()]
    .filter(key => (plannedCoverage.get(key)?.size ?? 0) === 0)
    .sort()
  const deadlineGaps = uncoveredStrata.map(key => ({
    strata: key,
    reason: '到截止日仍未补足有效访问',
    usableAsCommittedAlternative: false,
    message: '该分层不可用作可承诺替代；采购不得据此承诺供应',
  }))

  return {
    season,
    budgets: advisorOrder.map(a => ({
      advisor: a.advisor,
      limit: a.limit,
      used: a.used,
      remaining: a.remaining,
      permission: a.permission,
      acceptedRoutes: a.acceptedRoutes,
      proposedRoutes: a.proposedRoutes,
      note: '已接受的访问（含被拒）计入已用名额',
    })),
    assigned,
    deferred,
    blocked,
    uncoveredStrata,
    deadlineGaps,
    deadlineReached,
    noCommittableAlternative: deadlineReached ? deadlineGaps : [],
    preservedFacts: {
      trueDraws: samples
        .filter(s => (!season || s.season === season) && s.method === '抽签')
        .map(s => ({ plant: s.plant, p: s.p, visit: s.visit, result: s.result })),
      refusals: samples
        .filter(s => (!season || s.season === season) && s.visit === '拒绝')
        .map(s => ({ plant: s.plant, p: s.p })),
      note: '调整未确认样本时保留原始抽取与拒访，季度估计仍可追溯每个结果的进入方式',
    },
  }
}

function buildReason(candidate) {
  const parts = []
  if (candidate.coverageGap.length > 0) parts.push(`补分层覆盖: ${candidate.coverageGap.join(',')}`)
  if (candidate.jointNeed.length > 0) parts.push(`联合证明缺工序: ${candidate.jointNeed.join(',')}`)
  if (candidate.bothEndsCheck) parts.push('需两端兼查同线证据')
  if (candidate.acceptedButRefused) parts.push('上次拒访，保留已接受名额事实')
  if (candidate.acceptedUnverified) parts.push('上次上门未核实')
  return parts.join('；') || '常规覆盖'
}

// 团队/买方视图：只有宏观能力时，不接收受限细节。
export function disclosureView({
  readerLevel,
  frame,
  entities,
  estimates,
  jointResults,
  capacity,
  commitments,
}) {
  const allowed = level => PERMISSION_ORDER[readerLevel] >= PERMISSION_ORDER[level]
  const macro = {
    reader: readerLevel,
    level: readerLevel === '受限' ? '受限细节 + 宏观' : '仅宏观',
    processes: {},
    joint: {},
    restrictions: [],
  }

  for (const [process, estimate] of Object.entries(estimates ?? {})) {
    const restrictedUnits = estimate.sampledUnits.filter(u =>
      entities.find(e => e.id === u.entityId)?.restricted,
    )
    if (!allowed('受限') && restrictedUnits.length > 0) {
      // 受限单位不能进入明细；只给该工序是否存在无法对外承诺的情况。
      macro.processes[process] = {
        available: estimate.verifiedAvailableUnits.some(id =>
          entities.find(e => e.id === id && !e.restricted),
        ),
        state: '受限明细不可见',
        note: '可知道该工序是否存在无法对外承诺的受限能力，但看不到受限厂产量',
        unrestrictedEvidenceOnly: true,
      }
      macro.restrictions.push({
        process,
        note: '受限明细受限，禁止通过公开窗口与受限厂总量做差还原',
      })
      continue
    }
    macro.processes[process] = {
      available: estimate.verifiedAvailableUnits.length > 0,
      state: estimate.canClaimWholePark ? '可作园区级描述' : '仅描述已访单位',
      wholeParkBounds: estimate.wholeParkBounds,
      visitedQualifiedShare: estimate.visitedQualifiedShare,
      caveat: estimate.claimScope,
    }
  }

  for (const [key, result] of Object.entries(jointResults ?? {})) {
    macro.joint[key] = {
      state: result.state,
      explanation: result.explanation,
      observedJointCount: result.observedJointCount,
      bounds: { lower: result.lowerBound, upper: result.cautiousUpperBound },
      note: allowed('受限')
        ? '含受限单位的容量明细'
        : '联合结论只给区间与状态；受限单位的窗口与用量不披露',
    }
  }

  // 反推保护：买方视图不提供"受限厂总量"，避免与公开窗口做差。
  const publicCapacity = capacity.filter(c => allowed(c.permission))
  macro.antiDifferencing = {
    exposedRestrictedTotals: false,
    publicRows: publicCapacity.length,
    note: '不提供受限厂总量或总量减公开窗口的差值查询',
  }

  const buyerCommitments = commitments.map(c => {
    const visible =
      allowed('受限') ||
      c.processes.every(p => macro.processes[p]?.state !== '受限明细不可见')
    return {
      order: c.order,
      buyer: c.buyer,
      processes: c.processes,
      status: c.status,
      visible,
      retainedWindow: c.status === '已确认' ? c.window : null,
      note: visible ? undefined : '该订单涉及受限工序，买方仅收到宏观结论',
    }
  })
  macro.commitments = buyerCommitments
  return macro
}
