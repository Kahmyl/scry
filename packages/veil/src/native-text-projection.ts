/** Source-aware native provider projection. General classifier policy is unchanged. */
import { runInNewContext } from "node:vm";
import { SensitiveValueClassifier } from "./classifier.js";
import { nativeControlPolicySource as policySource } from "./native-control-policy.js";
import {
  nativeImageEvidence as imageEvidence,
  type NativeGraphReceipt as GraphReceipt,
  type NativeCaptureSample as CaptureSample,
  type NativeImageEvidence as ImageEvidence,
} from "./native-privacy-facts.js";
const policy = runInNewContext(
  policySource +
    "\n({control:nativeClassifyControl,presentation:nativePresentationDecision,intrinsic:nativeIntrinsicFindings,axRoles:nativeAXRoleFamilies})",
);
const marker = "[PROTECTED:NATIVE_VALUE]";
type Scalar = {
  line: number;
  endLine: number;
  prefix: string;
  role: string;
  label: string;
  value: string;
  quoted: boolean;
  block: boolean;
  private: boolean;
  hasValue: boolean;
  indent: number;
  parent?: Scalar | undefined;
  children: Scalar[];
  nameStart?: number | undefined;
  nameEnd?: number | undefined;
};
function scalar(line: string, index: number): Scalar | undefined {
  const match = /^(\s*-\s+)([a-z][a-z0-9_-]*)\b/u.exec(line);
  if (!match) return;
  let cursor = match[0].length,
    label = "",
    nameStart: number | undefined,
    nameEnd: number | undefined;
  while (line[cursor] === " ") cursor++;
  if (line[cursor] === '"') {
    const name = /^"((?:\\.|[^"\\])*)"/u.exec(line.slice(cursor));
    if (!name) throw Error("unsupported_name");
    try {
      label = JSON.parse(name[0]);
    } catch {
      throw Error("unsupported_name");
    }
    nameStart = cursor;
    cursor += name[0].length;
    nameEnd = cursor;
  }
  let bracket = 0;
  for (; cursor < line.length; cursor++) {
    if (line[cursor] === "[") bracket++;
    else if (line[cursor] === "]") bracket--;
    else if (line[cursor] === ":" && bracket === 0) break;
  }
  const hasValue = cursor < line.length,
    raw = hasValue ? line.slice(cursor + 1).trim() : "";
  let value = raw,
    quoted = false;
  if (raw.startsWith('"')) {
    try {
      value = JSON.parse(raw);
      quoted = true;
    } catch {
      throw Error("unsupported_scalar");
    }
  }
  if (typeof value !== "string") throw Error("unsupported_scalar");
  const role = match[2]!,
    action =
      /^(?:button|checkbox|radio|switch|combobox|listbox|option|menuitem|menuitemcheckbox|menuitemradio|slider|scrollbar)$/u.test(
        role,
      ),
    isPrivate = action
      ? false
      : ["textbox", "spinbutton"].includes(role)
        ? policy.control({ role, labels: [label] }).learn
        : label
          ? policy.presentation({ labels: [label] }).private
          : false;
  return {
    line: index,
    endLine: index,
    prefix: hasValue ? line.slice(0, cursor + 1) : line,
    role,
    label,
    value,
    quoted,
    block: hasValue && /^[|>][+-]?$/u.test(raw),
    private: isPrivate,
    hasValue,
    indent: match[1]!.length - 2,
    children: [],
    nameStart,
    nameEnd,
  };
}
export type NativePrivacyHistory = {
  bound: string[];
  values: Set<string>;
  classifier: SensitiveValueClassifier;
  permanentReason:
    "native_protection_capacity" | "native_protection_classification_failed" | undefined;
};
export class NativeTextProjection {
  readonly history: NativePrivacyHistory;
  private get values() {
    return this.history.values;
  }
  private get classifier() {
    return this.history.classifier;
  }
  private set classifier(value: SensitiveValueClassifier) {
    this.history.classifier = value;
  }
  private get permanentLocalReason() {
    return this.history.permanentReason;
  }
  private set permanentLocalReason(value: NativePrivacyHistory["permanentReason"]) {
    this.history.permanentReason = value;
  }
  readonly bound: string[];
  private disposed = false;
  private textReady = true;
  private reason: ImageEvidence = imageEvidence();
  private coveredBound = new Set<number>();
  private coveredValues = new Set<string>();
  private lastBrowserValues = new Set<string>();
  private stickyObservedGap: GraphReceipt["observedRequiredGap"];
  private nodePrivateUnmapped = false;
  private requiredPresentations: Array<{ sourceOwner: number; value: string; axRoles: string[] }> =
    [];
  private mappedPresentations = new Map<string, Map<string, string>>();
  private imageRequirements: Array<{
    sourceOwner: number;
    value: string;
    axRoles: string[];
    whole: boolean;
  }> = [];
  private mappingUnavailable = false;
  private permanentRenderedReason:
    "native_protection_capacity" | "native_protection_classification_failed" | undefined;
  constructor(bound: readonly string[] = [], shared?: NativePrivacyHistory) {
    this.history = shared ?? {
      bound: [...new Set(bound.filter(Boolean))],
      values: new Set(),
      classifier: new SensitiveValueClassifier(),
      permanentReason: undefined,
    };
    this.bound = this.history.bound;
    if (!shared)
      try {
        this.classifier = this.makeClassifier();
      } catch {
        this.permanentLocalReason = "native_protection_classification_failed";
        this.textReady = false;
        this.reason = imageEvidence(this.permanentLocalReason);
      }
  }
  bind(values: readonly string[], limited = false) {
    if (this.disposed) return;
    for (const value of values) if (value && !this.bound.includes(value)) this.bound.push(value);
    if (limited) {
      this.permanentLocalReason = "native_protection_capacity";
      this.textReady = false;
      this.reason = imageEvidence(this.permanentLocalReason);
      return;
    }
    try {
      this.classifier = this.makeClassifier();
    } catch {
      this.permanentLocalReason = "native_protection_classification_failed";
      this.textReady = false;
      this.reason = imageEvidence(this.permanentLocalReason);
    }
  }
  failHistory(reason: "native_protection_capacity" | "native_protection_classification_failed") {
    this.permanentLocalReason ??= reason;
    this.textReady = false;
    this.reason = imageEvidence(this.permanentLocalReason);
  }
  learn(values: readonly string[]) {
    if (this.disposed) return;
    for (const value of values) this.retain(value, false);
  }

