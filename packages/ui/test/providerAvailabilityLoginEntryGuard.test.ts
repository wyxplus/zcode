// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useProviderAvailabilityLoginEntryGuard } from "@/root/useProviderAvailabilityLoginEntryGuard.js";

describe("useProviderAvailabilityLoginEntryGuard", () => {
  it.each([false, true])("空模型时依据跨启动 skip=%s 决定入口", async (modelSetupSkipped) => {
    const setLoginEntryOpen = vi.fn();
    renderHook(() =>
      useProviderAvailabilityLoginEntryGuard({
        settingsHydrated: true,
        modelSetupSkipped,
        modelSelectionView: { revision: 1, providers: [] },
        refreshProviderState: vi.fn(),
        readModelSelectionView: vi.fn(),
        setLoginEntryOpen,
      }),
    );
    await waitFor(() => expect(setLoginEntryOpen).toHaveBeenCalledWith(!modelSetupSkipped));
  });
  it("设置水合前不判断，水合后只检查一次", async () => {
    const setLoginEntryOpen = vi.fn();
    const view = { revision: 1, providers: [] };
    const { rerender } = renderHook(
      ({ hydrated }) =>
        useProviderAvailabilityLoginEntryGuard({
          settingsHydrated: hydrated,
          modelSetupSkipped: true,
          modelSelectionView: view,
          refreshProviderState: vi.fn(),
          readModelSelectionView: vi.fn(),
          setLoginEntryOpen,
        }),
      { initialProps: { hydrated: false } },
    );
    expect(setLoginEntryOpen).not.toHaveBeenCalled();
    rerender({ hydrated: true });
    await waitFor(() => expect(setLoginEntryOpen).toHaveBeenCalledWith(false));
    rerender({ hydrated: true });
    expect(setLoginEntryOpen).toHaveBeenCalledTimes(1);
  });
  it("首次 Selection 读取失败结束启动等待且不伪装成无 Provider", async () => {
    const setLoginEntryOpen = vi.fn();
    const { result } = renderHook(() =>
      useProviderAvailabilityLoginEntryGuard({
        settingsHydrated: true,
        modelSetupSkipped: false,
        modelSelectionView: null,
        modelSelectionError: new Error("registry unavailable"),
        refreshProviderState: vi.fn(async () => {}),
        readModelSelectionView: vi.fn(),
        setLoginEntryOpen,
      }),
    );

    await waitFor(() => expect(result.current.startupCheckCompleted).toBe(true));
    expect(setLoginEntryOpen).not.toHaveBeenCalled();
  });

  it("等待 Selection View 水合后再判断启动可用性", async () => {
    const setLoginEntryOpen = vi.fn();
    const refreshProviderState = vi.fn(async () => {});
    const view = {
      revision: 1,
      providers: [
        {
          providerId: "registry-provider",
          config: { kind: "api" as const },
          models: [{ modelId: "registry-model", config: {} }],
        },
      ],
    };
    const { rerender } = renderHook(
      (props: { hydrated: boolean }) =>
        useProviderAvailabilityLoginEntryGuard({
          settingsHydrated: true,
          modelSetupSkipped: false,
          modelSelectionView: props.hydrated ? view : null,
          refreshProviderState,
          readModelSelectionView: async () => view,
          setLoginEntryOpen,
        }),
      { initialProps: { hydrated: false } },
    );

    await Promise.resolve();
    expect(setLoginEntryOpen).not.toHaveBeenCalled();

    rerender({ hydrated: true });

    await waitFor(() => expect(setLoginEntryOpen).toHaveBeenCalledWith(false));
    expect(refreshProviderState).not.toHaveBeenCalled();
  });
});
