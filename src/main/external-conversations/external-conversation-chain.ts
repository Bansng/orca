import {
  CONNECTOR_REFUSALS,
  refused,
  type ConnectorRefusal,
  type Delivery
} from './external-conversation-types'

type Lane = { controller: AbortController; signal: AbortSignal; tail: Promise<unknown> }

export function refusalOf(signal: AbortSignal): ConnectorRefusal {
  return CONNECTOR_REFUSALS.find((reason) => reason === signal.reason) ?? 'connectors_disabled'
}

/** Serialize each conversation; cancellation aborts its head and settles queued work without undoing prior writes. */
export class ConversationChain {
  private readonly lanes = new Map<string, Lane>()

  constructor(private readonly signal: AbortSignal) {}

  enqueue(id: string, run: (signal: AbortSignal) => Promise<Delivery>): Promise<Delivery> {
    const lane = this.lanes.get(id) ?? this.openLane(id)
    const previous = lane.tail
    const turn = new Promise<void>((resolve) => {
      const onAbort = (): void => resolve()
      lane.signal.addEventListener('abort', onAbort, { once: true })
      void previous.then(() => {
        lane.signal.removeEventListener('abort', onAbort)
        resolve()
      })
    })
    const result = turn.then(() =>
      lane.signal.aborted ? refused(refusalOf(lane.signal)) : run(lane.signal)
    )
    const tail = result.catch(() => undefined)
    lane.tail = tail
    void tail.then(() => {
      if (this.lanes.get(id) === lane && lane.tail === tail) {
        this.lanes.delete(id)
      }
    })
    return result
  }

  /** With laneSignal, cancel only that lane so a replacement lane remains untouched. */
  cancel(id: string, reason: ConnectorRefusal, laneSignal?: AbortSignal): void {
    const lane = this.lanes.get(id)
    if (!lane || (laneSignal && lane.signal !== laneSignal)) {
      return
    }
    this.lanes.delete(id)
    lane.controller.abort(reason)
  }

  private openLane(id: string): Lane {
    const controller = new AbortController()
    const lane: Lane = {
      controller,
      signal: AbortSignal.any([this.signal, controller.signal]),
      tail: Promise.resolve()
    }
    this.lanes.set(id, lane)
    return lane
  }
}
