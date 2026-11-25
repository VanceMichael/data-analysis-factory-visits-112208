// 联合供货：一组工序必须在同一个交货窗口同时可得。
// 关键约束：
// - 联合可得性来自"独立单位组合"的实际观察，不能由两个工序的边际比例相乘得到。
// - 同线合并后，F2 与 F4 只算一份独立能力；组合里不能把它们当两个来源。
// - 同一单位承担多个工序时，共用设备可顺序占用；但需在同一窗口独立完成的工序
//   必须有足够的可重叠班次，资料未给就是"无法判断"。
// - 平行订单可共享访查凭据，但不能共用同一时间的产能额度。

import { stricterPermission } from './links.js'

export const JOINT_STATE = {
  FEASIBLE: '可行',
  INFEASIBLE: '不可行',
  UNDETERMINED: '无法判断',
}

export function capacityIndex(capacity) {
  const index = new Map()
  for (const row of capacity) {
    const key = `${row.entityId}|${row.process}|${row.window}`
    if (!index.has(key)) index.set(key, [])
    index.get(key).push(row)
  }
  return index
}

function rowsFor(index, entityId, process, window) {
  return index.get(`${entityId}|${process}|${window}`) ?? []
}

function availableFor(index, entityId, process, window) {
  const rows = rowsFor(index, entityId, process, window)
  if (rows.length === 0) return null
  return Math.max(...rows.map(r => r.available))
}

function permissionFor(index, entityId, process, window) {
  const rows = rowsFor(index, entityId, process, window)
  if (rows.length === 0) return '公开'
  return rows
    .map(r => r.permission)
    .reduce((acc, level) => stricterPermission(acc, level), '公开')
}

// 单个单位内部：设备是否被多个工序共用，以及排程是否可判。
function scheduleForEntity({ entity, assignedProcesses, window, index, hoursRequired, requirement }) {
  const overlaps = []
  for (let i = 0; i < assignedProcesses.length; i += 1) {
    for (let j = i + 1; j < assignedProcesses.length; j += 1) {
      const a = entity.equipmentByProcess[assignedProcesses[i]] ?? []
      const b = entity.equipmentByProcess[assignedProcesses[j]] ?? []
      const shared = a.filter(eq => b.includes(eq))
      if (shared.length > 0) {
        overlaps.push({ pair: [assignedProcesses[i], assignedProcesses[j]], equipment: shared })
      }
    }
  }
  if (overlaps.length === 0) return { state: '可行', overlaps, notes: [] }

  const notes = []
  if (requirement === '并行') {
    for (const overlap of overlaps) {
      notes.push(
        `${overlap.pair.join('+')} 共用设备 ${overlap.equipment.join('/')}；并行需可重叠班次，资料未给`,
      )
    }
    return { state: JOINT_STATE.UNDETERMINED, overlaps, notes }
  }

  // 顺序：可先后占用同一设备，但合计工时不得超过共用设备所在工序的可用工时。
  for (const overlap of overlaps) {
    const availability = overlap.pair.map(process => {
      const available = availableFor(index, entity.id, process, window)
      return available ?? 0
    })
    const sharedAvailable = Math.min(...availability)
    const sharedRequired = hoursRequired * overlap.pair.length
    if (sharedAvailable < sharedRequired) {
      notes.push(
        `顺序 ${overlap.pair.join('+')} 共用设备 ${overlap.equipment.join('/')}，` +
          `可用 ${sharedAvailable}h < 合计 ${sharedRequired}h`,
      )
      return { state: JOINT_STATE.UNDETERMINED, overlaps, notes }
    }
  }
  return { state: '可行', overlaps, notes }
}

function entityOption({ entity, processes, window, index, hoursRequired, requirement }) {
  const perProcess = processes.map(process => {
    const available = availableFor(index, entity.id, process, window)
    return {
      process,
      available,
      required: hoursRequired,
      permission: permissionFor(index, entity.id, process, window),
      enough: available !== null && available >= hoursRequired,
      hasCapacityRecord: available !== null,
    }
  })
  const capacityOk = perProcess.every(p => p.enough)
  const schedule = scheduleForEntity({
    entity,
    assignedProcesses: processes,
    window,
    index,
    hoursRequired,
    requirement,
  })
  return {
    entityId: entity.id,
    plants: entity.plants,
    processes,
    perProcess,
    capacityOk,
    scheduleState: schedule.state,
    equipmentOverlaps: schedule.overlaps,
    gaps: [
      ...perProcess.filter(p => !p.enough).map(p =>
        p.hasCapacityRecord
          ? `${entity.id}/${p.process}@${window}: 可用 ${p.available}h < 需求 ${p.required}h`
          : `${entity.id}/${p.process}@${window}: 无容量记录`,
      ),
      ...schedule.notes,
    ],
  }
}

