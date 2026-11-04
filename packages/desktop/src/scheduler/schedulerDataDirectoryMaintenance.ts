import type { MainToSchedulerMessage, SchedulerToMainMessage } from "./schedulerProtocol.js";

export function createSchedulerDataDirectoryMaintenance(options: {
  pause: () => void;
  resume: () => void;
  hasPendingWork: () => boolean;
  close: () => void;
  postMessage: (message: SchedulerToMainMessage) => void;
  exit: () => void;
}) {
  let preparing = false;
  let closed = false;
  let reservedId: string | null = null;
  return {
    get preparing() {
      return preparing;
    },
    get closed() {
      return closed;
    },
    handleMessage(message: MainToSchedulerMessage): boolean {
      if (message.type === "scheduler-exit-data-migration") {
        if (closed) options.exit();
        return true;
      }
      if (
        message.type !== "scheduler-prepare-data-migration" &&
        message.type !== "scheduler-reserve-data-migration" &&
        message.type !== "scheduler-cancel-data-migration"
      )
        return false;
      const responseType =
        message.type === "scheduler-reserve-data-migration"
          ? "scheduler-data-migration-reserved"
          : message.type === "scheduler-cancel-data-migration"
            ? "scheduler-data-migration-cancelled"
            : "scheduler-data-migration-prepared";
      try {
        if (reservedId && reservedId !== message.requestId)
          throw new Error("Scheduler reservation mismatch");
        if (message.type === "scheduler-cancel-data-migration") {
          if (closed) throw new Error("Scheduler is already closed");
          reservedId = null;
          preparing = false;
          options.resume();
        } else {
          if (
            message.type === "scheduler-prepare-data-migration" &&
            reservedId !== message.requestId
          )
            throw new Error("Scheduler migration was not reserved");
          preparing = true;
          options.pause();
          if (options.hasPendingWork()) throw new Error("Scheduler still has pending work");
          if (message.type === "scheduler-reserve-data-migration") reservedId = message.requestId;
          else {
            options.close();
            closed = true;
          }
        }
        options.postMessage({ type: responseType, requestId: message.requestId, ok: true });
      } catch (error) {
        options.postMessage({
          type: responseType,
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    },
  };
}
