/** Public documents for two independent laboratory applications; no Scry permission logic. */
export function crossShapePage(shape: "public" | "protected", stage: "create" | "retrieve") {
  const protectedFlow = shape === "protected";
  const base = `/laboratory/${shape}`;
  const label = stage === "create" ? "Create sample item" : "Retrieve sample item";
  const identity = {
    key: "itemId",
    label: "Item identity",
    classification: "public",
    extractor: { kind: "json_path", path: "$.data.id" },
    identityRole: stage === "create" ? "resource_identity" : "continuation_identity",
    generatedValueEligible: true,
  };
  const input = (key: string, label: string, classification: string, presentation: string) => ({
    key,
    label,
    aliases: [],
    required: true,
    classification,
    acceptedPresentations: [presentation],
  });
  const facts = {
    application: {
      key: protectedFlow ? "protected_catalog" : "public_catalog",
      provider: "laboratory",
    },
    adapter: { key: "public_document", version: 1 },
    operation: {
      key: stage === "create" ? "createItem" : "retrieveItem",
      label,
      method: stage === "create" ? "POST" : "GET",
      pathTemplate: stage === "create" ? `${base}/items` : `${base}/items/{itemId}`,
      transports: ["fetch"],
      semantics: {
        dispatch: stage === "create" ? "mutation" : "read_only",
        effects: stage === "create" ? ["business_effect"] : ["read"],
      },
    },
    inputs: [
      ...(protectedFlow
        ? [input("accessSecret", "Workspace access secret", "protected", "protected_text")]
        : []),
      stage === "create"
        ? input("itemName", "Sample item name", "public", "plain_text")
        : input("itemId", "Created item identity", "generated_safe", "plain_text"),
    ],
    auth: { presentationClasses: protectedFlow ? ["protected_text"] : [] },
    response: {
      statusClasses: [2],
      ...(stage === "create"
        ? { mutationPolicy: { confirmedNotAppliedStatuses: [400, 401, 409, 422] } }
        : {}),
      outputs: [identity],
      continuation: stage === "create" ? "read_only_retrieve" : "none",
    },
    retrieval: { canonicalTargetFieldKey: "itemId", pathTemplate: `${base}/items/{itemId}` },
    ...(stage === "create"
      ? {
          resourceEffect: {
            operation: "create",
            provider: "laboratory",
            resourceKind: "sample",
            resourceScope: shape,
            identityContractVersion: 1,
            identityOutputKey: "itemId",
            correlationFieldKey: "itemName",
          },
        }
      : {}),
  };
  const fields = `${protectedFlow ? '<label>Workspace access secret<input id="secret" type="password" aria-label="Workspace access secret"></label>' : ""}<label>${stage === "create" ? "Sample item name" : "Created item identity"}<input id="value" aria-label="${stage === "create" ? "Sample item name" : "Created item identity"}"></label>`;
  return `<main><h1>${protectedFlow ? "Protected catalog wizard" : "Public sample catalog"}</h1><p>${protectedFlow ? "This local application requires a protected access secret on each operation." : "No authentication is needed."}</p>
    <a href="${base}/create">Create sample</a><a href="${base}/retrieve">Retrieve created sample</a>
    ${protectedFlow ? '<button id="reveal">Continue to operation</button>' : ""}<section id="operation" ${protectedFlow ? "hidden" : ""}>${fields}<button id="execute">${label}</button><output id="status"></output></section>
    <script type="application/scry-operation-contract+json">${JSON.stringify(facts)}</script></main>
    <script>${protectedFlow ? "document.getElementById('reveal').onclick=()=>{setTimeout(()=>{document.getElementById('operation').hidden=false;document.getElementById('reveal').hidden=true},350)};" : ""}
    document.getElementById('execute').onclick=async()=>{const value=document.getElementById('value').value;const r=await fetch(${JSON.stringify(base + "/items")}+${stage === "retrieve" ? "'/'+encodeURIComponent(value)" : "''"},{method:${JSON.stringify(stage === "create" ? "POST" : "GET")},headers:{'content-type':'application/json',${protectedFlow ? "'x-access-secret':document.getElementById('secret').value" : ""}},${stage === "create" ? "body:JSON.stringify({name:value})" : ""}});const data=await r.json();document.getElementById('status').textContent=r.status+' '+(data.data?.id??data.code??'');};</script>`;
}