// 枚举"工序 -> 独立单位"的分配（同一单位可承担多个工序）。
function enumerateAssignments(processes, entities, capacityIndexMap, window) {
  const candidatesByProcess = processes.map(process =>
    entities
      .filter(e => e.processes.includes(process))
      .map(e => e.id),
  )
  const results = []
  const stack = []
  const walk = index => {
    if (index === processes.length) {
      results.push([...stack])
      return
    }
    for (const entityId of candidatesByProcess[index]) {
      stack.push({ process: processes[index], entityId })
      walk(index + 1)
      stack.pop()
    }
  }
  walk(0)
  const byEntity = entitiesById(entities)
  return results.map(rows => {
    const groups = new Map()
    for (const row of rows) {
      if (!groups.has(row.entityId)) groups.set(row.entityId, [])
      groups.get(row.entityId).push(row.process)
    }
    return [...groups.entries()].map(([entityId, assignedProcesses]) =>
      entityOption({
        entity: byEntity.get(entityId),
        processes: assignedProcesses,
        window,
        index: capacityIndexMap,
        hoursRequired: rows.hoursRequired ?? 0,
        requirement: rows.requirement ?? '并行',
      }),
    )
  })
}

function entitiesById(entities) {
  return new Map(entities.map(e => [e.id, e]))
}

function observationFor({ option, samples, season }) {
  const byProcess = new Map()
  for (const sample of samples) {
    if (season && sample.season !== season) continue
    if (!option.plants.includes(sample.plant)) continue
    if (sample.visit !== '完成') continue
    for (const process of sample.processesAsked) {
      if (!option.processes.includes(process)) continue
      if (!byProcess.has(process)) byProcess.set(process, [])
      byProcess.get(process).push(sample.result)
    }
  }
  const observedAvailable = option.processes.filter(process => {
    const results = byProcess.get(process) ?? []
    return results.includes('可供') && !results.includes('不可供')
  })
  const observedUnavailable = option.processes.filter(process =>
    (byProcess.get(process) ?? []).includes('不可供'),
  )
  return {
    observed: observedAvailable.length === option.processes.length,
    observedAvailable,
    observedUnavailable,
    missing: option.processes.filter(process => !byProcess.has(process)),
  }
}

function optionIndependence(option) {
  // 同一单位承担多个工序时，独立性内部已由同线合并保证；
  // 这里只报告该单位是否为合并单位，提醒不能与同线另一品牌再计一份。
  return {
    entityId: option.entityId,
    plants: option.plants,
    merged: option.plants.length > 1,
    countsAsIndependentUnits: 1,
  }
}

function summariseCombination(option, observation) {
  return {
    assignment: option.processes.map(process => ({
      process,
      entityId: option.entityId,
      plants: option.plants,
      plantsForThisProcess: option.plants,
    })),
    capacityOk: option.capacityOk,
    scheduleState: option.scheduleState,
    gaps: option.gaps,
    perProcess: option.perProcess,
    observation,
    independence: optionIndependence(option),
  }
}

