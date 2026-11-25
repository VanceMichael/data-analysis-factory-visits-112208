// 分层抽样估计。核心约束：
// 1. 抽签样本才进入概率估计；主动推荐、拒访、上门未核实都不能直接当分子。
// 2. 走访结果只描述已入样单位，不自动外推为整个园区。
// 3. 同一独立能力单位（同线合并后）只算一个样本单位，避免两个品牌算两份。
// 4. 未知结果给出上下界，而不是点估计。

import { combineIncludeProbability } from './links.js'

export const DEFAULT_SAMPLING_CONFIG = {
  minObservedUnits: 2,
  minCoverage: 1,
  minResponse: 0.8,
}

export const RESULT_AVAILABLE = '可供'
export const RESULT_UNAVAILABLE = '不可供'

// 判断一条访问记录能支持哪类推断。
export function classifySample(row) {
  const flags = new Set()
  let designEligible = false
  let outcome = null
  let disposition = 'no-outcome'

  if (row.method === '抽签') {
    if (row.p === null || !(row.p > 0) || row.p > 1) {
      disposition = 'invalid-probability'
    } else {
      designEligible = true
    }
  } else {
    disposition = 'nonprobability'
    flags.add('非概率样本')
  }

  if (row.visit === '拒绝') {
    disposition = 'refused'
    flags.add('拒访')
  } else if (row.visit === '未核') {
    disposition = 'unverified'
    flags.add('上门未核实')
  } else if (row.visit === '完成') {
    if (row.result === RESULT_AVAILABLE) {
      outcome = true
      // 非概率来源即便完成，也保留其"非概率"性质；disposition 只描述访问结果，
      // 是否可进入概率分子由 designEligible 单独决定。
      if (designEligible) disposition = 'observed'
      else {
        disposition = 'nonprobability'
        flags.add('仅作发现，不入概率估计')
      }
    } else if (row.result === RESULT_UNAVAILABLE) {
      outcome = false
      if (designEligible) disposition = 'observed'
      else {
        disposition = 'nonprobability'
        flags.add('仅作发现，不入概率估计')
      }
    } else {
      disposition = designEligible ? 'no-outcome' : 'nonprobability'
      flags.add('结果缺失')
    }
  } else {
    flags.add('访问状态未知')
  }

  if (designEligible && outcome === null) flags.add('有入样概率但无有效结果')

  return {
    disposition,
    designEligible,
    outcome,
    usableForDesignNumerator: designEligible && outcome !== null,
    flags: [...flags],
  }
}

function entityOutcome(rows) {
  const observed = rows.filter(r => r.outcome !== null)
  const available = observed.filter(r => r.outcome === true).length
  const unavailable = observed.filter(r => r.outcome === false).length
  if (available > 0 && unavailable > 0) {
    return { outcome: null, conflict: true, available, unavailable }
  }
  if (available > 0) return { outcome: true, conflict: false, available, unavailable }
  if (unavailable > 0) return { outcome: false, conflict: false, available, unavailable }
  return { outcome: null, conflict: false, available, unavailable }
}

function unitDisposition(entityRows, entityOutcomeValue, designP) {
  if (entityOutcomeValue !== null) return 'observed'
  if (entityRows.some(r => r.disposition === 'refused')) return 'refused'
  if (entityRows.some(r => r.disposition === 'unverified')) return 'unverified'
  if (entityRows.some(r => r.classification.conflict)) return 'conflict'
  if (designP !== null) return 'no-outcome'
  if (entityRows.length > 0) return 'nonprobability-only'
  return 'not-drawn'
}

