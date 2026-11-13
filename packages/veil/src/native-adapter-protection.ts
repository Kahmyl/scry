import { nativeControlLimits } from "./native-control-policy.js";
import { nativeProtectionScript } from "./native-protection.js";
import { NativeTextProjection, type NativePrivacyHistory } from "./native-text-projection.js";
import { nativeImageEvidence, type NativeGraphReceipt } from "./native-privacy-facts.js";
import { SensitiveValueClassifier } from "./classifier.js";
import {
  nativeImageReasons,
  type NativeCaptureEpoch,
  type NativeBrowserProtectionPort,
  type NativeCaptureSample,
  type NativeImageEvidence,
  type NativeImageReason,
} from "@scry/contracts";

type Source = { pageId: number; worldId: number };
type World = Source & { facts: NativeGraphReceipt };
type Shared = {
  bound: string[];
  boundSet: Set<string>;
  boundBytes: number;
  limited: boolean;
  history?: NativePrivacyHistory;
  policyGeneration: number;
  updates: Array<{ revision: number; script: string }>;
  revision: number;
  syncedLearned: Set<string>;
  references: number;
};
/** Worker-local privacy capability. Raw history/graph facts never leave this owner. */
export function createNativeAdapterProtector(
  secrets: Record<string, string>,
  options: { captureEpoch?: NativeCaptureEpoch; shared?: Shared } = {},
): NativeBrowserProtectionPort {
  const shared = options.shared ?? {
    bound: [],
    boundSet: new Set<string>(),
    boundBytes: 0,
    limited: false,
    policyGeneration: 1,
    updates: [],
    revision: 0,
    syncedLearned: new Set<string>(),
    references: 0,
  };
  shared.references++;
  const bound = shared.bound,
    boundSet = shared.boundSet;
  const addBound = (values: Record<string, string>) => {
    const added: string[] = [];
    for (const value of Object.values(values)) {
      if (!value || boundSet.has(value)) continue;
      if (
        bound.length >= nativeControlLimits.boundValues ||
        shared.boundBytes + value.length * 2 > nativeControlLimits.boundBytes
      ) {
        shared.limited = true;
        break;
      }
      boundSet.add(value);
      bound.push(value);
      added.push(value);
      shared.boundBytes += value.length * 2;
    }
    return added;
  };
  addBound(secrets);
  const projection = new NativeTextProjection(bound, shared.history);
  shared.history ??= projection.history;
  if (shared.limited) projection.bind([], true);
  let generation = 0,
    complete = false,
    disposed = false,
    challenge: string | undefined,
    targetPage: number | undefined;
  let observedGap: NativeImageReason | undefined;
  let imageSequence = 0,
    imageWindow:
      | { token: number; pageId: number | undefined; failure: NativeImageReason | undefined }
      | undefined;
  const outgoingGaps: NativeImageReason[] = [];
  const latch = (reason: NativeImageReason) => {
    if (observedGap) return;
    observedGap = reason;
    outgoingGaps.push(reason);
  };
  const worlds = new Map<string, World>();
  let priorPrivatePages = new Set<number>();
  let merged: NativeGraphReceipt | undefined;
  const updates = shared.updates,
    syncedLearned = shared.syncedLearned;
  const syncLearned = () => {
    const added = projection.learnedForBrowser.filter((value) => !syncedLearned.has(value));
    if (!added.length) return;
    for (const value of added) syncedLearned.add(value);
    updates.push({
      revision: ++shared.revision,
      script: `globalThis.__scryNativeGraph?.learn(${JSON.stringify(added)});`,
    });
  };
  const key = (source: Source) => source.pageId + ":" + source.worldId;
  const validFacts = (read: number, value: unknown): value is NativeGraphReceipt => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const f = value as NativeGraphReceipt;
    return (
      !!f.count &&
      Object.values(f.count).every((n) => Number.isSafeInteger(n) && n >= 0) &&
      f.count.roots <= 512 &&
      f.count.nodes <= 8192 &&
      f.count.textNodes <= 3000 &&
      f.count.controls <= 500 &&
      f.count.presentations <= 500 &&
      f.count.rectangles <= 2048 &&
      f.version === 1 &&
      f.readId === read &&
      f.policyGeneration === shared.policyGeneration &&
      ["complete", "withheld"].includes(f.text) &&
      !!f.image &&
      ((f.image.state === "available" && f.image.assessment === "best_effort_known_candidates") ||
        (f.image.state === "withheld" &&
          Object.hasOwn(nativeImageReasons, f.image.reason) &&
          f.image.recovery === nativeImageReasons[f.image.reason])) &&
      Array.isArray(f.values) &&
      f.values.length <= nativeControlLimits.learnedValues &&
      f.values.every(
        (v) => typeof v === "string" && v.length <= nativeControlLimits.learnedLength,
      ) &&
      Array.isArray(f.coveredBoundIndices) &&
      Array.isArray(f.textCandidateRefs) &&
      f.textCandidateRefs.length <= 500 &&
      Array.isArray(f.imageCandidateRefs) &&
      f.imageCandidateRefs.length <= 1000 &&
      f.textCandidateScope?.readId === read &&
      f.textCandidateScope.policyGeneration === shared.policyGeneration &&
      ["present", "absent_in_supported_snapshot", "unknown"].includes(f.knownRequirement) &&
      (f.observedRequiredGap === undefined ||
        Object.hasOwn(nativeImageReasons, f.observedRequiredGap)) &&
      (f.finalReadChallenge === undefined ||
        (typeof f.finalReadChallenge === "string" && /^[a-f0-9-]{36}$/u.test(f.finalReadChallenge)))
    );
  };
  const merge = (selected?: number): NativeGraphReceipt => {
    const all = [...worlds.values()],
      chosen =
        selected === undefined
          ? all.filter((w) => w.pageId === (all[0]?.pageId ?? 0))
          : all.filter((w) => w.pageId === selected),
      values = projection.learnedForBrowser;
    const ids = new Map<string, number>();
    const refs = (field: "textCandidateRefs" | "imageCandidateRefs") =>
      chosen.flatMap((w) =>
        w.facts[field].map((ref) => {
          const origin = key(w) + ":" + ref.sourceOwner;
          if (!ids.has(origin)) ids.set(origin, ids.size);
          return {
            ...ref,
            sourceOwner: ids.get(origin)!,
            ...("learnedIndex" in ref
              ? { learnedIndex: values.indexOf(w.facts.values[ref.learnedIndex]!) }
              : {}),
          };
        }),
      );
    const failed = chosen.find((w) => w.facts.image.state === "withheld");
    const image =
      !complete || !chosen.length
        ? nativeImageEvidence("native_protection_refresh_incomplete")
        : (failed?.facts.image ?? nativeImageEvidence());
    return {
      version: 1,
      readId: generation,
      policyGeneration: shared.policyGeneration,
      ...(challenge ? { finalReadChallenge: challenge } : {}),
      text:
        complete && chosen.length && chosen.every((w) => w.facts.text === "complete")
          ? "complete"
          : "withheld",
      image,
      knownRequirement: chosen.some((w) => w.facts.knownRequirement === "present")
        ? "present"
        : complete &&
            chosen.every((w) => w.facts.knownRequirement === "absent_in_supported_snapshot")
          ? "absent_in_supported_snapshot"
          : "unknown",
      values,
      coveredValues: [...new Set(chosen.flatMap((w) => w.facts.coveredValues ?? []))],
      coveredBoundIndices: [...new Set(chosen.flatMap((w) => w.facts.coveredBoundIndices))],
      textCandidateScope: { readId: generation, policyGeneration: shared.policyGeneration },
      textCandidateRefs: refs("textCandidateRefs"),
      imageCandidateRefs: refs("imageCandidateRefs"),
      ...(observedGap ? { observedRequiredGap: observedGap } : {}),
      count: {
        roots: chosen.reduce((n, w) => n + w.facts.count.roots, 0),
        nodes: chosen.reduce((n, w) => n + w.facts.count.nodes, 0),
        textNodes: chosen.reduce((n, w) => n + w.facts.count.textNodes, 0),
        controls: chosen.reduce((n, w) => n + w.facts.count.controls, 0),
        presentations: chosen.reduce((n, w) => n + w.facts.count.presentations, 0),
        pseudoReads: chosen.reduce((n, w) => n + w.facts.count.pseudoReads, 0),
        rectangles: chosen.reduce((n, w) => n + w.facts.count.rectangles, 0),
      },
    };
  };
  const project = () => {
    merged = merge(targetPage);
    projection.accept(merged);
    syncLearned();
  };
  const metadata = (value: unknown): unknown =>
    typeof value === "string"
      ? generation > 0 && !complete
        ? "[UNAVAILABLE:NATIVE_PROTECTION_TEXT]"
        : projection.cleanMetadata(value)
      : Array.isArray(value)
        ? value.map(metadata)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, metadata(v)]))
          : value;
  let apiClassifier: SensitiveValueClassifier | undefined,
    apiRevision = "";
  const classifier = () => {
    const version = bound.length + ":" + projection.learnedForBrowser.length;
    if (!apiClassifier || version !== apiRevision) {
      apiClassifier = new SensitiveValueClassifier({
        protectedValues: Object.fromEntries([
          ...bound.map((v, i) => ["bound_" + i, v]),
          ...projection.learnedForBrowser.map((v, i) => ["learned_" + i, v]),
        ]),
      });
      apiRevision = version;
    }
    return apiClassifier;
  };
  const clean = (value: unknown) => metadata(value);
  return {
    fork(epoch: NativeCaptureEpoch) {
      return createNativeAdapterProtector({}, { captureEpoch: epoch, shared });
    },
    clean,
    prelearn(value: unknown) {
      const visit = (v: unknown) => {
        if (typeof v === "string") projection.cleanMetadata(v);
        else if (Array.isArray(v)) for (const item of v) visit(item);
        else if (v && typeof v === "object") for (const item of Object.values(v)) visit(item);
      };
      visit(value);
      syncLearned();
    },
    cleanTextContent(content: Array<{ type: string; text?: string }>, snapshot = false) {
      const indices = content.flatMap((item, index) =>
          item.type === "text" && typeof item.text === "string" ? [index] : [],
        ),
        texts = indices.map((i) => content[i]!.text!);
      const cleaned =
        generation > 0 && !complete
          ? texts.map(() => "[UNAVAILABLE:NATIVE_PROTECTION_TEXT]")
          : snapshot
            ? projection.cleanAll(texts)
            : texts.map((text) => projection.cleanMetadata(text));
      if (projection.observedRequiredGap) latch(projection.observedRequiredGap);
      syncLearned();
      const byIndex = new Map(indices.map((index, i) => [index, cleaned[i]!]));
      return content.map((item, index) =>
        byIndex.has(index) ? { ...item, text: byIndex.get(index)! } : item,
      );
    },
    beginNativeRead(finalReadChallenge?: string) {
      if (disposed) return ++generation;
      priorPrivatePages = new Set(
        [...worlds.values()]
          .filter((w) => w.facts.knownRequirement === "present")
          .map((w) => w.pageId),
      );
      worlds.clear();
      complete = false;
      challenge = finalReadChallenge;
      return ++generation;
    },
    acceptNativeRead(read: number, facts: unknown, source: Source = { pageId: 0, worldId: 0 }) {
      if (disposed || read !== generation || !validFacts(read, facts)) return false;
      projection.learn(facts.values);
      if (
        facts.text === "withheld" &&
        facts.image.state === "withheld" &&
        [
          "native_protection_capacity",
          "native_protection_graph_capacity",
          "native_protection_classification_failed",
        ].includes(facts.image.reason)
      )
        projection.failHistory(
          facts.image.reason === "native_protection_classification_failed"
            ? "native_protection_classification_failed"
            : "native_protection_capacity",
        );
      worlds.set(key(source), { ...source, facts });
      if (facts.observedRequiredGap) latch(facts.observedRequiredGap);
      syncLearned();
      return facts.text === "complete" && !projection.history.permanentReason;
    },
    finishNativeRead(
      read: number,
      finished: boolean,
      selectedPage?: number,
      missingPageIds: number[] = [],
    ) {
      if (disposed || read !== generation) return false;
      complete = finished;
      targetPage = selectedPage;
      if (!finished && missingPageIds.some((page) => priorPrivatePages.has(page)))
        latch("native_protection_refresh_incomplete");
      project();
      return this.observationAvailable();
    },
    acceptNativePaint(read: number, facts: unknown, source: Source = { pageId: 0, worldId: 0 }) {
      if (disposed || read !== generation || !validFacts(read, facts)) return false;
      projection.learn(facts.values);
      if (
        facts.text === "withheld" &&
        facts.image.state === "withheld" &&
        [
          "native_protection_capacity",
          "native_protection_graph_capacity",
          "native_protection_classification_failed",
        ].includes(facts.image.reason)
      )
        projection.failHistory(
          facts.image.reason === "native_protection_classification_failed"
            ? "native_protection_classification_failed"
            : "native_protection_capacity",
        );
      worlds.set(key(source), { ...source, facts });
      if (facts.observedRequiredGap) latch(facts.observedRequiredGap);
      syncLearned();
      return facts.image.state === "available";
    },
    finishNativePaint(read: number) {
      if (disposed || read !== generation) return;
      project();
    },
    capacityExceeded() {
      projection.failHistory("native_protection_capacity");
    },
    observationAvailable() {
      return !disposed && complete && projection.textProtectionReady;
    },
    observationIssue() {
      return projection.textIssue ?? "native_protection_refresh_incomplete";
    },
    imageEvidence(): NativeImageEvidence {
      return generation > 0 && !complete
        ? nativeImageEvidence("native_protection_refresh_incomplete")
        : imageWindow?.failure
          ? nativeImageEvidence(imageWindow.failure)
          : projection.imageEvidence;
    },
    captureSample(): NativeCaptureSample {
      const all = [...worlds.values()];
      const failed = all.find((w) => w.facts.image.state === "withheld");
      const local = projection.imageEvidence;
      const image = !complete
        ? nativeImageEvidence("native_protection_refresh_incomplete")
        : local.state === "withheld"
          ? local
          : (failed?.facts.image ?? nativeImageEvidence());
      return {
        version: 1,
        readId: generation,
        policyGeneration: shared.policyGeneration,
        ...(challenge ? { finalReadChallenge: challenge } : {}),
        text: this.observationAvailable() ? "complete" : "withheld",
        image,
        knownRequirement: all.some((w) => w.facts.knownRequirement === "present")
          ? "present"
          : complete
            ? "absent_in_supported_snapshot"
            : "unknown",
        ...(observedGap ? { observedRequiredGap: observedGap } : {}),
      };
    },
    beginImageCapture(selected?: number) {
      const token = ++imageSequence;
      imageWindow = { token, pageId: selected, failure: undefined };
      return token;
    },
    endImageCapture(token: number) {
      if (imageWindow?.token === token) imageWindow = undefined;
    },
    readExpressionFor(source: Source) {
      const token =
        imageWindow && (imageWindow.pageId === undefined || imageWindow.pageId === source.pageId)
          ? imageWindow.token
          : undefined;
      return (
        `globalThis.__scryNativeGraph?.armImageCapture(${JSON.stringify(token)});` +
        this.readExpression
      );
    },
    acceptGap(payload: unknown) {
      if (disposed || typeof payload !== "string" || payload.length > 1024) return;
      try {
        const gap = JSON.parse(payload);
        if (
          gap.version === 1 &&
          JSON.stringify(gap.epoch) === JSON.stringify(options.captureEpoch) &&
          Number.isSafeInteger(gap.policyGeneration) &&
          gap.policyGeneration > 0 &&
          gap.policyGeneration <= shared.policyGeneration &&
          Object.hasOwn(nativeImageReasons, gap.reason)
        ) {
          if (imageWindow && gap.imageCaptureToken === imageWindow.token)
            imageWindow.failure ??= gap.reason;
          latch(gap.reason);
        }
      } catch {
        /* No application text or exception is disclosed. */
      }
    },
    drainGaps() {
      return outgoingGaps.splice(0);
    },
    diagnosticDetailAllowed() {
      return false as const;
    },
    updateSecrets(values: Record<string, string>) {
      if (disposed) return;
      const wasLimited = shared.limited;
      const added = addBound(values);
      if (!added.length && shared.limited === wasLimited) return;
      projection.bind(added, shared.limited);
      ++shared.policyGeneration;
      complete = false;
      updates.push({
        revision: ++shared.revision,
        script: `globalThis.__scryNativeGraph?.bind(${JSON.stringify(added)},${shared.policyGeneration});`,
      });
    },
    get policyGeneration() {
      return shared.policyGeneration;
    },
    get scriptRevision() {
      syncLearned();
      return shared.revision;
    },
    documentUpdatesSince(since: number) {
      syncLearned();
      return updates.filter((update) => update.revision > since);
    },
    get readExpression() {
      return `(()=>{if(globalThis.__scryNativeGraph?.version!==2)throw Error('native_graph_unavailable');globalThis.__scryNativeGraph.bind([],${shared.policyGeneration});return globalThis.__scryNativeGraph.read(${generation},${JSON.stringify(projection.learnedForBrowser)},${JSON.stringify(challenge)});})()`;
    },
    get pixelExpression() {
      return `globalThis.__scryNativeGraph.paint(${generation})`;
    },
    get script() {
      return nativeProtectionScript(bound, {
        learned: projection.learnedForBrowser,
        policyGeneration: shared.policyGeneration,
        ...(options.captureEpoch ? { captureEpoch: options.captureEpoch } : {}),
        limited: shared.limited,
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ++generation;
      worlds.clear();
      outgoingGaps.length = 0;
      const last = --shared.references === 0;
      if (last) {
        updates.length = 0;
        syncedLearned.clear();
        bound.length = 0;
        boundSet.clear();
        shared.boundBytes = 0;
      }
      projection.dispose(last);
      apiClassifier = undefined;
    },
    cleanApi(value: unknown) {
      if (!projection.textProtectionReady) return clean(value);
      const protectedKeys =
        /(?:password|passwd|secret|token|authorization|cookie|api[-_]?key|card[-_]?number|cvv)|^(?:pan|session(?:id)?|credentials?|access[-_]?link|reset[-_]?url|recovery[-_]?url)$/i;
      let nodes = 0;
      const fields = (v: unknown, depth = 0): unknown => {
        if (
          ++nodes > 2048 ||
          depth > 16 ||
          (Array.isArray(v) && v.length > 1000) ||
          (v && typeof v === "object" && Object.keys(v).length > 1000)
        )
          throw Error("API_RESPONSE_STRUCTURE_CAPACITY");
        return Array.isArray(v)
          ? v.slice(0, 1000).map((x) => fields(x, depth + 1))
          : v && typeof v === "object"
            ? Object.fromEntries(
                Object.entries(v)
                  .slice(0, 1000)
                  .map(([key, item]) => [
                    key,
                    protectedKeys.test(key) ||
                    (/^(?:code|otp|pin)$/i.test(key) && /^\d{4,8}$/.test(String(item)))
                      ? "[PROTECTED:API_RESPONSE]"
                      : fields(item, depth + 1),
                  ]),
              )
            : typeof v === "number"
              ? classifier().sanitize(String(v)) === String(v)
                ? v
                : classifier().sanitize(String(v))
              : clean(v);
      };
      if (value && typeof value === "object" && "body" in value && typeof value.body === "string") {
        let body: unknown = value.body;
        try {
          body = JSON.stringify(fields(JSON.parse(value.body)));
        } catch (error) {
          if (error instanceof Error && error.message === "API_RESPONSE_STRUCTURE_CAPACITY")
            return clean({
              ...value,
              body: "[UNAVAILABLE:RESPONSE_STRUCTURE_CAPACITY]",
              bodyIssue: "response_structure_capacity",
            });
          if (
            "contentType" in value &&
            typeof value.contentType === "string" &&
            /json/i.test(value.contentType)
          )
            return clean({
              ...value,
              body: "[UNAVAILABLE:INVALID_JSON]",
              bodyIssue: "invalid_json",
            });
          body = classifier().sanitize(
            value.body.replace(
              /"(?:password|passwd|secret|token|access_token|refresh_token|api_key|authorization|cookie)"\s*:\s*"(?:\\.|[^"\\])*"/giu,
              "[PROTECTED:API_RESPONSE]",
            ),
          );
        }
        return clean({ ...value, body });
      }
      return clean(value);
    },
  };
}