export function jointSupply({
  processes,
  entities,
  samples,
  season,
  capacity,
  commitments = [],
  window,
  hoursRequired,
  requirement = '并行',
  outlets = [],
}) {
  const uniqueProcesses = [...new Set(processes)]
  const index = capacityIndex(capacity)
  const byId = entitiesById(entities)
  const assignments = enumerateAssignmentsRaw({
    processes: uniqueProcesses,
    entities,
    index,
    window,
    hoursRequired,
    requirement,
  })

  // 每个分配拆成"按单位分组的选项"，再评估。
  const combinations = assignments.map(({ rows }) => {
    const options = rows.map(({ entityId, assignedProcesses }) =>
      entityOption({
        entity: byId.get(entityId),
        processes: assignedProcesses,
        window,
        index,
        hoursRequired,
        requirement,
      }),
    )
    const fullyCapacityOk = options.every(o => o.capacityOk)
    // 容量"不足"与"没有记录"要分开：前者可判不可行，后者只能无法判断。
    const anyCapacityShort = options.some(o =>
      o.perProcess.some(p => p.hasCapacityRecord && !p.enough),
    )
    const anyCapacityUnknown = options.some(o =>
      o.perProcess.some(p => !p.hasCapacityRecord),
    )
    const allSchedulesOk = options.every(o => o.scheduleState === '可行')
    const anyScheduleUnknown = options.some(o => o.scheduleState === JOINT_STATE.UNDETERMINED)
    const observations = options.map(o => ({ option: o, observation: observationFor({ option: o, samples, season }) }))
    const observedJoint = observations.every(x => x.observation.observed)
    const observedUnavailable = observations.some(x => x.observation.observedUnavailable.length > 0)
    const partlyObserved = observations.some(x => x.observation.observedAvailable.length > 0)

    let state
    if (anyCapacityShort) {
      state = JOINT_STATE.INFEASIBLE
    } else if (anyCapacityUnknown || anyScheduleUnknown) {
      state = JOINT_STATE.UNDETERMINED
    } else if (fullyCapacityOk && allSchedulesOk && observedJoint) {
      state = JOINT_STATE.FEASIBLE
    } else if (fullyCapacityOk && allSchedulesOk) {
      // 容量与排程都可行，但该组合没有联合观察：不能据此宣称联合可得。
      state = JOINT_STATE.UNDETERMINED
    } else {
      state = JOINT_STATE.UNDETERMINED
    }
    return {
      state,
      capacityState: anyCapacityShort ? 'short' : anyCapacityUnknown ? 'unknown' : 'ok',
      capacityFeasible: fullyCapacityOk && !anyCapacityUnknown,
      observedJoint,
      observedUnavailable,
      partlyObserved,
      options: observations.map(x => summariseCombination(x.option, x.observation)),
      units: options.map(o => ({ entityId: o.entityId, plants: o.plants, processes: o.processes })),
      gaps: options.flatMap(o => o.gaps),
    }
  })

  const capacityFeasibleCombos = combinations.filter(c => c.capacityFeasible)
  const observedJointCombos = capacityFeasibleCombos.filter(
    c => c.observedJoint && c.state === JOINT_STATE.FEASIBLE,
  )
  const observedUnavailableFeasible = capacityFeasibleCombos.filter(c => c.observedUnavailable)
  const undeterminedCombos = combinations.filter(c => c.state === JOINT_STATE.UNDETERMINED)
  const infeasibleCombos = combinations.filter(c => c.state === JOINT_STATE.INFEASIBLE)

  let state
  if (observedJointCombos.length > 0) {
    state = JOINT_STATE.FEASIBLE
  } else if (combinations.length > 0 && infeasibleCombos.length === combinations.length) {
    // 所有组合都因容量不足或工序缺失被排除，才可判不可行。
    state = JOINT_STATE.INFEASIBLE
  } else if (
    observedUnavailableFeasible.length > 0 &&
    observedUnavailableFeasible.length === capacityFeasibleCombos.length &&
    undeterminedCombos.every(c => c.observedUnavailable)
  ) {
    state = JOINT_STATE.INFEASIBLE
  } else {
    // 容量记录缺失、排程班次未知、或容量可行但无联合观察，都只能无法判断。
    state = JOINT_STATE.UNDETERMINED
  }

  const totalCombos = combinations.length
  const lower = totalCombos > 0 ? observedJointCombos.length / totalCombos : null
  // 上界保留"未被观察到不可供"的组合，但仍不代表已观察联合可得。
  const upper = totalCombos > 0 ? (totalCombos - observedUnavailableFeasible.length) / totalCombos : null

  const perProcessMarginal = uniqueProcesses.map(process => {
    const ids = new Set()
    for (const sample of samples) {
      if (season && sample.season !== season) continue
      if (sample.visit !== '完成' || sample.result !== '可供') continue
      if (!sample.processesAsked.includes(process)) continue
      const entity = entities.find(e => e.plants.includes(sample.plant))
      if (entity) ids.add(entity.id)
    }
    return { process, availableUnits: ids.size }
  })

  const observationSupport = {
    observedJointCombinations: observedJointCombos.map(c => ({
      units: c.units,
      perProcess: c.options.flatMap(o => o.perProcess),
      gaps: c.gaps,
    })),
    partiallyObservedCombinations: capacityFeasibleCombos
      .filter(c => !c.observedJoint && c.partlyObserved)
      .map(c => ({
        units: c.units,
        missingProcesses: c.options.flatMap(o => o.observation.missing),
        note: '只有部分工序被走访，联合状态无法判断',
      })),
    unobservedProcesses: uniqueProcesses.filter(
      process =>
        !samples.some(
          s =>
            (!season || s.season === season) &&
            s.processesAsked.includes(process) &&
            s.visit === '完成',
        ),
    ),
    perProcessMarginal,
    marginalProductUsed: false,
    note: '联合可得按组合观察计数；不得用两个工序的边际比例相乘代替',
  }

  const holds = commitments
    .filter(c => c.window === window && c.processes.some(p => uniqueProcesses.includes(p)))
    .map(c => ({
      order: c.order,
      buyer: c.buyer,
      status: c.status,
      hours: c.hours,
      processes: c.processes,
      countedAsCapacity: false,
      note:
        c.status === '已确认'
          ? '已确认窗口，需保留额度'
          : c.status === '待确认'
            ? '审查中，不能把同一窗口再向其他买方确认'
            : '候选订单，不占额度',
    }))

  const outletChecks = outlets.map(outlet => {
    const needObserved = observedJointCombos.filter(c =>
      outlet.need.every(process => uniqueProcesses.includes(process)),
    )
    return {
      buyer: outlet.buyer,
      need: outlet.need,
      distinctRequired: outlet.distinct,
      distinctObservedJoint: observedJointCombos.length,
      distinctCapacityFeasible: capacityFeasibleCombos.length,
      outcome:
        capacityFeasibleCombos.length >= outlet.distinct
          ? '容量可行组合数足够'
          : capacityFeasibleCombos.length > 0
            ? '容量可行组合不足'
            : '无兼容组合',
      observedJointForNeed: needObserved.length,
      permission: outlet.permission,
    }
  })

  return {
    processes: uniqueProcesses,
    window,
    hoursRequired,
    requirement,
    season,
    state,
    explanation: explainState({
      state,
      observedJointCombos,
      capacityFeasibleCombos,
      undeterminedCombos,
      infeasibleCombos,
      combinations,
    }),
    frameUnitCount: entities.filter(e => uniqueProcesses.some(p => e.processes.includes(p))).length,
    capacityFeasibleCombinationCount: capacityFeasibleCombos.length,
    observedJointCount: observedJointCombos.length,
    observedJointUnitIds: [
      ...new Set(observedJointCombos.flatMap(c => c.units.map(u => u.entityId))),
    ],
    lowerBound: lower,
    cautiousUpperBound: upper,
    boundsNote: '下界为已观察联合可得的组合占比；上界保留未观察不可供的组合，仍不代表已观察联合可得',
    marginalProductUsed: false,
    legalWarning:
      '同一交货窗内并行工序需独立产能；共享设备的两项工序只能顺序占用，不能同时各记一份班次',
    observationSupport,
    undeterminedRange: {
      lower: lower ?? 0,
      upper: upper ?? 1,
      combinations: undeterminedCombos.map(c => ({
        units: c.units,
        why: c.gaps,
      })),
      why: '缺联合观察、窗口容量或并行班次证据',
    },
    combinations,
    holds,
    outletChecks,
  }
}

