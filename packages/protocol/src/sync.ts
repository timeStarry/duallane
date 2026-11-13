export type DevicePlatform = "web" | "ios" | "android";

export interface UserDeviceSummary {
  id: string;
  platform: DevicePlatform;
  deviceName: string;
  appVersion: string;
  lastActiveAt: string;
  current: boolean;
}

export interface MediaDimensions {
  width: number;
  height: number;
  thumbHash?: string;
  durationMs?: number;
  waveform?: number[];
}

export interface SyncDeltaResponse {
  currentSeq: number;
  hasMore: boolean;
  resetRequired: boolean;
  events: Array<{
    seq: number;
    type: string;
    conversationId?: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
}
