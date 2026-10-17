import type { ChannelProbeInput } from '@cheapai/contracts/channels';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChannelModel, ChannelProbeResult, ChannelView } from '@cheapai/api-client/channels';
import type { SessionIdentity } from '@cheapai/api-client/types';
import type { AdminChannelsApi } from './api';
import { channelModelKey, createDiagnosticOperation } from './diagnostic-operation';
import { createDiagnosticResultView } from './diagnostic-result';
import type { DiagnosticResultView } from './diagnostic-result';

export interface UseChannelDiagnosticOptions {
  readonly open: boolean;
  readonly channel: ChannelView;
  readonly api: AdminChannelsApi;
  readonly sessionIdentity: SessionIdentity | null;
}

export interface UseChannelDiagnosticState {
  readonly selection: string;
  readonly selectedModel: ChannelModel | null;
  readonly busy: boolean;
  readonly result: ChannelProbeResult | null;
  readonly error: unknown | null;
  readonly view: DiagnosticResultView;
  readonly selectMapping: (selection: string) => void;
  readonly run: (params?: ChannelProbeInput['params']) => Promise<void>;
}

interface DiagnosticState {
  readonly contextKey: string;
  readonly operation: ReturnType<typeof createDiagnosticOperation>;
  readonly selection: string;
  readonly busy: boolean;
  readonly result: ChannelProbeResult | null;
  readonly error: unknown | null;
}

/** Holds one explicit probe result for the current channel, mapping set, panel, and admin identity. */
export function useChannelDiagnostic({
  open,
  channel,
  api,
  sessionIdentity,
}: UseChannelDiagnosticOptions): UseChannelDiagnosticState {
  const operation = useMemo(() => createDiagnosticOperation(api), [api]);
  const firstSelection = channel.models[0] ? channelModelKey(channel.models[0]) : '';
  const modelsSignature = JSON.stringify(
    channel.models.map((model) => [
      model.publicModelId,
      model.protocol,
      model.upstreamModel,
      model.mappingVersion,
      model.priceVersion,
    ]),
  );
  const contextKey = JSON.stringify([
    open,
    channel.id,
    channel.status,
    channel.configVersion,
    modelsSignature,
    sessionIdentity?.userId ?? null,
    sessionIdentity?.epoch ?? null,
  ]);
  const [state, setState] = useState<DiagnosticState>(() => ({
    contextKey,
    operation,
    selection: firstSelection,
    busy: false,
    result: null,
    error: null,
  }));
  const generation = useRef(0);
  const busyRef = useRef(false);
  const activeController = useRef<AbortController | null>(null);
  const currentState =
    state.contextKey === contextKey && state.operation === operation ? state : null;
  const selection = currentState?.selection ?? firstSelection;
  const selectedModel =
    channel.models.find((model) => channelModelKey(model) === selection) ?? null;
  const busy = currentState?.busy ?? false;
  const result = currentState?.result ?? null;
  const error = currentState?.error ?? null;

  useEffect(() => {
    return () => {
      generation.current += 1;
      activeController.current?.abort();
      activeController.current = null;
      busyRef.current = false;
    };
  }, [contextKey, operation]);

  useEffect(() => {
    setState((current) => {
      if (current.contextKey === contextKey && current.operation === operation) return current;
      return {
        contextKey,
        operation,
        selection: firstSelection,
        busy: false,
        result: null,
        error: null,
      };
    });
  }, [contextKey, firstSelection, operation]);

  const selectMapping = useCallback(
    (nextSelection: string) => {
      if (
        !open ||
        busyRef.current ||
        !channel.models.some((model) => channelModelKey(model) === nextSelection)
      ) {
        return;
      }
      setState((current) => {
        if (current.contextKey === contextKey && current.operation === operation && current.busy) {
          return current;
        }
        return {
          contextKey,
          operation,
          selection: nextSelection,
          busy: false,
          result: null,
          error: null,
        };
      });
    },
    [channel.models, contextKey, open, operation],
  );

  const run = useCallback(async (params?: ChannelProbeInput['params']) => {
    if (!open || !selectedModel || busy || busyRef.current) return;

    const controller = new AbortController();
    const runGeneration = generation.current + 1;
    generation.current = runGeneration;
    activeController.current = controller;
    busyRef.current = true;
    setState((current) => {
      if (current.contextKey === contextKey && current.operation === operation) {
        if (current.busy) return current;
        return { ...current, busy: true, result: null, error: null };
      }
      return {
        contextKey,
        operation,
        selection,
        busy: true,
        result: null,
        error: null,
      };
    });

    const isCurrentRun = () =>
      generation.current === runGeneration &&
      activeController.current === controller &&
      !controller.signal.aborted;

    try {
      const completed = await operation.run(channel, selectedModel, controller.signal, params);
      if (isCurrentRun()) {
        setState((current) => {
          if (current.contextKey !== contextKey || current.operation !== operation) return current;
          return { ...current, result: completed, error: null };
        });
      }
    } catch (cause) {
      if (isCurrentRun()) {
        setState((current) => {
          if (current.contextKey !== contextKey || current.operation !== operation) return current;
          return { ...current, result: null, error: cause };
        });
      }
    } finally {
      if (activeController.current === controller) {
        activeController.current = null;
        busyRef.current = false;
        if (generation.current === runGeneration) {
          setState((current) => {
            if (current.contextKey !== contextKey || current.operation !== operation)
              return current;
            return { ...current, busy: false };
          });
        }
      }
    }
  }, [busy, channel, contextKey, open, operation, selectedModel, selection]);

  return {
    selection,
    selectedModel,
    busy,
    result,
    error,
    view: createDiagnosticResultView({ result, error }),
    selectMapping,
    run,
  };
}