function enumerateAssignmentsRaw({ processes, entities, index, window, hoursRequired, requirement }) {
  const candidatesByProcess = processes.map(process =>
    entities.filter(e => e.processes.includes(process)).map(e => e.id),
  )
  const results = []
  const stack = []
  const walk = i => {
    if (i === processes.length) {
      const groups = new Map()
      for (const row of stack) {
        if (!groups.has(row.entityId)) groups.set(row.entityId, [])
        groups.get(row.entityId).push(row.process)
      }
      results.push({
        rows: [...groups.entries()].map(([entityId, assignedProcesses]) => ({
          entityId,
          assignedProcesses,
        })),
      })
      return
    }
    for (const entityId of candidatesByProcess[i]) {
      stack.push({ process: processes[i], entityId })
      walk(i + 1)
      stack.pop()
    }
  }
  walk(0)
  return results
}

function explainState({ state, observedJointCombos, capacityFeasibleCombos, undeterminedCombos, infeasibleCombos, combinations }) {
  if (state === JOINT_STATE.FEASIBLE) {
    return '存在容量可行且已联合观察的组合；仍受同窗口其他订单占用的约束'
  }
  if (state === JOINT_STATE.INFEASIBLE) {
    return `全部 ${combinations.length} 个组合都因容量不足或缺工序被排除，不能作为可承诺替代`
  }
  if (undeterminedCombos.some(c => c.options.some(o => o.scheduleState === JOINT_STATE.UNDETERMINED))) {
    return '部分工序需在同一窗口独立完成或顺序占用同一设备，但资料未给足可重叠班次或合计工时'
  }
  if (undeterminedCombos.some(c => c.capacityState === 'unknown')) {
    return '部分组合缺窗口容量记录，无法判断；不能按已有记录推定可行'
  }
  if (capacityFeasibleCombos.length > 0 && observedJointCombos.length === 0) {
    return `有 ${capacityFeasibleCombos.length} 个容量可行组合，但没有联合观察；不能由边际比例推断`
  }
  if (infeasibleCombos.length > 0) return '所有组合都缺窗口容量或工序，不能作为可承诺替代'
  return '证据不足，无法判断'
}

