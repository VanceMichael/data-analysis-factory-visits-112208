// 把解析后的资料串成一条可追问的结论链：
// 抽样覆盖 → 现场核实 → 联合证明 → 披露许可 → 下一轮名单 → 答复留证。
// 顾问对任一候选工序都可追问"缺的是哪一类证据"，并看到后续访问如何改变结论。

import { estimateAll, estimateProcess, evidenceTier } from './stats.js'
import { buildEntities, reconcileCapacity } from './links.js'
import { jointSupply, detectDuplicateConfirmations, JOINT_STATE } from './joint.js'
import { planNextRound, disclosureView } from './allocation.js'
import { snapshotAnswer, applyReceipt, retainReviewedWindow } from './receipts.js'

// 联合供货的组来自订单需求与买方需求。
export function jointPairs(data) {
  const groups = []
  for (const commitment of data.commitments) {
    if (commitment.processes.length < 2) continue
    groups.push({
      key: `${commitment.order}:${commitment.processes.join('+')}`,
      processes: commitment.processes,
      window: commitment.window,
      hoursRequired: commitment.hours,
      requirement: commitment.requirement,
      source: `订单 ${commitment.order}`,
      buyer: commitment.buyer,
    })
  }
  for (const outlet of data.outlets) {
    if (outlet.need.length < 2) continue
    const exists = groups.some(g => g.processes.join('+') === outlet.need.join('+'))
    if (!exists) {
      const commitment = data.commitments.find(
        c => c.processes.join('+') === outlet.need.join('+'),
      )
      groups.push({
        key: `${outlet.buyer}:${outlet.need.join('+')}`,
        processes: outlet.need,
        window: commitment?.window ?? 'W1',
        hoursRequired: commitment?.hours ?? 2,
        requirement: commitment?.requirement ?? '并行',
        source: `买方需求 ${outlet.buyer}`,
        buyer: outlet.buyer,
      })
    }
  }
  return groups
}

export function buildProject(rawData, options = {}) {
  const season = options.season ?? null
  const capacityLookup = options.capacity ?? rawData.capacity
  // 身份修正按已知时点应用；season 只筛选访问记录，不推翻已核实的同线结论。
  const linkInfo = buildEntities(rawData.frame, rawData.link_updates, { asOfSeason: season })
  const capacity = reconcileCapacity(capacityLookup, linkInfo.plantToEntity)
  const estimates = estimateAll({
    entities: linkInfo.entities,
    samples: rawData.samples,
    season,
    config: options.samplingConfig,
  })

  const jointResults = {}
  for (const group of jointPairs(rawData)) {
    const result = jointSupply({
      processes: group.processes,
      entities: linkInfo.entities,
      samples: rawData.samples,
      season,
      capacity,
      commitments: rawData.commitments,
      window: group.window,
      hoursRequired: group.hoursRequired,
      requirement: group.requirement,
      outlets: rawData.outlets,
    })
    jointResults[group.key] = { ...result, group }
  }

  const duplicates = detectDuplicateConfirmations({
    commitments: rawData.commitments,
    entities: linkInfo.entities,
    capacity,
  })

  const nextRound = planNextRound({
    frame: rawData.frame,
    entities: linkInfo.entities,
    samples: rawData.samples,
    linkInfo,
    routes: rawData.routes,
    jointResults,
    season,
    config: options.allocationConfig,
  })

  return {
    season,
    frame: rawData.frame,
    samples: rawData.samples,
    commitments: rawData.commitments,
    linkInfo,
    capacity,
    estimates,
    jointResults,
    duplicates,
    nextRound,
  }
}

