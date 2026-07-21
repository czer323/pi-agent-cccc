// oxlint-disable typescript/unbound-method
import { expect, test, vi, describe, beforeEach, afterEach } from "vite-plus/test";
import { InboxQueue } from "../src/inbox-queue.ts";

// ---- helpers ----

function createMockPi() {
  const sendMessage = vi.fn();
  const pi = { sendMessage } as any;
  return { pi, sendMessage };
}

function createMockCtx(isIdle: boolean = true) {
  return { isIdle: vi.fn(() => isIdle) } as any;
}

function createQueue(
  overrides?: Partial<{ pi: any; ctx: any }>,
) {
  const { pi, sendMessage } = createMockPi();
  const ctx = createMockCtx(true);
  return {
    queue: new InboxQueue({
      pi: overrides?.pi ?? pi,
      ctx: overrides?.ctx ?? ctx,
    }),
    sendMessage: overrides?.pi?.sendMessage ?? sendMessage,
    ctx: overrides?.ctx ?? ctx,
  };
}

function makeMsg(overrides?: { content?: string; details?: Record<string, unknown>; onDelivered?: () => void }) {
  return {
    content: overrides?.content ?? "New CCCC message from alice:\n\nHello\n\n---\nReply to this...",
    details: overrides?.details ?? { groupId: "g1", eventId: "e1", by: "alice", text: "Hello" },
    onDelivered: overrides?.onDelivered,
  };
}

// ---- tests ----