// 两家买方若被指向同线后的同一独立单位，须发现重复确认窗口。
export function detectDuplicateConfirmations({ commitments, entities, capacity }) {
  const index = capacityIndex(capacity)
  const claims = []

  for (const commitment of commitments) {
    if (commitment.status === '候选') continue
    for (const process of commitment.processes) {
      const options = entities
        .filter(e => e.processes.includes(process))
        .map(e => ({
          entityId: e.id,
          plants: e.plants,
          available: availableFor(index, e.id, process, commitment.window),
        }))
        .filter(o => o.available !== null)
      if (options.length === 0) continue
      const best = options.reduce((a, b) => (b.available > a.available ? b : a))
      claims.push({
        order: commitment.order,
        buyer: commitment.buyer,
        process,
        window: commitment.window,
        hours: commitment.hours,
        status: commitment.status,
        entityId: best.entityId,
        plants: best.plants,
        available: best.available,
        alternativeEntities: options.map(o => o.entityId),
      })
    }
  }

  const byEntityProcessWindow = new Map()
  for (const claim of claims) {
    const key = `${claim.entityId}|${claim.process}|${claim.window}`
    if (!byEntityProcessWindow.has(key)) byEntityProcessWindow.set(key, [])
    byEntityProcessWindow.get(key).push(claim)
  }

  const duplicates = []
  for (const [key, group] of byEntityProcessWindow) {
    const orders = [...new Set(group.map(g => g.order))]
    if (orders.length < 2) continue
    const buyers = [...new Set(group.map(g => g.buyer))]
    if (buyers.length < 2) continue
    const demand = group
      .filter(g => g.status === '已确认' || g.status === '待确认')
      .reduce((sum, g) => sum + g.hours, 0)
    const available = Math.max(...group.map(g => g.available))
    duplicates.push({
      key,
      entityId: group[0].entityId,
      plants: group[0].plants,
      process: group[0].process,
      window: group[0].window,
      orders,
      buyers,
      statuses: [...new Set(group.map(g => g.status))],
      demandHours: demand,
      availableHours: available,
      overbooked: demand > available,
      why:
        group[0].plants.length > 1
          ? '同线合并后这些订单指向同一独立单位，两家买方的确认窗口不能重复计算'
          : '同一单位同一窗口的产能被多个买方的订单共同占用',
      remedy: '按答复时点冻结各自可兑现范围；待审申请只保留已确认窗口，不得新增占用',
    })
  }

  // 同窗口跨工序的容量挤占：同一单位的合计可用产能不足以覆盖所有订单。
  const byEntityWindow = new Map()
  for (const claim of claims) {
    const key = `${claim.entityId}|${claim.window}`
    if (!byEntityWindow.has(key)) byEntityWindow.set(key, [])
    byEntityWindow.get(key).push(claim)
  }
  const capacityPressure = []
  for (const [key, group] of byEntityWindow) {
    const entitiesInGroup = [...new Set(group.map(g => g.entityId))]
    if (entitiesInGroup.length !== 1) continue
    const orderSet = new Map()
    for (const g of group) {
      if (!orderSet.has(g.order)) orderSet.set(g.order, { ...g, processes: [] })
      orderSet.get(g.order).processes.push(g.process)
    }
    if (orderSet.size < 2) continue
    const pressure = [...new Set(group.map(g => `${g.process}@${g.window}`))].map(pair => {
      const [process] = pair.split('@')
      const rows = group.filter(g => g.process === process)
      const demand = rows
        .filter(r => r.status === '已确认' || r.status === '待确认')
        .reduce((s, r) => s + r.hours, 0)
      const available = Math.max(...rows.map(r => r.available))
      return { process, window: rows[0].window, demand, available, overbooked: demand > available }
    }).filter(p => p.overbooked)
    if (pressure.length === 0) continue
    capacityPressure.push({
      entityId: entitiesInGroup[0],
      window: group[0].window,
      orders: [...orderSet.values()].map(o => ({ order: o.order, buyer: o.buyer, processes: o.processes, status: o.status })),
      pressure,
      note: '同一独立单位在同一窗口的产能不能既确认给一家又留给另一家',
    })
  }

  return { claims, duplicates, capacityPressure }
}