// 候选工序证据面板：回答"缺抽样覆盖、联合证明，还是披露许可"。
export function explainCandidate(project, { process, processes, readerLevel = '公开' }) {
  const jointProcesses = processes ?? [process]
  const estimate = estimateProcess({
    process: jointProcesses[0],
    entities: project.linkInfo.entities,
    samples: project.samples ?? [],
    season: project.season,
  })

  // 先精确匹配整组；只给单工序时，找出包含它的联合组，让顾问看到该工序的联合证明缺在哪。
  const exact = Object.entries(project.jointResults).find(
    ([, r]) => r.processes.join('+') === jointProcesses.join('+'),
  )
  const containing = processes
    ? []
    : Object.entries(project.jointResults).filter(
        ([, r]) => r.processes.includes(jointProcesses[0]) && r.processes.length > 1,
      )
  const jointEntry = exact ?? containing[0]
  const relatedJointEntries = exact ? [] : containing

  const gaps = {
    samplingCoverage: [],
    jointProof: [],
    disclosurePermission: [],
  }

  if (estimate.coverage < 1) {
    gaps.samplingCoverage.push({
      detail: `分层覆盖 ${Math.round(estimate.coverage * 100)}%`,
      remedy: '把未覆盖分层的独立单位排入下一轮',
    })
  }
  if (
    estimate.observedUnits <
    Math.min(estimate.config?.minObservedUnits ?? 2, Math.max(estimate.frameSize, 1))
  ) {
    gaps.samplingCoverage.push({
      detail: `有效访问独立单位 ${estimate.observedUnits} 个`,
      remedy: '增加抽签访问并记录结果',
    })
  }
  if (estimate.nonProbabilityUnits > 0) {
    gaps.samplingCoverage.push({
      detail: `${estimate.nonProbabilityUnits} 个单位只有推荐来源`,
      remedy: '对推荐单位补入样概率来源的抽签访问',
    })
  }

  if (jointEntry) {
    const result = jointEntry[1]
    if (result.state !== JOINT_STATE.FEASIBLE) {
      gaps.jointProof.push({
        key: jointEntry[0],
        detail: result.explanation,
        observedJointUnits: result.observedJointCount,
        missingProcesses: result.observationSupport.unobservedProcesses,
        remedy: '需要同一独立单位、同一交货窗口对整组工序的联合观察',
      })
    }
  }
  // 单工序提问时，其他包含该工序的联合组若同样不能判断，也应提示。
  for (const [key, result] of relatedJointEntries) {
    if (key === jointEntry?.[0]) continue
    if (result.state === JOINT_STATE.FEASIBLE) continue
    gaps.jointProof.push({
      key,
      detail: result.explanation,
      observedJointUnits: result.observedJointCount,
      missingProcesses: result.observationSupport.unobservedProcesses,
      remedy: '同一交货窗口下的联合组仍需联合观察或窗口容量证据',
    })
  }

  const restrictedUnits = estimate.sampledUnits
    .filter(u => project.linkInfo.entities.find(e => e.id === u.entityId)?.restricted)
  if (readerLevel !== '受限' && restrictedUnits.length > 0) {
    gaps.disclosurePermission.push({
      detail: '存在受限明细，当前读者许可不足',
      remedy: '由持受限许可的顾问访问并只向买方给宏观结论',
    })
  }

  const missingKinds = Object.entries(gaps)
    .filter(([, items]) => items.length > 0)
    .map(([kind]) => kind)

  return {
    asked: { process, processes: jointProcesses, readerLevel },
    evidenceTier: evidenceTier(estimate),
    estimate: {
      visitedQualifiedShare: estimate.visitedQualifiedShare,
      observedUnits: estimate.observedUnits,
      coverage: estimate.coverage,
      canClaimWholePark: estimate.canClaimWholePark,
    },
    joint: jointEntry
      ? {
          key: jointEntry[0],
          state: jointEntry[1].state,
          lower: jointEntry[1].lowerBound,
          upper: jointEntry[1].cautiousUpperBound,
          observedJointCount: jointEntry[1].observedJointCount,
        }
      : null,
    gaps,
    missing: missingKinds,
    answer:
      missingKinds.length === 0
        ? '当前证据足以支持已访范围内的陈述'
        : `缺 ${missingKinds.map(kindLabel).join('、')}`,
    howNextVisitsChangeConclusion: project.nextRound.assigned
      .filter(item => jointProcesses.some(p => item.reason.includes(p)))
      .map(item => ({ entityId: item.entityId, advisor: item.advisor, reason: item.reason })),
  }
}

function kindLabel(kind) {
  return { samplingCoverage: '抽样覆盖', jointProof: '联合供货证明', disclosurePermission: '披露许可' }[kind]
}

// 完整视图：给顾问的项目面板 + 给买方的披露视图。
export function projectView(rawData, options = {}) {
  const project = buildProject(rawData, options)
  const view = disclosureView({
    readerLevel: options.readerLevel ?? '公开',
    frame: rawData.frame,
    entities: project.linkInfo.entities,
    estimates: project.estimates,
    jointResults: project.jointResults,
    capacity: project.capacity,
    commitments: rawData.commitments,
  })
  return { ...project, view }
}

// 把某一联合结论按答复时点冻结，并接收新回执。
export function answerAndReceive({ project, jointKey, buyer, answeredAt, receipt }) {
  const result = project.jointResults[jointKey]
  if (!result) throw new Error(`未知联合结论: ${jointKey}`)
  const snapshots = [
    snapshotAnswer({ buyer, jointKey, result, answeredAt, disclosureLevel: '公开' }),
  ]
  const receiptImpact = receipt
    ? applyReceipt({ receipt, previousSnapshots: snapshots, jointResults: project.jointResults })
    : null
  return { snapshots, receiptImpact }
}

export function reviewWindowAlignment({ commitments, applications, capacity }) {
  return retainReviewedWindow({ commitments, applications, capacity })
}