  private makeClassifier() {
    return new SensitiveValueClassifier({
      protectedValues: Object.fromEntries([
        ...this.bound.map((v, i) => ["bound_" + i, v]),
        ...[...this.values].map((v, i) => ["auto_" + i, v]),
      ]),
    });
  }
  private retain(value: string, rendered = true) {
    if (!value || this.bound.includes(value) || this.values.has(value)) return;
    const bytes = [...this.values].reduce((n, v) => n + v.length * 2, 0);
    if (value.length > 4096 || this.values.size >= 128 || bytes + value.length * 2 > 65536) {
      this.permanentLocalReason = "native_protection_capacity";
      if (rendered) {
        this.permanentRenderedReason = this.permanentLocalReason;
        this.stickyObservedGap ??= this.permanentLocalReason;
        this.reason = imageEvidence(this.permanentLocalReason);
      }
      this.textReady = false;
      this.reason = imageEvidence(this.permanentLocalReason);
      return;
    }
    this.values.add(value);
    try {
      this.classifier = this.makeClassifier();
    } catch {
      this.permanentLocalReason = "native_protection_classification_failed";
      if (rendered) {
        this.permanentRenderedReason = this.permanentLocalReason;
        this.stickyObservedGap ??= this.permanentLocalReason;
        this.reason = imageEvidence(this.permanentLocalReason);
      }
      this.textReady = false;
      this.reason = imageEvidence(this.permanentLocalReason);
    }
  }
  accept(receipt: GraphReceipt & { coveredValues?: string[] }) {
    if (this.disposed) return;
    this.mappingUnavailable = false;
    if (
      (receipt.textCandidateRefs?.length || receipt.imageCandidateRefs?.length) &&
      (receipt.textCandidateScope?.readId !== receipt.readId ||
        receipt.textCandidateScope?.policyGeneration !== receipt.policyGeneration ||
        (receipt.textCandidateRefs?.length ?? 0) > 500 ||
        (receipt.imageCandidateRefs?.length ?? 0) > 1000 ||
        [...(receipt.textCandidateRefs ?? []), ...(receipt.imageCandidateRefs ?? [])].some(
          (ref) =>
            !Number.isSafeInteger(ref.sourceOwner) ||
            ref.sourceOwner! < 0 ||
            ref.sourceOwner! >= 8192 ||
            !Array.isArray(ref.axRoles) ||
            ref.axRoles.length < 1 ||
            ref.axRoles.length > 3 ||
            ref.axRoles.some((role) => !policy.axRoles.includes(role)) ||
            ("boundIndex" in ref
              ? !Number.isSafeInteger(ref.boundIndex) || !this.bound[ref.boundIndex]
              : !Number.isSafeInteger(ref.learnedIndex) || !receipt.values[ref.learnedIndex]),
        ))
    ) {
      this.textReady = false;
      this.reason = imageEvidence("native_protection_attestation_invalid");
      return;
    }
    this.stickyObservedGap ??= receipt.observedRequiredGap;
    this.nodePrivateUnmapped = false;
    this.textReady = !this.permanentLocalReason && receipt.text === "complete";
    this.reason = this.permanentLocalReason
      ? imageEvidence(this.permanentLocalReason)
      : receipt.image;
    this.coveredBound = new Set(receipt.coveredBoundIndices);
    this.coveredValues = new Set(receipt.coveredValues ?? []);
    this.lastBrowserValues = new Set(receipt.values);
    this.requiredPresentations = (receipt.textCandidateRefs ?? []).map((ref, index) => ({
      sourceOwner: Number.isSafeInteger(ref.sourceOwner) ? ref.sourceOwner! : index,
      value: "boundIndex" in ref ? this.bound[ref.boundIndex]! : receipt.values[ref.learnedIndex]!,
      axRoles: ref.axRoles ?? ["unconfirmed"],
    }));
    this.imageRequirements = (receipt.imageCandidateRefs ?? []).map((ref, index) => ({
      sourceOwner: Number.isSafeInteger(ref.sourceOwner) ? ref.sourceOwner! : index,
      value: "boundIndex" in ref ? this.bound[ref.boundIndex]! : receipt.values[ref.learnedIndex]!,
      axRoles: ref.axRoles ?? ["unconfirmed"],
      whole: ref.coversWholeOwner === true,
    }));
    for (const value of receipt.values) this.retain(value);
  }
  get imageEvidence() {
    return this.permanentLocalReason ? imageEvidence(this.permanentLocalReason) : this.reason;
  }
  get learnedForBrowser() {
    return [...this.values];
  }
  get observedRequiredGap() {
    return this.stickyObservedGap;
  }
  captureReceipt(source: GraphReceipt): CaptureSample {
    return {
      version: source.version,
      readId: source.readId,
      policyGeneration: source.policyGeneration,
      ...(source.finalReadChallenge ? { finalReadChallenge: source.finalReadChallenge } : {}),
      text: this.textReady ? "complete" : "withheld",
      image: this.reason,
      knownRequirement: this.permanentLocalReason
        ? "unknown"
        : this.nodePrivateUnmapped
          ? "present"
          : source.knownRequirement,
      ...(this.stickyObservedGap ? { observedRequiredGap: this.stickyObservedGap } : {}),
    };
  }
  get textIssue() {
    return this.textReady
      ? undefined
      : (this.permanentLocalReason ??
          (this.mappingUnavailable
            ? "native_protection_classification_failed"
            : "native_protection_refresh_incomplete"));
  }
  get textProtectionReady() {
    return this.textReady && !this.permanentLocalReason;
  }
  private account(value: string, owner?: { key: string; role: string }) {
    if (!value) return;
    if (owner) {
      let mapping = this.mappedPresentations.get(value);
      if (!mapping) this.mappedPresentations.set(value, (mapping = new Map()));
      mapping.set(owner.key, owner.role);
    }
  }
  private exact(value: string, renderedScalar: boolean, owner?: { key: string; role: string }) {
    const findings = this.classifier.findings(value).filter((f) => f.category === "reference");
    if (renderedScalar)
      for (const f of findings) {
        const index = Number(f.name?.split("_").at(-1));
        const raw = f.name?.startsWith("bound_") ? this.bound[index] : [...this.values][index];
        if (raw) this.account(raw, owner);
      }
    return this.classifier.sanitizeExact(value);
  }
  dispose(clearHistory = true) {
    this.disposed = true;
    this.textReady = false;
    if (clearHistory) {
      this.values.clear();
      this.bound.length = 0;
      this.classifier = this.makeClassifier();
    }
    this.coveredBound.clear();
    this.coveredValues.clear();
    this.lastBrowserValues.clear();
    this.requiredPresentations = [];
    this.imageRequirements = [];
    this.mappedPresentations.clear();
  }
  cleanMetadata(text: string) {
    if (!this.textProtectionReady) return "[UNAVAILABLE:NATIVE_PROTECTION_TEXT]";
    let output = this.exact(text, false);
    for (const found of policy.intrinsic(output).sort((a: any, b: any) => b.start - a.start)) {
      this.retain(found.value, false);
      output = output.slice(0, found.start) + marker + output.slice(found.end);
    }
    return this.textReady ? output : "[UNAVAILABLE:NATIVE_PROTECTION_TEXT]";
  }
  private presentationProofComplete() {
    const sources = new Map<number, typeof this.requiredPresentations>();
    for (const requirement of this.requiredPresentations) {
      const list = sources.get(requirement.sourceOwner) ?? [];
      list.push(requirement);
      sources.set(requirement.sourceOwner, list);
    }
    const candidates = [...sources.values()].map((requirements) => {
      let common: Set<string> | undefined;
      for (const requirement of requirements) {
        const matches = new Set(
          [...(this.mappedPresentations.get(requirement.value) ?? new Map())]
            .filter(([, role]) => role !== "unconfirmed" && requirement.axRoles.includes(role))
            .map(([key]) => key),
        );
        common = common ? new Set([...common].filter((key) => matches.has(key))) : matches;
      }
      return [...(common ?? [])];
    });
    const assigned = new Map<string, number>();
    const assign = (index: number, seen: Set<string>): boolean => {
      for (const key of candidates[index]!) {
        if (!seen.has(key) && !assigned.has(key)) {
          assigned.set(key, index);
          return true;
        }
      }
      for (const key of candidates[index]!) {
        if (seen.has(key)) continue;
        seen.add(key);
        const previous = assigned.get(key);
        if (previous === undefined || assign(previous, seen)) {
          assigned.set(key, index);
          return true;
        }
      }
      return false;
    };
    return candidates.every((_, index) => assign(index, new Set()));
  }
  private imageProofComplete() {
    const graphOwners = new Map<number, typeof this.imageRequirements>();
    for (const requirement of this.imageRequirements) {
      const list = graphOwners.get(requirement.sourceOwner) ?? [];
      list.push(requirement);
      graphOwners.set(requirement.sourceOwner, list);
    }
    const axOwners = new Map<string, { role: string; values: Set<string> }>();
    for (const [value, mapping] of this.mappedPresentations)
      for (const [key, role] of mapping) {
        let owner = axOwners.get(key);
        if (!owner) axOwners.set(key, (owner = { role, values: new Set() }));
        owner.values.add(value);
      }
    const options = [...axOwners.values()].map((owner) =>
      owner.role === "unconfirmed"
        ? []
        : [...graphOwners]
            .filter(([, requirements]) =>
              [...owner.values].every((value) =>
                requirements.some(
                  (r) =>
                    r.axRoles.includes(owner.role) &&
                    (r.value === value || (r.whole && r.value.includes(value))),
                ),
              ),
            )
            .map(([key]) => key),
    );
    const assigned = new Map<number, number>();
    const assign = (index: number, seen: Set<number>): boolean => {
      for (const key of options[index]!) {
        if (!seen.has(key) && !assigned.has(key)) {
          assigned.set(key, index);
          return true;
        }
      }
      for (const key of options[index]!) {
        if (seen.has(key)) continue;
        seen.add(key);
        const prior = assigned.get(key);
        if (prior === undefined || assign(prior, seen)) {
          assigned.set(key, index);
          return true;
        }
      }
      return false;
    };
    return options.every((_, index) => assign(index, new Set()));
  }
  private checkImageProof() {
    if (!this.imageProofComplete()) {
      this.nodePrivateUnmapped = true;
      this.reason = imageEvidence("native_protection_geometry_unsupported");
      this.stickyObservedGap ??= "native_protection_geometry_unsupported";
    }
  }
  cleanAll(texts: readonly string[]) {
    for (const text of texts) this.clean(text, true);
    this.mappedPresentations.clear();
    const output = texts.map((text, index) => this.clean(text, true, "part:" + index));
    if (!this.presentationProofComplete()) {
      this.mappingUnavailable = true;
      this.textReady = false;
    }
    this.checkImageProof();
    return this.textReady ? output : texts.map(() => "[UNAVAILABLE:NATIVE_PROTECTION_TEXT]");
  }
  clean(text: string, deferMapping = false, namespace = "part:0") {
    if (!this.textProtectionReady) return "[UNAVAILABLE:NATIVE_PROTECTION_TEXT]";
    if (!deferMapping) this.mappedPresentations.clear();
    if (
      Buffer.byteLength(text) > 17 * 1048576 ||
      Buffer.byteLength(this.classifier.sanitizeExact(text)) > 1048576
    ) {
      this.textReady = false;
      this.permanentLocalReason = "native_protection_capacity";
      this.reason = imageEvidence(this.permanentLocalReason);
      return "[UNAVAILABLE:NATIVE_PROTECTION_TEXT]";
    }
    const lines = text.split("\n"),
      tokens: Scalar[] = [];
    try {
      for (let i = 0; i < lines.length; i++) {
        const token = scalar(lines[i]!, i);
        if (!token) continue;
        if (token.block) {
          let first = -1;
          const content = [];
          for (let j = i + 1; j < lines.length; j++) {
            if (!lines[j]!.trim()) {
              content.push("");
              token.endLine = j;
              continue;
            }
            const indent = /^\s*/u.exec(lines[j]!)![0].length;
            if (first < 0) first = indent;
            const parentIndent = /^\s*/u.exec(lines[i]!)![0].length;
            if (indent <= parentIndent || indent < first) break;
            content.push(lines[j]!.slice(first));
            token.endLine = j;
          }
          token.value = content.join("\n");
          i = token.endLine;
        }
        tokens.push(token);
        if (tokens.length > 10000) throw Error("capacity");
      }
    } catch {
      this.textReady = false;
      this.permanentLocalReason = "native_protection_classification_failed";
      this.reason = imageEvidence(this.permanentLocalReason);
      return "[UNAVAILABLE:NATIVE_PROTECTION_TEXT]";
    }
    // Learn only complete private scalar payloads, never an indented sibling subtree.
    for (const token of tokens) {
      if (token.private && token.value) {
        this.retain(token.value);
        this.account(token.value);
      }
      for (const found of policy.intrinsic(token.value)) {
        this.retain(found.value);
        this.account(found.value);
      }
    }
    if (!this.textProtectionReady) return "[UNAVAILABLE:NATIVE_PROTECTION_TEXT]";
    // The provider tree, not document-wide concatenation, establishes inline
    // ownership. Independent blocks/controls and URL metadata never become pieces
    // of a private owner. A quoted link NAME is one rendered inline piece.
    const stack: Scalar[] = [];
    for (const token of tokens) {
      while (stack.length && stack.at(-1)!.indent >= token.indent) stack.pop();
      token.parent = stack.at(-1);
      token.parent?.children.push(token);
      stack.push(token);
    }
    const inline = new Set([
        "text",
        "strong",
        "emphasis",
        "link",
        "subscript",
        "superscript",
        "mark",
        "deletion",
        "insertion",
      ]),
      containers = new Set([
        "code",
        "paragraph",
        "generic",
        "heading",
        "term",
        "definition",
        "blockquote",
        "cell",
        "columnheader",
        "rowheader",
        "caption",
      ]);
    type Piece = { token: Scalar; field: "label" | "value"; value: string };
    const ownPiece = (token: Scalar): Piece[] =>
      token.value
        ? [{ token, field: "value", value: token.value }]
        : token.role === "link" && token.label
          ? [{ token, field: "label", value: token.label }]
          : [];
    const groups: Array<{ owner: Scalar; pieces: Piece[] }> = [];
    const inlinePieces = (token: Scalar): Piece[] => [
      ...ownPiece(token),
      ...token.children.filter((t) => inline.has(t.role)).flatMap(inlinePieces),
    ];
    for (const token of tokens)
      if (token.children.length || containers.has(token.role)) {
        let group = ownPiece(token);
        for (const child of token.children) {
          if (inline.has(child.role)) group.push(...inlinePieces(child));
          else {
            if (group.length) groups.push({ owner: token, pieces: group });
            group = [];
          }
        }
        if (group.length) groups.push({ owner: token, pieces: group });
      }
    for (const { owner: groupOwner, pieces } of groups) {
      const owner = {
        key: namespace + ":" + groupOwner.line,
        role: groupOwner.children.some((child) => !inline.has(child.role))
          ? "unconfirmed"
          : groupOwner.role,
      };
      const joined = pieces.map((p) => p.value).join(""),
        matches = this.classifier.findings(joined).filter((f) => f.category === "reference");
      for (const f of matches) {
        const index = Number(f.name?.split("_").at(-1));
        const raw = f.name?.startsWith("bound_") ? this.bound[index] : [...this.values][index];
        if (raw) this.account(raw, owner);
      }
      let offset = 0;
      for (const piece of pieces) {
        const spans = matches
          .map((f) => ({
            start: Math.max(0, f.start - offset),
            end: Math.min(piece.value.length, f.start + f.length - offset),
          }))
          .filter((s) => s.end > s.start)
          .sort((a, b) => b.start - a.start);
        let value = piece.value;
        for (const span of spans)
          value = value.slice(0, span.start) + marker + value.slice(span.end);
        offset += piece.value.length;
        piece.token[piece.field] = value;
      }
    }
    const ownerOf = (token: Scalar) => {
      let origin = token;
      if (inline.has(token.role)) {
        let parent = token.parent;
        while (parent && inline.has(parent.role)) parent = parent.parent;
        if (parent) origin = parent;
      }
      return {
        key: namespace + ":" + origin.line,
        role: origin.children.some((child) => !inline.has(child.role))
          ? "unconfirmed"
          : origin.role,
      };
    };
    for (const token of tokens) {
      let prefix = token.prefix;
      if (token.nameStart !== undefined && token.nameEnd !== undefined) {
        let label = this.exact(token.label, true, ownerOf(token));
        const found = policy.intrinsic(label);
        for (const match of found) this.account(match.value, ownerOf(token));
        for (const match of [...found].sort((a: any, b: any) => b.start - a.start)) {
          this.retain(match.value);
          label = label.slice(0, match.start) + marker + label.slice(match.end);
        }
        prefix =
          prefix.slice(0, token.nameStart) + JSON.stringify(label) + prefix.slice(token.nameEnd);
      }
      const exactValue = this.exact(token.value, true, ownerOf(token));
      const value = token.private && token.hasValue && token.value ? marker : exactValue;
      lines[token.line] =
        prefix + (token.hasValue ? " " + (token.quoted ? JSON.stringify(value) : value) : "");
      for (let j = token.line + 1; j <= token.endLine; j++) lines[j] = "";
    }
    if (!deferMapping) this.checkImageProof();
    if (!deferMapping && !this.presentationProofComplete()) {
      this.mappingUnavailable = true;
      this.textReady = false;
      return "[UNAVAILABLE:NATIVE_PROTECTION_TEXT]";
    }
    // URL/title/tool metadata is text-only: redact known/strong values without
    // manufacturing a rendered candidate or an image gap from a metadata match.
    let output = this.exact(lines.join("\n"), false);
    const metadataFindings = policy.intrinsic(output).sort((a: any, b: any) => b.start - a.start);
    for (const found of metadataFindings) {
      this.retain(found.value, false);
      output = output.slice(0, found.start) + marker + output.slice(found.end);
    }
    return this.textReady ? output : "[UNAVAILABLE:NATIVE_PROTECTION_TEXT]";
  }
}
