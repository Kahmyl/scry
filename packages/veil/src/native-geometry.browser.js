/* Worker-private geometry capability. Loaded literally beside the privacy graph.
 * The graph supplies candidates; this capability never discovers values. */
function nativeCreateGeometryCapability(authority) {
  const maxOwners = 64,
    maxQuads = 128,
    maxTotalQuads = 2048,
    maxLayoutNodes = 128;
  let instanceId, ticket, accepted, failure, completedReuse;
  let installed = [];
  const scopes = new WeakMap();
  const nonce = () =>
    Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(16)).join("-");
  const scope = (g) => {
    instanceId ??= nonce();
    if (!scopes.has(g)) scopes.set(g, nonce());
    return { instanceId, graphId: scopes.get(g) };
  };
  const sameScope = (a, b) => a?.instanceId === b?.instanceId && a?.graphId === b?.graphId;
  const descriptorEqual = (a, b) =>
    a.element === b.element &&
    a.value === b.value &&
    a.pseudo === b.pseudo &&
    a.kind === b.kind &&
    a.source === b.source &&
    a.whole === b.whole;
  function supported(owner) {
    if (owner.kind !== "pseudo" || !authority.visible(owner.element)) return false;
    const value = authority.pseudoValue(owner.element, owner.pseudo);
    if (
      !value?.supported ||
      value.value !== owner.value ||
      !/^[\x20-\x7e]+$/.test(owner.value) ||
      owner.value.length > 4096 ||
      authority.unsupportedStyle(owner.element, owner.pseudo) ||
      authority.unsupportedTextInk(owner.element, owner.pseudo) ||
      !authority.paintChainSupported(owner.element)
    )
      return false;
    const s = getComputedStyle(owner.element, owner.pseudo);
    return (
      !!s.font &&
      ["normal", "0px"].includes(s.letterSpacing) &&
      ["normal", "0px"].includes(s.wordSpacing) &&
      (!s.fontFeatureSettings || s.fontFeatureSettings === "normal") &&
      (!s.fontVariationSettings || s.fontVariationSettings === "normal") &&
      (!s.fontVariant || s.fontVariant === "normal") &&
      (!s.fontVariantCaps || s.fontVariantCaps === "normal") &&
      (!s.fontSizeAdjust || s.fontSizeAdjust === "none") &&
      (!s.textCombineUpright || s.textCombineUpright === "none") &&
      (!s.textIndent || Number.parseFloat(s.textIndent) === 0) &&
      s.direction === "ltr"
    );
  }
  function stamp(g, owner) {
    const nodes = g.elements.filter(
      (n) => n === owner.element || authority.ancestor(n, owner.element),
    );
    if (nodes.length > maxLayoutNodes || document.fonts?.status !== "loaded") return null;
    const entries = [];
    let bytes = 0,
      rectangles = 0;
    for (const node of nodes) {
      const b = node.getBoundingClientRect();
      const styles = [];
      for (const pseudo of [undefined, "::before", "::after"]) {
        const s = getComputedStyle(node, pseudo);
        const properties = [];
        for (const name of s) {
          const value = s.getPropertyValue(name);
          bytes += (name.length + value.length) * 2;
          if (bytes > 262144) return null;
          properties.push([name, value]);
        }
        styles.push(properties);
      }
      const text = [];
      for (const child of node.childNodes)
        if (child.nodeType === 3) {
          const r = document.createRange();
          r.selectNodeContents(child);
          const cells = r.getClientRects();
          if ((rectangles += cells.length) > 2048) return null;
          text.push([...cells].map((c) => [c.left, c.top, c.right, c.bottom]));
        }
      entries.push([b.left, b.top, b.right, b.bottom, styles, text]);
    }
    return JSON.stringify([innerWidth, innerHeight, scrollX, scrollY, devicePixelRatio, entries]);
  }
  function inkFits(owner, boxes) {
    if (!supported(owner)) return false;
    const s = getComputedStyle(owner.element, owner.pseudo),
      canvas = document.createElement("canvas"),
      ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.font = s.font;
    const m = ctx.measureText(owner.value),
      guard = 1 / (devicePixelRatio || 1);
    if (
      ![
        m.width,
        m.actualBoundingBoxLeft,
        m.actualBoundingBoxRight,
        m.actualBoundingBoxAscent,
        m.actualBoundingBoxDescent,
        m.fontBoundingBoxAscent,
        m.fontBoundingBoxDescent,
      ].every(Number.isFinite)
    )
      return false;
    // Metrics can reject a layout box; they never size or phase the mask.
    return boxes.every(
      (b) =>
        m.width <= b.right - b.left + 0.02 &&
        m.actualBoundingBoxLeft <= guard &&
        m.actualBoundingBoxRight <= m.width + guard &&
        m.actualBoundingBoxAscent <= m.fontBoundingBoxAscent + guard &&
        m.actualBoundingBoxDescent <= m.fontBoundingBoxDescent + guard &&
        m.fontBoundingBoxAscent + m.fontBoundingBoxDescent <= b.bottom - b.top + 2 * guard,
    );
  }
  const reject = (reason = "native_protection_geometry_stale") => {
    failure = { readId: authority.readId(), reason };
    return { reason };
  };
  function ticketValid(meta, layout = true) {
    const g = authority.graph();
    if (
      authority.disposed() ||
      !ticket ||
      ticket.graph !== g ||
      !sameScope(meta?.scope, ticket.metadata.scope) ||
      meta.nonce !== ticket.metadata.nonce ||
      meta.readId !== g.id ||
      meta.policyGeneration !== g.policyGeneration ||
      meta.revision !== g.revision ||
      g.revision !== authority.revision() ||
      performance.now() > ticket.deadline
    )
      return false;
    return (
      (!layout ||
        [...ticket.owners.values()].every(
          (o) =>
            o.element.isConnected &&
            ticket.stamps.get(o) !== null &&
            stamp(g, o) === ticket.stamps.get(o),
        )) &&
      performance.now() <= ticket.deadline
    );
  }
  function cached(g, owner) {
    const entry = installed.find(
      (x) =>
        x.policy === g.policyGeneration &&
        x.fontGeneration === authority.fontGeneration?.() &&
        descriptorEqual(x.owner, owner),
    );
    if (
      !entry ||
      !owner.element.isConnected ||
      !supported(owner) ||
      stamp(g, owner) !== entry.stamp ||
      !inkFits(owner, entry.boxes)
    )
      return null;
    return entry.boxes;
  }
  function boxes(g, owner) {
    if (failure?.readId === g.id) return null;
    if (completedReuse?.graph === g) return completedReuse.boxes.get(owner) ?? null;
    if (accepted?.graph === g && ticketValid(accepted.metadata) && accepted.boxes.has(owner)) {
      const value = accepted.boxes.get(owner);
      return inkFits(owner, value) ? value : null;
    }
    return cached(g, owner);
  }
  function required(g) {
    return g.owners.some((o) => supported(o) && !authority.nativeEnvelope(o) && !boxes(g, o));
  }
  return {
    scope,
    required,
    supported,
    boxes,
    reason(g) {
      return failure?.readId === g.id ? failure.reason : undefined;
    },
    request(readId, budgetMs, expectedScope) {
      const g = authority.graph();
      // Foreign/late context requests cannot mutate a new graph's ticket.
      if (!g || authority.disposed() || g.id !== readId || !sameScope(expectedScope, scope(g)))
        return { reason: "native_protection_geometry_stale" };
      if (failure?.readId === readId) return { reason: failure.reason };
      if (ticket?.metadata?.readId === readId)
        return ticket.graph === g && ticketValid(ticket.metadata) ? ticket.metadata : reject();
      const owners = g.owners.filter(
        (o) => supported(o) && !authority.nativeEnvelope(o) && !cached(g, o),
      );
      if (owners.length > maxOwners) return reject("native_protection_graph_capacity");
      const bounded = Math.min(200, Math.max(0, Number.isFinite(budgetMs) ? budgetMs : 0));
      ticket = {
        graph: g,
        deadline: performance.now() + bounded,
        owners: new Map(),
        stamps: new Map(),
      };
      accepted = undefined;
      const requests = owners.map((o, i) => {
        const token = String(i);
        ticket.owners.set(token, o);
        ticket.stamps.set(o, stamp(g, o));
        const b = o.element.getBoundingClientRect();
        return {
          token,
          pseudo: o.pseudo.slice(2),
          localBox: { left: b.left, top: b.top, width: b.width, height: b.height },
        };
      });
      if ([...ticket.stamps.values()].some((v) => v === null))
        return reject("native_protection_graph_capacity");
      ticket.metadata = {
        version: 1,
        scope: scope(g),
        nonce: nonce(),
        readId,
        policyGeneration: g.policyGeneration,
        revision: g.revision,
        requests,
      };
      return ticketValid(ticket.metadata) ? ticket.metadata : reject();
    },
    owner(meta, token) {
      return ticketValid(meta, false) ? (ticket.owners.get(token)?.element ?? null) : null;
    },
    accept(meta, facts) {
      // A late packet from a disposed/replaced world has no authority over the
      // current read, including authority to mark that read as failed.
      if (
        !ticket ||
        !sameScope(meta?.scope, ticket.metadata?.scope) ||
        meta?.nonce !== ticket.metadata?.nonce
      )
        return { reason: "native_protection_geometry_stale" };
      if (!ticketValid(meta) || failure?.readId === meta?.readId) return reject();
      if (!Array.isArray(facts) || facts.length !== ticket.owners.size) return reject();
      const result = new Map();
      let total = 0;
      for (const f of facts) {
        const o = ticket.owners.get(f.token);
        if (!o || result.has(o) || f.pseudo !== o.pseudo.slice(2) || !supported(o)) return reject();
        if (
          !Array.isArray(f.quads) ||
          !f.quads.length ||
          f.quads.length > maxQuads ||
          (total += f.quads.length) > maxTotalQuads
        )
          return reject("native_protection_graph_capacity");
        const b = [];
        for (const q of f.quads) {
          if (
            !Array.isArray(q) ||
            q.length !== 8 ||
            !q.every(Number.isFinite) ||
            q.some((n) => Math.abs(n) > 1e6) ||
            Math.abs(q[1] - q[3]) > 0.02 ||
            Math.abs(q[2] - q[4]) > 0.02 ||
            Math.abs(q[5] - q[7]) > 0.02 ||
            Math.abs(q[0] - q[6]) > 0.02 ||
            q[4] <= q[0] ||
            q[5] <= q[1]
          )
            return reject("native_protection_geometry_unsupported");
          b.push({ left: q[0], top: q[1], right: q[4], bottom: q[5] });
        }
        if (!inkFits(o, b)) return reject("native_protection_geometry_unsupported");
        const guard = 1 / (devicePixelRatio || 1);
        result.set(
          o,
          b.map((v) => ({
            left: v.left - guard,
            top: v.top - guard,
            right: v.right + guard,
            bottom: v.bottom + guard,
          })),
        );
      }
      if (!ticketValid(meta)) return reject();
      accepted = { graph: authority.graph(), metadata: ticket.metadata, boxes: result };
      return { accepted: result.size };
    },
    abort(meta, reason) {
      if (
        ticket &&
        sameScope(meta?.scope, ticket.metadata?.scope) &&
        meta.nonce === ticket.metadata.nonce
      )
        return reject(
          ["native_protection_geometry_unsupported", "native_protection_graph_capacity"].includes(
            reason,
          )
            ? reason
            : "native_protection_geometry_stale",
        );
      return { reason: "native_protection_geometry_stale" };
    },
    installed(g) {
      const next = [];
      for (const o of g.owners)
        if (o.kind === "pseudo" && authority.visible(o.element) && !authority.nativeEnvelope(o)) {
          const b = boxes(g, o),
            witness = stamp(g, o);
          if (!b || witness === null) {
            installed = [];
            return;
          }
          next.push({
            owner: o,
            policy: g.policyGeneration,
            fontGeneration: authority.fontGeneration?.(),
            stamp: witness,
            boxes: b,
          });
        }
      installed = next;
    },
    revalidate(g, previous, run) {
      // Cached geometry comes only from a completed installation. This does not
      // reopen an expired transport ticket or ignore a failure in this read.
      if (failure?.readId === g.id) return null;
      const map = new Map();
      for (const o of g.owners.filter(
        (o) => o.kind === "pseudo" && authority.visible(o.element) && !authority.nativeEnvelope(o),
      )) {
        const prior = previous.owners.find((p) => descriptorEqual(p, o));
        const b = prior && cached(g, o);
        if (!b) return null;
        map.set(o, b);
      }
      try {
        completedReuse = { graph: g, boxes: map };
        return run();
      } finally {
        completedReuse = undefined;
      }
    },
    newRead(id) {
      if (failure?.readId !== id) failure = undefined;
      if (ticket?.metadata?.readId !== id) {
        ticket = undefined;
        accepted = undefined;
      }
      installed = installed.filter(
        (x) => x.owner.element.isConnected && x.policy === authority.policy(),
      );
    },
    dispose() {
      ticket = accepted = failure = completedReuse = undefined;
      installed = [];
    },
  };
}
