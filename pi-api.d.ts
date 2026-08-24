import type {
  ExtensionHandler,
  MessageEndEvent,
  MessageEndEventResult,
} from "@earendil-works/pi-coding-agent";

declare module "@earendil-works/pi-coding-agent" {
  interface ProviderConfig {
    sourceProvider?: string;
  }

  interface ModelRegistry {
    hasAuth(provider: string): boolean;
    logout(provider: string): Promise<void>;
  }

  interface MessageEndEventResult {
    retry?: boolean;
  }

  interface CompactionErrorEvent {
    type: "compaction_error";
    reason: "overflow" | "threshold";
    errorMessage: string;
    attempt: number;
    signal: AbortSignal;
  }

  interface CompactionErrorResult {
    retry?: boolean;
  }

  interface ExtensionAPI {
    on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): void;
    on(event: "compaction_error", handler: ExtensionHandler<CompactionErrorEvent, CompactionErrorResult>): void;
  }
}