describe("InboxQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("enqueue schedules a flush with debounce delay", () => {
    const { queue, sendMessage } = createQueue();
    const timerSpy = vi.spyOn(globalThis, "setTimeout");

    queue.enqueue(makeMsg());

    // Should have scheduled a flush
    expect(timerSpy).toHaveBeenCalledTimes(1);
    expect(timerSpy).toHaveBeenCalledWith(expect.any(Function), 200);
    expect(sendMessage).not.toHaveBeenCalled(); // Not flushed yet
  });

  test("debounce: multiple enqueues within 200ms coalesce into one flush", () => {
    const { queue, sendMessage } = createQueue();

    queue.enqueue(makeMsg({ details: { eventId: "e1" } }));
    queue.enqueue(makeMsg({ details: { eventId: "e2" } }));
    queue.enqueue(makeMsg({ details: { eventId: "e3" } }));

    // Advance just past the debounce window
    vi.advanceTimersByTime(201);

    // All three should be delivered in one sendMessage call
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "cccc-inbox",
        display: true,
      }),
      { triggerTurn: true },
    );
  });

  test("debounce: flush timer is reset on each enqueue", () => {
    const { queue, sendMessage } = createQueue();

    queue.enqueue(makeMsg({ details: { eventId: "e1" } }));
    vi.advanceTimersByTime(100); // Half the debounce window
    queue.enqueue(makeMsg({ details: { eventId: "e2" } }));
    vi.advanceTimersByTime(100); // Only 100ms since last enqueue — still within window
    expect(sendMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(101); // Now 201ms since last enqueue
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("idle gate: defers delivery when agent is busy, retries every 500ms", () => {
    const ctx = createMockCtx(false); // Busy
    const { queue, sendMessage } = createQueue({ ctx });

    queue.enqueue(makeMsg());

    // Advance past debounce
    vi.advanceTimersByTime(201);

    // Agent is busy — should not deliver yet
    expect(sendMessage).not.toHaveBeenCalled();
    expect(ctx.isIdle).toHaveBeenCalled();

    // Make agent idle now
    ctx.isIdle.mockReturnValue(true);
    vi.advanceTimersByTime(500); // Retry interval

    // Now it should deliver
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("idle gate: keeps retrying while agent remains busy", () => {
    const ctx = createMockCtx(false); // Stays busy
    const { queue, sendMessage } = createQueue({ ctx });

    queue.enqueue(makeMsg());

    // Past debounce
    vi.advanceTimersByTime(201);
    expect(sendMessage).not.toHaveBeenCalled();

    // Retry 1
    vi.advanceTimersByTime(500);
    expect(sendMessage).not.toHaveBeenCalled();

    // Retry 2
    vi.advanceTimersByTime(500);
    expect(sendMessage).not.toHaveBeenCalled();

    // Retry 3 — now agent becomes idle
    ctx.isIdle.mockReturnValue(true);
    vi.advanceTimersByTime(500);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("batch: up to 20 messages per delivery", () => {
    const { queue, sendMessage } = createQueue();

    // Enqueue 25 messages
    for (let i = 0; i < 25; i++) {
      queue.enqueue(makeMsg({ details: { eventId: `e${i}` } }));
    }

    vi.advanceTimersByTime(201);

    // First batch should have exactly 20 messages
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = sendMessage.mock.calls[0][0];
    expect(call.content).toContain("[CCCC: 20 message(s) received]");

    // Should have 5 remaining
    vi.advanceTimersByTime(500);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const call2 = sendMessage.mock.calls[1][0];
    expect(call2.content).toContain("[CCCC: 5 message(s) received]");
  });

  test("batch: respects char cap (~16K chars)", () => {
    const { queue, sendMessage } = createQueue();

    // Create 5 messages of ~5K chars each
    for (let i = 0; i < 5; i++) {
      const text = "x".repeat(5000);
      queue.enqueue(makeMsg({
        content: `New CCCC message from alice:\n\n${text}\n\n---\nReply...`,
        details: { eventId: `e${i}` },
      }));
    }

    vi.advanceTimersByTime(201);

    // First batch should have ~3 messages (< 16K), next batch the rest
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const content = sendMessage.mock.calls[0][0].content;
    expect(content).toMatch(/\[CCCC: [23] message\(s\) received\]/);

    // Eventually all delivered
    vi.advanceTimersByTime(2000);
    expect(sendMessage).toHaveBeenCalledTimes(2); // 3 + 2
  });

  test("single message uses individual formatting (no batch header)", () => {
    const { queue, sendMessage } = createQueue();

    queue.enqueue(makeMsg({
      content: "New CCCC message from alice:\n\nHello\n\n---\nReply to this...",
      details: { eventId: "e1" },
    }));

    vi.advanceTimersByTime(201);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = sendMessage.mock.calls[0][0];
    expect(call.content).toBe("New CCCC message from alice:\n\nHello\n\n---\nReply to this...");
    expect(call.details).not.toHaveProperty("batched");
  });

  test("multiple messages use batch header", () => {
    const { queue, sendMessage } = createQueue();

    queue.enqueue(makeMsg({
      content: "msg1",
      details: { eventId: "e1" },
    }));
    queue.enqueue(makeMsg({
      content: "msg2",
      details: { eventId: "e2" },
    }));

    vi.advanceTimersByTime(201);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = sendMessage.mock.calls[0][0];
    expect(call.content).toContain("[CCCC: 2 message(s) received]");
    expect(call.content).toContain("msg1");
    expect(call.content).toContain("msg2");
    expect(call.details).toEqual({
      batched: true,
      count: 2,
      messages: [
        { eventId: "e1" },
        { eventId: "e2" },
      ],
    });
  });

  test("onDelivered is called for each item after batch delivery", () => {
    const { queue } = createQueue();
    const delivered1 = vi.fn();
    const delivered2 = vi.fn();

    queue.enqueue(makeMsg({ onDelivered: delivered1, details: { eventId: "e1" } }));
    queue.enqueue(makeMsg({ onDelivered: delivered2, details: { eventId: "e2" } }));

    vi.advanceTimersByTime(201);

    expect(delivered1).toHaveBeenCalledTimes(1);
    expect(delivered2).toHaveBeenCalledTimes(1);
  });

  test("wake() schedules immediate flush (delay 0)", () => {
    const { queue } = createQueue();
    const timerSpy = vi.spyOn(globalThis, "setTimeout");

    queue.enqueue(makeMsg());
    queue.wake();

    // Should have scheduled a flush at delay 0 (and the original debounce timer was cleared)
    expect(timerSpy).toHaveBeenLastCalledWith(expect.any(Function), 0);
  });

  test("destroy() clears timers and prevents delivery", () => {
    const { queue, sendMessage } = createQueue();

    queue.enqueue(makeMsg());
    queue.destroy();

    vi.advanceTimersByTime(5000);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("stale context during idle check bails gracefully", () => {
    const ctx = createMockCtx(true);
    // Make isIdle throw (stale context)
    ctx.isIdle.mockImplementation(() => {
      throw new Error("stale context");
    });
    const { queue, sendMessage } = createQueue({ ctx });

    queue.enqueue(makeMsg());
    vi.advanceTimersByTime(201);

    // Should not deliver, should not throw
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("delivery error does not crash the queue", () => {
    const pi = { sendMessage: vi.fn(() => { throw new Error("delivery failed"); }) };
    const ctx = createMockCtx(true);

    const queue = new InboxQueue({ pi: pi as any, ctx });
    queue.enqueue(makeMsg({
      details: { eventId: "e1" },
      onDelivered: undefined,
    }));

    vi.advanceTimersByTime(201);

    // Should not throw, items remain in queue
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("flush on agent_end via wake() works when busy then idle", () => {
    const ctx = createMockCtx(false); // busy
    const { queue, sendMessage } = createQueue({ ctx });

    queue.enqueue(makeMsg());

    // Simulate agent_end: wake() schedules flush(0)
    queue.wake();

    // Past the macrotask
    vi.advanceTimersByTime(1);

    // Agent is still busy — should retry, not deliver
    expect(sendMessage).not.toHaveBeenCalled();

    // Make idle
    ctx.isIdle.mockReturnValue(true);
    vi.advanceTimersByTime(500);

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
