import type { ServiceCollection } from "./collection.js";
import { IZCodeAgentService } from "./zcode-agent/zcodeAgent.js";
import { IBotsService } from "./bots/bots.js";
import { IOffPeakTaskService } from "./session/offPeakTask.js";

interface MigrationParticipant {
  reserveForDataDirectoryMigration(): void | Promise<void>;
  cancelDataDirectoryMigration(): void | Promise<void>;
}

interface Reservation {
  phase: "reserving" | "reserved" | "cancelled" | "closing";
  owners: MigrationParticipant[];
  reservePending: boolean;
  cancellationComplete: boolean;
  cancelling?: Promise<void>;
}
const reservations = new WeakMap<ServiceCollection, Reservation>();

function participants(services: ServiceCollection): MigrationParticipant[] {
  return [
    services.getOptional(IOffPeakTaskService),
    services.getOptional(IBotsService),
    services.getOptional(IZCodeAgentService),
  ]
    .filter((service) => service !== undefined)
    .map((service) => {
      const participant = service as unknown as Partial<MigrationParticipant>;
      if (
        !participant.reserveForDataDirectoryMigration ||
        !participant.cancelDataDirectoryMigration
      ) {
        throw new Error(
          "DATA_DIRECTORY_UNSUPPORTED: A service has no reversible maintenance protocol",
        );
      }
      return participant as MigrationParticipant;
    });
}

function releaseCancelledReservation(services: ServiceCollection, reservation: Reservation): void {
  if (
    reservations.get(services) === reservation &&
    reservation.phase === "cancelled" &&
    reservation.cancellationComplete &&
    !reservation.reservePending
  )
    reservations.delete(services);
}

function cancelReservation(services: ServiceCollection, reservation: Reservation): Promise<void> {
  if (reservation.phase === "closing")
    return Promise.reject(new Error("DATA_DIRECTORY_ALREADY_CLOSING"));
  if (reservation.cancelling) return reservation.cancelling;
  if (reservation.cancellationComplete) return Promise.resolve();
  // 先使token失效；cancel不等待旧reserve，迟到的结果也不能继续预留下一owner或恢复reserved。
  reservation.phase = "cancelled";
  const cancelling = (async () => {
    const results = await Promise.allSettled(
      reservation.owners.map(async (owner) => owner.cancelDataDirectoryMigration()),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "DATA_DIRECTORY_CANCEL_FAILED",
      );
    reservation.cancellationComplete = true;
    services.cancelDataDirectoryMaintenance();
    // 入口立即恢复，但旧reserve未结束前保留token占位，防止下一轮与旧参与者交错。
    releaseCancelledReservation(services, reservation);
  })();
  reservation.cancelling = cancelling;
  void cancelling
    .finally(() => {
      if (reservation.cancelling === cancelling) reservation.cancelling = undefined;
    })
    .catch(() => undefined);
  return cancelling;
}

/** reserve 不关闭资源；所有 Host 成功前，已 accepted 工作必须仍能完成。 */
export async function reserveDataDirectoryMigration(services: ServiceCollection): Promise<void> {
  if (reservations.get(services)?.phase === "reserved") return;
  if (reservations.has(services))
    throw new Error("DATA_DIRECTORY_BUSY: Service maintenance is in progress");
  const reservation: Reservation = {
    phase: "reserving",
    owners: participants(services),
    reservePending: true,
    cancellationComplete: false,
  };
  reservations.set(services, reservation);
  try {
    services.beginDataDirectoryMaintenance();
    for (const owner of reservation.owners) {
      await owner.reserveForDataDirectoryMigration();
      if (reservation.phase !== "reserving" || reservations.get(services) !== reservation)
        throw new Error("DATA_DIRECTORY_CANCELLED: Service reservation was cancelled");
    }
    reservation.phase = "reserved";
  } catch (error) {
    // 只取消本轮token；旧调用不能经公共cancel误取消后续的新reservation。
    if (reservation.phase !== "cancelled") await cancelReservation(services, reservation);
    throw error;
  } finally {
    reservation.reservePending = false;
    releaseCancelledReservation(services, reservation);
  }
}

export async function cancelDataDirectoryMigration(services: ServiceCollection): Promise<void> {
  const reservation = reservations.get(services);
  if (reservation) await cancelReservation(services, reservation);
}

/** 全应用 reserve 成功后才调用；实际关库失败不能再把已经关闭的资源热恢复。 */
export async function prepareForDataDirectoryMigration(services: ServiceCollection): Promise<void> {
  const reservation = reservations.get(services);
  if (reservation?.phase !== "reserved") throw new Error("DATA_DIRECTORY_NOT_RESERVED");
  reservation.phase = "closing";
  const agent = services.getOptional(IZCodeAgentService) as
    | (IZCodeAgentService & { prepareForDataDirectoryMigration?: () => Promise<void> })
    | undefined;
  if (agent && !agent.prepareForDataDirectoryMigration) {
    throw new Error("DATA_DIRECTORY_UNSUPPORTED: Agent close is unavailable");
  }
  await agent?.prepareForDataDirectoryMigration?.();
}