// 计算一个工序的估计。entities 为同线合并后的独立单位。
export function estimateProcess({
  process,
  entities,
  samples,
  season,
  config = DEFAULT_SAMPLING_CONFIG,
}) {
  const frameUnits = entities.filter(e => e.processes.includes(process))
  const rowsByEntity = new Map()

  for (const sample of samples) {
    if (season && sample.season !== season) continue
    if (!sample.processesAsked.includes(process)) continue
    const entity = entities.find(e => e.plants.includes(sample.plant))
    if (!entity) continue
    if (!rowsByEntity.has(entity.id)) rowsByEntity.set(entity.id, [])
    const classification = classifySample(sample)
    rowsByEntity.get(entity.id).push({ sample, ...classification, entityId: entity.id })
  }

  const units = []
  for (const entity of frameUnits) {
    const rows = rowsByEntity.get(entity.id) ?? []
    const validPs = rows
      .filter(r => r.designEligible)
      .map(r => r.sample.p)
    // 同线两个厂各自被抽中时，按单位合并入样概率，而不是各记一个权重。
    const designP = combineIncludeProbability(validPs)
    const outcomeInfo = entityOutcome(rows)
    const disposition = unitDisposition(rows, outcomeInfo.outcome, designP)
    const weight = designP !== null ? 1 / designP : null
    // 同线单位里哪些厂真正提供了有效结果，便于顾问看到结论只由其中一端支撑。
    const observedPlants = rows.filter(r => r.outcome !== null).map(r => r.sample.plant)
    units.push({
      entityId: entity.id,
      plants: entity.plants,
      process,
      designP,
      weight,
      outcome: outcomeInfo.outcome,
      conflict: outcomeInfo.conflict,
      disposition,
      draws: rows.length,
      observedPlants,
      weakenedByMerge:
        entity.plants.length > 1
          ? `同线合并后按 1 个独立单位计；本工序有效结果来自 ${observedPlants.join('、') || '无'}`
          : undefined,
      rows: rows.map(r => ({
        plant: r.sample.plant,
        method: r.sample.method,
        p: r.sample.p,
        visit: r.sample.visit,
        result: r.sample.result,
        disposition: r.disposition,
        flags: r.flags,
      })),
    })
  }

  const observedUnits = units.filter(u => u.outcome !== null && u.weight !== null)
  const unresolvedUnits = units.filter(
    u => u.outcome === null && u.weight !== null && u.disposition !== 'not-drawn',
  )
  const coveredUnits = units.filter(u => u.designP !== null)
  const weightedObserved = observedUnits.reduce((s, u) => s + u.weight, 0)
  const weightedYes = observedUnits
    .filter(u => u.outcome === true)
    .reduce((s, u) => s + u.weight, 0)
  const weightedUnknown = unresolvedUnits.reduce((s, u) => s + u.weight, 0)

  const coveredEstimate =
    weightedObserved > 0 ? weightedYes / weightedObserved : null
  const unresolvedWeight = weightedObserved + weightedUnknown
  const coveredBounds =
    unresolvedWeight > 0
      ? {
          lower: weightedYes / unresolvedWeight,
          upper: (weightedYes + weightedUnknown) / unresolvedWeight,
        }
      : coveredEstimate === null
        ? null
        : { lower: coveredEstimate, upper: coveredEstimate }

  const availableObserved = units.filter(u => u.outcome === true).length
  const unavailableObserved = units.filter(u => u.outcome === false).length
  const frameSize = units.length
  // 园区范围上下界：按独立单位计数，避免用走访比例直接冒充整个园区。
  const frameBounds =
    frameSize === 0
      ? null
      : {
          lower: availableObserved / frameSize,
          upper: (frameSize - unavailableObserved) / frameSize,
        }

  const coverage = frameSize > 0 ? coveredUnits.length / frameSize : 0
  // 有效访问率只针对"有入样概率且确实被访问过"的单位；没被抽中的单位不计入分母。
  const attemptedDesignUnits = units.filter(
    u => u.designP !== null && u.rows.length > 0,
  )
  const response =
    attemptedDesignUnits.length > 0
      ? observedUnits.length / attemptedDesignUnits.length
      : null
  const nonProbabilityUnits = units.filter(u => u.disposition === 'nonprobability-only').length
  const smallSample =
    observedUnits.length < Math.min(config.minObservedUnits, Math.max(frameSize, 1))
  const coverageOk = coverage >= config.minCoverage
  const responseOk = response !== null && response >= config.minResponse

  const reasons = []
  if (!coverageOk) reasons.push(`抽样覆盖 ${Math.round(coverage * 100)}% < 门槛`)
  if (!responseOk) reasons.push(`有效访问率 ${response === null ? '无' : Math.round(response * 100) + '%'} < 门槛`)
  if (smallSample) reasons.push(`有效独立单位仅 ${observedUnits.length} 个`)
  if (nonProbabilityUnits > 0) reasons.push(`${nonProbabilityUnits} 个单位只有推荐/非概率来源`)
  if (units.some(u => u.conflict)) reasons.push('同线单位内出现矛盾结果')
  if (unresolvedUnits.length > 0) reasons.push(`${unresolvedUnits.length} 个单位结果未知`)

  return {
    process,
    season,
    frameSize,
    sampledUnits: units,
    observedUnits: observedUnits.length,
    unresolvedUnits: unresolvedUnits.length,
    coveredUnits: coveredUnits.length,
    nonProbabilityUnits,
    coverage,
    response,
    visitedQualifiedShare:
      availableObserved + unavailableObserved > 0
        ? availableObserved / (availableObserved + unavailableObserved)
        : null,
    coveredEstimate,
    coveredBounds,
    wholeParkBounds: frameBounds,
    canClaimWholePark: coverageOk && responseOk && !smallSample && !units.some(u => u.conflict),
    claimScope: '仅描述已入样且有效访问的独立单位，不外推整个园区',
    wholeParkClaimBlockedBy: reasons,
    verifiedAvailableUnits: units.filter(u => u.outcome === true).map(u => u.entityId),
    verifiedUnavailableUnits: units.filter(u => u.outcome === false).map(u => u.entityId),
    unresolvedUnitIds: unresolvedUnits.map(u => u.entityId),
    config,
  }
}

export function estimateAll({ entities, samples, season, processes, config }) {
  const target = processes ?? [...new Set(entities.flatMap(e => e.processes))].sort()
  return Object.fromEntries(
    target.map(process =>
      [
        process,
        estimateProcess({ process, entities, samples, season, config }),
      ],
    ),
  )
}

// "独立可替代能力"按单位计数，而不是按厂/品牌计数。
export function independentCapacityCount(estimate, process, entities) {
  const ids = new Set(estimate.verifiedAvailableUnits)
  return entities.filter(e => ids.has(e.id) && e.processes.includes(process)).length
}

// 支撑登记：告诉顾问某工序的结论建立在哪类证据上，避免把走访合格率当园区合格率。
export function evidenceTier(estimate) {
  if (estimate.canClaimWholePark) return '概率样本 + 覆盖充分'
  if (estimate.coveredEstimate !== null) return '概率样本，但仅覆盖已入样范围'
  if (estimate.observedUnits > 0) return '仅走访发现，不可作概率推断'
  return '无有效证据'
}
