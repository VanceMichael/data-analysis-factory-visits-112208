// 答复留证与回执：已发给买方的可兑现范围按答复时点冻结，
// 新回执只改变下一轮的访问优先级，不追溯改写已发出的结论。
// 审查中的采购申请必须保留一段已确认窗口。

import { createHash } from 'node:crypto'

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12)
}

export function snapshotAnswer({ buyer, jointKey, result, answeredAt, disclosureLevel }) {
  const frozen = {
    buyer,
    jointKey,
    answeredAt,
    disclosureLevel,
    processes: result.processes,
    window: result.window,
    state: result.state,
    committableRange: {
      lower: result.lowerBound,
      upper: result.cautiousUpperBound,
      note: result.boundsNote,
    },
    observedSupport: {
      jointUnits: result.observedJointCount,
      unitIds: result.observedJointUnitIds,
    },
    caveats: result.explanation,
  }
  return {
    ...frozen,
    evidenceId: stableHash(frozen),
    frozenAt: answeredAt,
    immutable: true,
  }
}

export function verifySnapshot(snapshot) {
  const { evidenceId, frozenAt, immutable, ...rest } = snapshot
  return {
    evidenceId,
    valid: stableHash(rest) === evidenceId,
    frozenAt,
    immutable,
  }
}

// 新回执：可能改变下轮访问优先级，但不能改动既往答复。
export function applyReceipt({ receipt, previousSnapshots = [], jointResults = {} }) {
  const changed = []
  const priorityShifts = []
  for (const [key, result] of Object.entries(jointResults)) {
    if (!result.processes.some(p => receipt.processes.includes(p))) continue
    // 只和同一联合结论的既往答复比对，避免把含有相同工序的其他结论误报为"改变"。
    const previous = previousSnapshots.filter(s => s.jointKey === key)
    const latest = previous[previous.length - 1]
    if (latest && latest.state !== result.state) {
      changed.push({
        key,
        previousState: latest.state,
        currentState: result.state,
        evidenceId: latest.evidenceId,
        note: '既往答复保留原状；新状态只用于下一轮',
      })
    }
    priorityShifts.push({
      key,
      processes: result.processes,
      deltaReason: receipt.reason,
      nextRoundPriority: receipt.outcome === '拒绝' ? '需补两端兼查' : '核对窗口容量',
    })
  }
  return {
    receiptId: receipt.receiptId,
    receivedAt: receipt.receivedAt,
    doesNotRewritePastAnswers: true,
    changedConclusions: changed,
    priorityShifts,
  }
}

// 审查中的采购申请：保留一段已确认窗口，不能把已确认额度全部让给新订单。
export function retainReviewedWindow({
  commitments,
  applications,
  capacity,
  reserveHours = 1,
}) {
  return applications.map(app => {
    const related = commitments.filter(
      c =>
        c.status === '已确认' &&
        c.window === app.window &&
        c.processes.some(p => app.processes.includes(p)),
    )
    const reserved = related.map(c => ({
      order: c.order,
      buyer: c.buyer,
      hours: c.hours,
      keepHours: Math.min(c.hours, reserveHours),
      status: c.status,
    }))
    const available = capacity
      .filter(c => c.window === app.window && app.processes.includes(c.process))
      .reduce((max, c) => Math.max(max, c.available ?? 0), 0)
    const retainedTotal = reserved.reduce((sum, r) => sum + r.keepHours, 0)
    return {
      application: app.id,
      buyer: app.buyer,
      window: app.window,
      processes: app.processes,
      requestedHours: app.hours,
      confirmedWindowRetained: reserved,
      retainedHours: retainedTotal,
      reviewableHours: Math.max(0, available - retainedTotal),
      decision:
        available - retainedTotal >= app.hours
          ? '可进入审查'
          : '审查中：已确认窗口需保留，可用额度不足',
      note: '新回执可调整下轮优先级，但在审申请保留一段已确认窗口',
    }
  })
}

// 买方在受限资料失效后仍可知"哪类工序无法对外承诺"，但不得反推受限产量。
export function buyerRestrictedView({ processStates, publicWindows, restrictedTotalsSuppressed = true }) {
  return {
    processStates,
    publicWindows,
    restrictedTotals: restrictedTotalsSuppressed ? null : undefined,
    canKnowNonCommittableProcessTypes: true,
    antiDifferencing: {
      suppressed: restrictedTotalsSuppressed,
      forbiddenQuery: '公开窗口产量与受限厂总量的差值',
      note: '买方视图不提供受限厂总量，因此无法通过公开窗口做差还原',
    },
  }
}
