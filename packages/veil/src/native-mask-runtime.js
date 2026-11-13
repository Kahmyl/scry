// Whole-owner HTML bounds use layout and device scale only. Private ink may
// reject admission, but must never size or phase the opaque mask.
function nativeWholeOwnerEnvelope(box, ink, guard) {
  const coordinates = [
    box.left,
    box.top,
    box.right,
    box.bottom,
    ink.left,
    ink.top,
    ink.right,
    ink.bottom,
    guard,
  ];
  if (
    !coordinates.every(Number.isFinite) ||
    guard <= 0 ||
    box.right <= box.left ||
    box.bottom <= box.top ||
    ink.right < ink.left ||
    ink.bottom < ink.top
  )
    return null;
  const left = box.left - guard,
    top = box.top - guard,
    right = box.right + guard,
    bottom = box.bottom + guard;
  if (
    ink.left - guard < left ||
    ink.top - guard < top ||
    ink.right + guard > right ||
    ink.bottom + guard > bottom
  )
    return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}
// An ordinary document box cannot paint through an opaque fullscreen surface.
// This proves only public-overlap occlusion; private candidates are never omitted.
function nativeFullscreenOccludesPublicPaint(owner, other, box) {
  try {
    const fullscreen = document.fullscreenElement;
    if (
      !fullscreen ||
      fullscreen.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
      fullscreen.ownerDocument !== document ||
      fullscreen.getRootNode() !== document ||
      !fullscreen.matches(":fullscreen")
    )
      return false;
    const parent = (node) => node.assignedSlot ?? node.parentElement ?? node.getRootNode()?.host;
    let inside = false,
      node = owner,
      depth = 0;
    while (node && node.nodeType === 1) {
      if (++depth > 128) return false;
      if (node === fullscreen) {
        inside = true;
        break;
      }
      node = parent(node);
    }
    if (!inside) return false;
    // overlay:auto also catches pending top-layer removals and their descendants,
    // which may still paint after :popover-open or :modal stops matching.
    node = other;
    depth = 0;
    while (node && node.nodeType === 1) {
      if (++depth > 128 || node === fullscreen || getComputedStyle(node).overlay !== "none")
        return false;
      node = parent(node);
    }
    const style = getComputedStyle(fullscreen);
    if (
      style.overlay !== "auto" ||
      !/^rgb\(\d+,\s*\d+,\s*\d+\)$/u.test(style.backgroundColor) ||
      style.opacity !== "1" ||
      style.backgroundClip !== "border-box" ||
      style.borderRadius !== "0px" ||
      style.backgroundImage !== "none" ||
      style.backgroundBlendMode !== "normal" ||
      style.mixBlendMode !== "normal" ||
      style.filter !== "none" ||
      style.backdropFilter !== "none" ||
      style.clipPath !== "none" ||
      style.maskImage !== "none" ||
      style.transform !== "none" ||
      style.perspective !== "none" ||
      style.animationName !== "none" ||
      (style.transitionProperty !== "all" && style.transitionProperty !== "none")
    )
      return false;
    if (style.transitionDuration.split(",").some((duration) => Number.parseFloat(duration) !== 0))
      return false;
    const surface = fullscreen.getBoundingClientRect();
    return (
      [
        surface.left,
        surface.top,
        surface.right,
        surface.bottom,
        box.left,
        box.top,
        box.right,
        box.bottom,
      ].every(Number.isFinite) &&
      box.right > box.left &&
      box.bottom > box.top &&
      box.left >= surface.left &&
      box.top >= surface.top &&
      box.right <= surface.right &&
      box.bottom <= surface.bottom
    );
  } catch {
    return false;
  }
}
/* Shared native privacy graph. Loaded literally in an isolated world. */
function installNativePrivacyGraph(initialBound, options = {}) {
  if (globalThis.__scryNativeGraph?.version === 2) {
    globalThis.__scryNativeGraph.bind(initialBound, options.policyGeneration);
    globalThis.__scryNativeGraph.learn(options.initialLearned ?? []);
    return;
  }

  const limits = Object.assign(
    {
      roots: 512,
      nodes: 8192,
      textNodes: 3000,
      controls: 500,
      presentations: 500,
      textBytes: 1048576,
      pseudoElements: 4096,
      rectangles: 2048,
      depth: 128,
    },
    options,
  );
  const bound = new Set(),
    boundList = [],
    learned = new Set();
  let learnedBytes = 0,
    readId = 0,
    policyGeneration = options.policyGeneration ?? 1,
    revision = 0,
    graph = null,
    overlay,
    layer,
    scheduled = false,
    disposed = false;
  let activeImageToken, notifiedImageToken;
  let boundBytes = 0;
  let permanentReason,
    observedGap,
    readChallenge,
    associations = new Map();
  const recovery = (reason) =>
    ["native_protection_refresh_incomplete", "native_protection_geometry_stale"].includes(reason)
      ? "read_only_once"
      : "preserve_gap";
  const evidence = (reason) =>
    reason
      ? { state: "withheld", reason, recovery: recovery(reason) }
      : { state: "available", assessment: "best_effort_known_candidates" };
  const retain = (value) => {
    if (!value || bound.has(value) || learned.has(value)) return true;
    if (value.length > 4096 || learned.size >= 128 || learnedBytes + value.length * 2 > 65536) {
      permanentReason = "native_protection_capacity";
      return false;
    }
    learned.add(value);
    learnedBytes += value.length * 2;
    return true;
  };
  const bind = (values, nextPolicy) => {
    for (const value of values) {
      if (!value || bound.has(value)) continue;
      if (
        bound.size >= nativeControlLimits.boundValues ||
        boundBytes + value.length * 2 > nativeControlLimits.boundBytes
      ) {
        permanentReason = "native_protection_capacity";
        break;
      }
      bound.add(value);
      boundList.push(value);
      boundBytes += value.length * 2;
    }
    if (Number.isSafeInteger(nextPolicy) && nextPolicy >= policyGeneration)
      policyGeneration = nextPolicy;
  };
  bind(initialBound, policyGeneration);
  for (const value of options.initialLearned ?? []) retain(value);
  if (options.limited) permanentReason = "native_protection_capacity";
  const observeGap = (reason) => {
    const first = !observedGap;
    observedGap ??= reason;
    if (!first && (activeImageToken === undefined || notifiedImageToken === activeImageToken))
      return;
    if (activeImageToken !== undefined) notifiedImageToken = activeImageToken;
    try {
      globalThis.__scryNativeGap?.(
        JSON.stringify({
          version: 1,
          epoch: options.captureEpoch,
          policyGeneration,
          reason,
          ...(activeImageToken === undefined ? {} : { imageCaptureToken: activeImageToken }),
        }),
      );
    } catch {}
  };
  const countEmpty = () => ({
    roots: 0,
    nodes: 0,
    textNodes: 0,
    controls: 0,
    presentations: 0,
    pseudoReads: 0,
    rectangles: 0,
  });
  function nativeAdjacentDOMLabel(element, canonicalLabels, representedValue) {
    if (canonicalLabels.length) return undefined;
    const previous = element.previousElementSibling;
    if (
      !previous ||
      previous.parentElement !== element.parentElement ||
      previous.getRootNode() !== element.getRootNode()
    )
      return undefined;
    const previousStyle = getComputedStyle(previous);
    const explicitName =
      element.hasAttribute("aria-label") ||
      element.hasAttribute("aria-labelledby") ||
      element.hasAttribute("title");
    const control = element.localName === "input" || element.localName === "textarea";
    const role = element.getAttribute("role") ?? "";
    const interactiveRole =
      /^(?:button|checkbox|radio|switch|combobox|listbox|option|menuitem|link|slider|spinbutton)$/u;
    const atomic = (node) => {
      let visited = 0;
      const stack = [{ node, depth: 0 }];
      while (stack.length) {
        const current = stack.pop();
        if (++visited > 256 || current.depth > 16) return false;
        for (const child of current.node.childNodes) {
          if (++visited > 256) return false;
          if (child.nodeType === 3) continue;
          if (
            child.nodeType !== 1 ||
            !/^(?:span|b|i|em|strong|small|sup|sub|code|samp|kbd)$/u.test(child.localName)
          )
            return false;
          stack.push({ node: child, depth: current.depth + 1 });
        }
      }
      return true;
    };
    return nativeAdjacentFieldLabel({
      hasCanonicalName: explicitName,
      ownMetadata: [element.name, element.id].some(nativePublicMetadata),
      labelHidden:
        previous.getClientRects().length === 0 ||
        previousStyle.display === "none" ||
        previousStyle.visibility === "hidden" ||
        previousStyle.opacity === "0",
      sameParent: true,
      pureTextLabel:
        previous.childNodes.length <= 16 &&
        [...previous.childNodes].every((node) => node.nodeType === 3),
      label: previous.textContent,
      labelTag: previous.localName,
      labelHasFor: previous.hasAttribute("for"),
      labelHasExplicitName:
        previous.hasAttribute("aria-label") || previous.hasAttribute("aria-labelledby"),
      labelInteractive:
        previous.hasAttribute("tabindex") ||
        previous.hasAttribute("onclick") ||
        /^(?:button|a|summary)$/u.test(previous.localName) ||
        interactiveRole.test(previous.getAttribute("role") ?? ""),
      control,
      type: element.type,
      role,
      readonly: element.readOnly === true || element.disabled === true,
      atomicTarget: control || atomic(element),
      value: control ? element.value : (representedValue ?? element.textContent),
      editable: element.isContentEditable === true,
      interactiveTarget:
        !control &&
        (interactiveRole.test(role) ||
          element.hasAttribute("tabindex") ||
          /^(?:button|a|summary|select|option|label|legend|h[1-6])$/u.test(element.localName)),
      presentation:
        !control &&
        /^(?:p|span|div|dd|code|output|pre|samp|kbd|data|text|tspan)$/u.test(element.localName),
    });
  }

  const sourceLabels = (element, representedValue) => {
    const labelNodes = new Set(associations.get(element.getRootNode())?.get(element.id) ?? []),
      labels = [],
      bounded = (value) => {
        const text = String(value ?? "");
        if (text.length > 8192) throw Error("capacity");
        return text;
      };
    const aria = element.getAttribute("aria-label");
    if (aria) labels.push(bounded(aria));
    const references = String(element.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/u)
      .filter(Boolean);
    if (references.length > 16) throw Error("capacity");
    for (const id of references) {
      const root = element.getRootNode();
      labels.push(bounded(root.getElementById?.(id)?.textContent));
    }
    // A group's name is not the payload's name. Only explicit owner references
    // and actual wrapping/for-label relationships contribute naming authority.
    let current = element,
      depth = 0;
    while (current && current.nodeType === 1 && depth++ < 128) {
      if (current.localName === "label") {
        labelNodes.add(current);
        break;
      }
      current = current.assignedSlot ?? current.parentElement ?? current.getRootNode()?.host;
    }
    if (labelNodes.size > 16) throw Error("capacity");
    for (const label of labelNodes) {
      if (payloadControl(element)) {
        labels.push(bounded(label.textContent));
        continue;
      }
      const texts = [],
        stack = [...label.childNodes];
      while (stack.length) {
        const n = stack.shift();
        if (
          n === element ||
          (n.nodeType === 1 &&
            ["input", "textarea", "code", "output", "pre", "svg"].includes(n.localName))
        )
          continue;
        if (n.nodeType === 3) texts.push(n.textContent);
        else stack.unshift(...n.childNodes);
      }
      labels.push(bounded(texts.join(" ")));
    }
    if (labels.length > 16 || labels.reduce((n, s) => n + s.length, 0) > 8192)
      throw Error("capacity");
    const adjacent = nativeAdjacentDOMLabel(element, labels, representedValue);
    if (adjacent) labels.push(adjacent);
    return labels;
  };
  const controlFacts = (element) => ({
    type: element.type,
    role: element.getAttribute("role"),
    name: element.name,
    id: element.id,
    autocomplete: element.getAttribute("autocomplete"),
    explicit:
      element.hasAttribute("data-scry-secret") || element.hasAttribute("data-scry-financial"),
  });
  const payloadControl = (element) =>
    element.localName === "input" || element.localName === "textarea";
  const caption = (element) =>
    /^(?:label|legend|summary|h[1-6]|dt|th|button|option|select)$/u.test(element.localName) ||
    element.getAttribute("role") === "heading";
  const formatting = new Set([
    "span",
    "b",
    "i",
    "em",
    "strong",
    "small",
    "sup",
    "sub",
    "tspan",
    "a",
  ]);
  const atomic = (element) =>
    [...element.childNodes].every(
      (n) => n.nodeType === 3 || (n.nodeType === 1 && formatting.has(n.localName) && atomic(n)),
    );
  const payloadOwner = (element) =>
    !element.shadowRoot &&
    !caption(element) &&
    !payloadControl(element) &&
    ![
      "html",
      "body",
      "form",
      "section",
      "article",
      "main",
      "nav",
      "aside",
      "header",
      "footer",
      "dialog",
    ].includes(element.localName) &&
    (["code", "output", "pre", "samp", "kbd", "data", "text", "tspan"].includes(
      element.localName,
    ) ||
      (element.childNodes.length > 0 && atomic(element)));
  const insideAtomicOwner = (element) => {
    let n = element.parentElement;
    while (n && !caption(n)) {
      if (payloadOwner(n) && atomic(n)) return true;
      n = n.parentElement;
    }
    return false;
  };
  const insideActionCaption = (element) => {
    let n = element.parentElement;
    while (n) {
      if (caption(n) && n.localName !== "label") return true;
      n = n.parentElement ?? n.getRootNode()?.host;
    }
    return false;
  };
  const textRuns = (element) => {
    const out = [];
    let value = "";
    const flush = () => {
      if (value) out.push(value);
      value = "";
    };
    const visit = (n) => {
      if (n.nodeType === 3) value += n.textContent;
      else if (n.nodeType === 1 && formatting.has(n.localName))
        for (const child of n.childNodes) visit(child);
      else flush();
    };
    for (const n of element.childNodes) visit(n);
    flush();
    return out;
  };
  // A closed native select paints its selected option in the select control,
  // not in the zero-layout OPTION node. Preserve the option as text authority.
  const renderedElement = (element) => {
    if (element.localName === "option" && element.selected && !element.getClientRects().length) {
      const select = element.closest("select");
      if (select && !select.multiple && select.size <= 1) return select;
    }
    return element;
  };
  const hiddenByClosedDetails = (element) => {
    let node = element,
      depth = 0;
    const seen = new Set();
    while (node) {
      if (++depth > 128 || seen.has(node)) {
        permanentReason = "native_protection_capacity";
        return true; // The finite output below withholds, never certifies invisibility.
      }
      seen.add(node);
      const parent = node.assignedSlot ?? node.parentElement ?? node.getRootNode()?.host;
      if (parent?.localName === "details" && !parent.open) {
        const firstSummary = [...parent.children].find((child) => child.localName === "summary");
        if (node !== firstSummary) {
          // Closed state alone is insufficient: author CSS can expose details content.
          // Only the native rendering predicate may discharge this hidden owner.
          try {
            if (
              typeof element.checkVisibility === "function" &&
              element.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
                contentVisibilityAuto: true,
              }) === false
            )
              return true;
          } catch {
            /* Unknown remains subject to the existing visible/fail-closed path. */
          }
        }
      }
      node = parent;
    }
    return false;
  };
  const visible = (element) => {
    if (hiddenByClosedDetails(element)) return false;
    element = renderedElement(element);
    const s = getComputedStyle(element);
    return (
      s.display !== "none" &&
      s.visibility !== "hidden" &&
      s.opacity !== "0" &&
      element.getClientRects().length > 0
    );
  };
  const unsupportedStyle = (element, pseudo) => {
    const s = getComputedStyle(element, pseudo);
    return (
      s.transform !== "none" ||
      s.textShadow !== "none" ||
      s.filter !== "none" ||
      s.writingMode !== "horizontal-tb" ||
      s.textTransform !== "none" ||
      s.animationName !== "none" ||
      (pseudo && ["absolute", "fixed"].includes(s.position))
    );
  };
  const pseudoValue = (element, which) => {
    const content = getComputedStyle(element, which).content;
    if (content === "none" || content === "normal" || !content) return null;
    const attr = /^attr\(\s*([a-zA-Z_][a-zA-Z0-9_:-]*)\s*\)$/u.exec(content);
    if (attr) return { value: element.getAttribute(attr[1]) ?? "", supported: true };
    // Bounded JSON-compatible CSS quoted content is supported in this experiment.
    if (/^"(?:[^"\\]|\\["\\])*"$/u.test(content))
      return { value: JSON.parse(content), supported: true };
    return { value: "", supported: false };
  };
  function build(id) {
    const start = performance.now(),
      count = countEmpty(),
      owners = [],
      roots = [],
      elements = [],
      controls = [],
      candidateValues = new Set();
    let reason = permanentReason;
    const add = (element, value, kind, source, whole, pseudo) => {
      if (!value) return;
      if (kind !== "control" && ++count.presentations > limits.presentations)
        throw Error("capacity");
      owners.push({ element, value, kind, source, whole, pseudo });
      candidateValues.add(value);
    };
    try {
      const stack = [{ node: document.documentElement, depth: 0 }],
        seen = new Set();
      count.roots = 1;
      roots.push(document);
      while (stack.length) {
        const { node, depth } = stack.pop();
        if (!node || seen.has(node) || node === overlay) continue;
        seen.add(node);
        if (++count.nodes > limits.nodes || depth > limits.depth) throw Error("capacity");
        if (node.nodeType === 3) {
          if (++count.textNodes > limits.textNodes) throw Error("capacity");
          continue;
        }
        if (node.nodeType !== 1) continue;
        const element = node;
        if (["script", "style", "noscript", "template"].includes(element.localName)) continue;
        elements.push(element);
        if (element.shadowRoot) {
          if (++count.roots > limits.roots) throw Error("capacity");
          roots.push(element.shadowRoot);
          for (const n of [...element.shadowRoot.childNodes].reverse())
            stack.push({ node: n, depth: depth + 1 });
        }
        for (const child of [...element.childNodes].reverse())
          stack.push({ node: child, depth: depth + 1 });
        if (payloadControl(element)) {
          if (++count.controls > limits.controls) throw Error("capacity");
          controls.push(element);
        }
      }
      associations = new Map();
      for (const label of elements)
        if (label.localName === "label" && label.hasAttribute("for")) {
          const root = label.getRootNode(),
            id = label.getAttribute("for");
          let map = associations.get(root);
          if (!map) associations.set(root, (map = new Map()));
          const list = map.get(id) ?? [];
          list.push(label);
          map.set(id, list);
        }
      for (const element of controls) {
        const value = element.value;
        if (!value) continue;
        if (bound.has(value) || learned.has(value)) {
          // Known payloads remain authoritative, but source truncation is not a
          // complete semantic assessment of an ordinary text control.
          const basic = nativeClassifyControl({
            type: element.type,
            role: element.getAttribute("role"),
            explicit:
              element.hasAttribute("data-scry-secret") ||
              element.hasAttribute("data-scry-financial"),
          });
          if (basic.needsLabels) sourceLabels(element);
          add(element, value, "control", "known", true);
          continue;
        }
        const facts = controlFacts(element);
        let decision = nativeClassifyControl({
          type: facts.type,
          role: facts.role,
          explicit: facts.explicit,
        });
        if (decision.needsLabels) {
          if ([facts.name, facts.id, facts.autocomplete].some((v) => String(v ?? "").length > 8192))
            throw Error("capacity");
          decision = nativeClassifyControl(facts);
        }
        if (decision.needsLabels) {
          facts.labels = sourceLabels(element);
          if (facts.labels.length > 16 || facts.labels.some((s) => s.length > 8192))
            throw Error("capacity");
          decision = nativeClassifyControl(facts);
        }
        if (decision.learn) {
          retain(value);
          add(element, value, "control", "private", true);
        } else if (decision.mask) {
          add(element, value, "control", "explicit", true);
        } else {
          for (const known of [...bound, ...learned])
            if (value.includes(known)) {
              add(element, known, "control", "known", false);
              break;
            }
          if (nativePayloadControl(element.type, element.getAttribute("role")))
            for (const found of nativeIntrinsicFindings(value)) {
              retain(found.value);
              add(element, found.value, "control", "intrinsic", value === found.value);
            }
        }
      }
      let scanned = 0,
        pseudoElements = 0;
      for (const element of elements) {
        if (payloadControl(element)) continue;
        const isOwner = (payloadOwner(element) || caption(element)) && !insideAtomicOwner(element),
          text = isOwner ? String(element.textContent ?? "") : "";
        for (const run of isOwner ? textRuns(element) : []) {
          const whole = atomic(element) && text === run;
          if ((scanned += run.length * 2) > limits.textBytes) throw Error("capacity");
          const facts = {
              labels:
                caption(element) || insideActionCaption(element) ? [] : sourceLabels(element, run),
              explicit:
                element.hasAttribute("data-scry-secret") ||
                element.hasAttribute("data-scry-financial"),
            },
            decision = nativePresentationDecision(facts);
          if (bound.has(run) || learned.has(run)) add(element, run, "presentation", "known", whole);
          else if (decision.private && !caption(element) && !insideActionCaption(element)) {
            retain(run);
            add(element, run, "presentation", "private", whole);
          } else {
            for (const known of [...bound, ...learned])
              if (known && run.includes(known))
                add(element, known, "presentation", "known", whole && run === known);
            for (const found of nativeIntrinsicFindings(run)) {
              retain(found.value);
              add(element, found.value, "presentation", "intrinsic", whole && run === found.value);
            }
          }
        }
        if (++pseudoElements > limits.pseudoElements) throw Error("capacity");
        for (const pseudo of ["::before", "::after"]) {
          count.pseudoReads++;
          const generated = pseudoValue(element, pseudo);
          if (!generated) continue;
          const facts = {
              labels:
                caption(element) || insideActionCaption(element)
                  ? []
                  : sourceLabels(element, generated.supported ? generated.value : undefined),
              explicit:
                element.hasAttribute("data-scry-secret") ||
                element.hasAttribute("data-scry-financial"),
            },
            decision = nativePresentationDecision(facts);
          if (!generated.supported) {
            if (decision.private) reason ??= "native_protection_geometry_unsupported";
            continue;
          }
          const value = generated.value;
          if (!value) continue;
          if ((scanned += value.length * 2) > limits.textBytes) throw Error("capacity");
          if (bound.has(value) || learned.has(value)) {
            add(element, value, "pseudo", "known", text === "", pseudo);
          } else if (decision.private) {
            retain(value);
            add(element, value, "pseudo", "private", text === "", pseudo);
          } else
            for (const found of nativeIntrinsicFindings(value)) {
              retain(found.value);
              add(
                element,
                found.value,
                "pseudo",
                "intrinsic",
                text === "" && value === found.value,
                pseudo,
              );
            }
        }
      }
    } catch {
      reason ??= "native_protection_graph_capacity";
    }
    if (permanentReason) reason = permanentReason;
    for (let i = owners.length - 1; i >= 0; i--) {
      const owner = owners[i];
      const enclosing = owners.find(
        (other) =>
          other !== owner &&
          other.whole &&
          other.value === owner.value &&
          caption(other.element) &&
          other.element.localName !== "label" &&
          other.element !== owner.element &&
          other.element.contains(owner.element),
      );
      if (enclosing) {
        owners.splice(i, 1);
        continue;
      }
      const nested = owners.find(
        (other) =>
          other !== owner &&
          other.value === owner.value &&
          owner.element !== other.element &&
          owner.element.contains(other.element),
      );
      if (
        nested &&
        (!owner.whole || (caption(owner.element) && owner.element.localName === "label"))
      )
        owners.splice(i, 1);
    }
    observer.disconnect();
    for (const root of roots)
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    return {
      id,
      revision,
      policyGeneration,
      count,
      owners,
      elements,
      reason,
      textComplete: ![
        "native_protection_graph_capacity",
        "native_protection_capacity",
        "native_protection_classification_failed",
      ].includes(reason),
      ms: performance.now() - start,
    };
  }
  const ancestor = (element, possible) => {
    let n = element;
    while (n) {
      if (n === possible) return true;
      n = n.assignedSlot ?? n.parentElement ?? n.getRootNode()?.host;
    }
    return false;
  };
  const paintChainSupported = (element) => {
    let current = element,
      depth = 0;
    while (current && current.nodeType === 1) {
      if (++depth > 128) return false;
      const style = getComputedStyle(current);
      if (
        unsupportedStyle(current) ||
        style.backdropFilter !== "none" ||
        style.mixBlendMode !== "normal" ||
        style.perspective !== "none" ||
        style.clipPath !== "none" ||
        style.maskImage !== "none"
      )
        return false;
      current = current.assignedSlot ?? current.parentElement ?? current.getRootNode()?.host;
    }
    return true;
  };
  const intersects = (a, b) =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  function paintEnvelope(owner) {
    const element = owner.element,
      rendered = renderedElement(element),
      box = rendered.getBoundingClientRect();
    if (rendered !== element) return { box, element: rendered };
    if (owner.kind === "control") return { box, element };
    const value = owner.value;
    if (!/^[\x20-\x7e]*$/u.test(value) || value.length > 4096) return null;
    if (element.namespaceURI === "http://www.w3.org/2000/svg") {
      const svg = element.closest("svg");
      if (
        svg &&
        svg.textContent.trim() === value &&
        [...svg.querySelectorAll("*")].every((n) => ["text", "tspan"].includes(n.localName))
      )
        return { box: svg.getBoundingClientRect(), element: svg };
      if (
        typeof element.getNumberOfChars !== "function" ||
        typeof element.getExtentOfChar !== "function" ||
        element.hasAttribute("rotate") ||
        element.hasAttribute("textLength") ||
        element.hasAttribute("lengthAdjust")
      )
        return null;
      const matrix = element.getScreenCTM();
      if (
        !matrix ||
        matrix.a !== 1 ||
        matrix.d !== 1 ||
        matrix.b !== 0 ||
        matrix.c !== 0 ||
        element.getNumberOfChars() > 4096
      )
        return null;
      let left = Infinity,
        top = Infinity,
        right = -Infinity,
        bottom = -Infinity;
      const guard = 1 / (devicePixelRatio || 1);
      for (let i = 0; i < element.getNumberOfChars(); i++) {
        const cell = element.getExtentOfChar(i);
        left = Math.min(left, cell.x + matrix.e - guard);
        top = Math.min(top, cell.y + matrix.f - guard);
        right = Math.max(right, cell.x + cell.width + matrix.e + guard);
        bottom = Math.max(bottom, cell.y + cell.height + matrix.f + guard);
      }
      return Number.isFinite(left)
        ? { box: { left, top, right, bottom, width: right - left, height: bottom - top }, element }
        : null;
    }
    const style = getComputedStyle(element, owner.pseudo),
      canvas = document.createElement("canvas"),
      ctx = canvas.getContext("2d");
    if (
      (style.letterSpacing !== "normal" && style.letterSpacing !== "0px") ||
      (style.wordSpacing !== "normal" && style.wordSpacing !== "0px") ||
      document.fonts?.status !== "loaded"
    )
      return null;
    ctx.font = style.font;
    const metrics = ctx.measureText(value),
      guard = 1 / (devicePixelRatio || 1);
    if (owner.kind === "pseudo") {
      // Only normal-flow single-value generated text with ample allocated slot is supported.
      if (
        box.width < metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight + 2 * guard ||
        box.height < metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent + 2 * guard
      )
        return null;
      return { box, element };
    }
    const range = document.createRange();
    range.selectNodeContents(element);
    const cells = [...range.getClientRects()];
    if (!cells.length) return null;
    const first = cells[0];
    if (
      cells.some(
        (c) => Math.abs(c.top - first.top) > 0.02 || Math.abs(c.bottom - first.bottom) > 0.02,
      )
    )
      return null;
    for (const child of element.querySelectorAll("*")) {
      const childStyle = getComputedStyle(child);
      if (
        childStyle.font !== style.font ||
        childStyle.letterSpacing !== style.letterSpacing ||
        childStyle.wordSpacing !== style.wordSpacing ||
        childStyle.verticalAlign !== "baseline" ||
        childStyle.position !== "static"
      )
        return null;
    }
    const cell = {
      left: Math.min(...cells.map((c) => c.left)),
      right: Math.max(...cells.map((c) => c.right)),
      top: first.top,
      bottom: first.bottom,
      height: first.height,
    };
    cell.width = cell.right - cell.left;
    if (
      Math.abs(cell.width - metrics.width) > 0.02 ||
      !Number.isFinite(metrics.fontBoundingBoxAscent) ||
      !Number.isFinite(metrics.fontBoundingBoxDescent) ||
      Math.abs(cell.height - metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) > 1
    )
      return null;
    const baseline = cell.bottom - metrics.fontBoundingBoxDescent;
    const stable = nativeWholeOwnerEnvelope(
      box,
      {
        left: cell.left - metrics.actualBoundingBoxLeft,
        right: cell.left + metrics.actualBoundingBoxRight,
        top: baseline - metrics.actualBoundingBoxAscent,
        bottom: baseline + metrics.actualBoundingBoxDescent,
      },
      guard,
    );
    return stable ? { box: stable, element } : null;
  }

  function geometry(g) {
    const rectangles = [];
    let reason = g.reason;
    for (const owner of g.owners) {
      const element = owner.element;
      if (!element.isConnected) {
        reason ??= "native_protection_geometry_stale";
        continue;
      }
      if (!visible(element)) continue;
      if (
        (owner.kind !== "control" && !owner.whole) ||
        unsupportedStyle(element, owner.pseudo) ||
        !paintChainSupported(element)
      ) {
        reason ??= "native_protection_geometry_unsupported";
        continue;
      }
      // Full value-owner coverage is restricted to atomic private paint.
      if (
        [...element.children].some((child) => !formatting.has(child.localName)) ||
        [...element.querySelectorAll("*")].some(
          (child) =>
            payloadControl(child) ||
            caption(child) ||
            ["svg", "canvas", "img", "button"].includes(child.localName) ||
            unsupportedStyle(child),
        )
      ) {
        reason ??= "native_protection_geometry_unsupported";
        continue;
      }
      const envelope = paintEnvelope(owner);
      if (!envelope) {
        reason ??= "native_protection_geometry_unsupported";
        continue;
      }
      const box = envelope.box,
        paintElement = envelope.element;
      if (owner.kind !== "control")
        for (const other of g.elements) {
          if (
            other === paintElement ||
            ancestor(paintElement, other) ||
            ancestor(other, paintElement) ||
            !visible(other)
          )
            continue;
          const b = other.getBoundingClientRect();
          if (!intersects(box, b)) continue;
          if (nativeFullscreenOccludesPublicPaint(paintElement, other, box)) continue;
          const s = getComputedStyle(other);
          if (
            other.textContent?.trim() ||
            s.backgroundImage !== "none" ||
            s.backgroundColor !== "rgba(0, 0, 0, 0)" ||
            ["svg", "canvas", "img"].includes(other.localName)
          ) {
            reason ??= "native_protection_geometry_unsupported";
            break;
          }
        }
      if (box.width <= 0 || box.height <= 0) {
        reason ??= "native_protection_geometry_unsupported";
        continue;
      }
      const ratio = devicePixelRatio || 1,
        left = Math.floor(Math.max(0, box.left) * ratio) / ratio,
        top = Math.floor(Math.max(0, box.top) * ratio) / ratio,
        right = Math.ceil(Math.min(innerWidth, box.right) * ratio) / ratio,
        bottom = Math.ceil(Math.min(innerHeight, box.bottom) * ratio) / ratio;
      if (right > left && bottom > top)
        rectangles.push({
          left,
          top,
          width: right - left,
          height: bottom - top,
          boundIndex: boundList.indexOf(owner.value),
        });
      if (rectangles.length > limits.rectangles) {
        reason = "native_protection_graph_capacity";
        break;
      }
    }
    g.count.rectangles = rectangles.length;
    return { rectangles, reason };
  }
  const createLayer = () => {
    if (overlay?.isConnected) return;
    overlay = document.createElement("div");
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.cssText =
      "all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important";
    const shadow = overlay.attachShadow({ mode: "closed" }),
      style = document.createElement("style");
    style.textContent =
      "[popover]::backdrop{background:transparent!important;opacity:0!important;pointer-events:none!important}";
    layer = document.createElement("div");
    layer.setAttribute("popover", "manual");
    layer.setAttribute("aria-hidden", "true");
    layer.style.cssText =
      "all:initial!important;display:block!important;position:fixed!important;inset:0!important;width:auto!important;height:auto!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;pointer-events:none!important";
    shadow.append(style, layer);
    document.documentElement.append(overlay);
  };
  const axExcluded = (element) => {
    let node = element;
    while (node) {
      if (
        String(node.getAttribute?.("aria-hidden")).toLowerCase() === "true" ||
        node.hasAttribute?.("inert")
      )
        return true;
      node = node.assignedSlot ?? node.parentElement ?? node.getRootNode()?.host;
    }
    return false;
  };
  const projectionOwner = (element) => {
    let parent = element.parentElement;
    while (parent && formatting.has(element.localName)) {
      if (parent.localName === "button" || /^h[1-6]$/u.test(parent.localName)) return parent;
      if (!formatting.has(parent.localName)) break;
      element = parent;
      parent = parent.parentElement;
    }
    return element;
  };
  const axRoles = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit && explicit !== "none" && explicit !== "presentation")
      return nativeAXRoleFamilies.includes(explicit) ? [explicit] : ["unconfirmed"];
    const tag = element.localName;
    if (tag === "input" || tag === "textarea")
      return [
        element.type === "number"
          ? "spinbutton"
          : element.type === "button" || element.type === "submit" || element.type === "reset"
            ? "button"
            : "textbox",
      ];
    if (tag === "code") return ["code"];
    if (tag === "p") return ["paragraph"];
    if (tag === "button") return ["button"];
    if (tag === "option") return ["option"];
    if (tag === "a" && element.hasAttribute("href")) return ["link"];
    if (/^h[1-6]$/u.test(tag)) return ["heading"];
    if (tag === "pre" || tag === "samp" || tag === "kbd") return ["code", "generic", "text"];
    if (tag === "output") return ["status", "generic", "text"];
    if (element.namespaceURI === "http://www.w3.org/2000/svg") return ["text", "generic", "img"];
    return ["generic", "text"];
  };
  const required = (owner) => {
    if (!visible(owner.element)) return false;
    if (!paintChainSupported(owner.element)) return true;
    const b = renderedElement(owner.element).getBoundingClientRect();
    return b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight;
  };
  const output = (g, image) => ({
    version: 1,
    readId: g.id,
    policyGeneration,
    finalReadChallenge: readChallenge,
    text: !permanentReason && g.textComplete ? "complete" : "withheld",
    image: permanentReason ? evidence(permanentReason) : image,
    knownRequirement: permanentReason
      ? "unknown"
      : g.reason && !g.textComplete
        ? "unknown"
        : g.owners.some(required)
          ? "present"
          : "absent_in_supported_snapshot",
    values: [...learned],
    textCandidateScope: { readId: g.id, policyGeneration },
    imageCandidateRefs: g.owners
      .map((o) =>
        Object.assign(
          bound.has(o.value)
            ? { boundIndex: boundList.indexOf(o.value) }
            : { learnedIndex: [...learned].indexOf(o.value) },
          {
            sourceOwner: g.elements.indexOf(projectionOwner(o.element)),
            axRoles: axRoles(projectionOwner(o.element)),
            coversWholeOwner: o.kind === "control" || o.whole,
          },
        ),
      )
      .filter((ref) => ("boundIndex" in ref ? ref.boundIndex : ref.learnedIndex) >= 0),
    textCandidateRefs: g.owners
      .filter((o) => o.kind !== "control" && visible(o.element) && !axExcluded(o.element))
      .map((o) =>
        bound.has(o.value)
          ? {
              boundIndex: boundList.indexOf(o.value),
              sourceOwner: g.elements.indexOf(projectionOwner(o.element)),
              axRoles: axRoles(projectionOwner(o.element)),
            }
          : {
              learnedIndex: [...learned].indexOf(o.value),
              sourceOwner: g.elements.indexOf(projectionOwner(o.element)),
              axRoles: axRoles(projectionOwner(o.element)),
            },
      )
      .filter((r) => ("boundIndex" in r ? r.boundIndex : r.learnedIndex) >= 0),
    coveredBoundIndices:
      image.state === "available"
        ? [...new Set(g.owners.map((o) => boundList.indexOf(o.value)).filter((i) => i >= 0))]
        : [],
    coveredValues:
      image.state === "available"
        ? [...new Set(g.owners.map((o) => o.value).filter((v) => !bound.has(v)))]
        : [],
    count: g.count,
    timing: { graphMs: g.ms },
    observedRequiredGap: observedGap,
  });
  function render(g) {
    g.paintReady = false;
    const projected = geometry(g);
    g.projected = projected;
    if (projected.reason) {
      if (g.owners.some(required)) observeGap(projected.reason);
      return output(g, evidence(projected.reason));
    }
    if (!g.textComplete || permanentReason)
      return output(g, evidence(permanentReason ?? "native_protection_refresh_incomplete"));
    try {
      // Complete empty geometry needs no paint layer. In particular, editor
      // documents must not fail image admission on an unnecessary popover call.
      if (projected.rectangles.length === 0) {
        layer?.replaceChildren();
        overlay?.remove();
        layer = undefined;
        overlay = undefined;
        g.paintReady = true;
        return output(g, evidence());
      }
      createLayer();
      layer.replaceChildren(
        ...projected.rectangles.map((r) => {
          const block = document.createElement("div");
          block.style.cssText = `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background:#e5e9ed;opacity:1;overflow:hidden;pointer-events:none;`;
          const texture = document.createElement("div");
          texture.style.cssText =
            "position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(115deg,rgba(255,255,255,.18) 0 5px,rgba(90,105,120,.05) 5px 10px);";
          block.append(texture);
          return block;
        }),
      );
      if (layer.matches(":popover-open")) layer.hidePopover();
      layer.showPopover();
      g.paintReady = true;
      return output(g, evidence());
    } catch {
      if (g.owners.some(required)) observeGap("native_protection_refresh_incomplete");
      return output(g, evidence("native_protection_refresh_incomplete"));
    }
  }
  function refresh() {
    if (disposed || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (disposed) return;
      graph = build(readId);
      render(graph);
    });
  }
  const observer = new MutationObserver((records) => {
    if (
      records.every(
        (r) =>
          r.target === overlay ||
          ([...r.addedNodes].every((n) => n === overlay) && r.addedNodes.length),
      )
    )
      return;
    revision++;
    refresh();
  });
  globalThis.__scryNativeGraph = {
    version: 2,
    armImageCapture(token) {
      if (token !== activeImageToken) {
        activeImageToken = Number.isSafeInteger(token) && token > 0 ? token : undefined;
        notifiedImageToken = undefined;
      }
    },
    bind(values, next) {
      bind(values, next);
      refresh();
    },
    visualReady() {
      return (
        !disposed &&
        !!graph?.projected &&
        graph.paintReady === true &&
        graph.textComplete &&
        !permanentReason &&
        !graph.projected.reason &&
        (graph.projected.rectangles.length === 0 ||
          (!!layer?.isConnected && layer.matches(":popover-open")))
      );
    },
    learn(values) {
      for (const value of values) retain(value);
    },
    read(id, known = [], challenge) {
      if (disposed) throw Error("disposed");
      readId = id;
      readChallenge =
        typeof challenge === "string" && /^[a-f0-9-]{36}$/u.test(challenge) ? challenge : undefined;
      for (const value of known) retain(value);
      graph = build(id);
      return output(
        graph,
        evidence(
          graph.reason ??
            (graph.owners.length ? "native_protection_refresh_incomplete" : undefined),
        ),
      );
    },
    paint(id) {
      return new Promise((resolve) => {
        let settled = false,
          timer;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        requestAnimationFrame(() => {
          if (disposed || !graph || graph.id !== id)
            return finish({ version: 1, image: evidence("native_protection_geometry_stale") });
          if (graph.revision !== revision) graph = build(id);
          const value = render(graph);
          requestAnimationFrame(() => finish(value));
        });
        timer = setTimeout(() => {
          if (settled) return;
          if (disposed || graph?.id !== id)
            return finish({ version: 1, image: evidence("native_protection_geometry_stale") });
          if (graph?.owners.some(required)) observeGap("native_protection_refresh_incomplete");
          finish(
            graph
              ? output(
                  graph,
                  evidence(
                    graph.owners.length ? "native_protection_refresh_incomplete" : undefined,
                  ),
                )
              : { version: 1, image: evidence("native_protection_refresh_incomplete") },
          );
        }, 100);
      });
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      bound.clear();
      boundList.length = 0;
      boundBytes = 0;
      initialBound = undefined;
      learned.clear();
      learnedBytes = 0;
      layer?.remove();
      overlay?.remove();
      graph = null;
      for (const event of events) removeEventListener(event, onEvent, true);
    },
  };
  const events = [
      "input",
      "change",
      "scroll",
      "resize",
      "fullscreenchange",
      "beforetoggle",
      "toggle",
    ],
    onEvent = (e) => {
      if (e.target === overlay) return;
      revision++;
      refresh();
    };
  for (const event of events) addEventListener(event, onEvent, true);
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  globalThis.__scryNativeBind = (values) => globalThis.__scryNativeGraph.bind(values);
  globalThis.__scryNativeRefresh = (value) => {
    if (value !== undefined) globalThis.__scryNativeGraph.learn([value]);
    refresh();
  };
  globalThis.__scryNativeRead = (values) =>
    globalThis.__scryNativeGraph.read(readId + 1, values ?? []);
  globalThis.__scryNativeVisualReady = () => globalThis.__scryNativeGraph.visualReady();
  refresh();
}
