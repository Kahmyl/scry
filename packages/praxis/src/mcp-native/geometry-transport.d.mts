import type { CDPSession } from "playwright";

export type NativeGeometryScope = { instanceId: string; graphId: string };
export type NativeGeometryTransportResult = {
  ok: boolean;
  reason?:
    | "native_protection_geometry_unsupported"
    | "native_protection_geometry_stale"
    | "native_protection_graph_capacity";
  requests: number;
  quads: number;
};

/** Private protocol transport; selected geometry and remote objects never escape. */
export function transportNativeGeometry(options: {
  session: CDPSession;
  contextId: number;
  frameId: string;
  isMainFrame: boolean;
  readId: number;
  policyGeneration: number;
  expectedScope: NativeGeometryScope;
  deadline: number;
  isCurrent: () => boolean;
  signal?: AbortSignal;
}): Promise<NativeGeometryTransportResult>;
