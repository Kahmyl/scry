import { useEffect, useRef, useState } from "react";
import { Mail, Webhook, RefreshCw, Plus, CheckCircle2, Clock3 } from "lucide-react";
import { api, post } from "../infrastructure/api/client.js";
import { CustomSelect } from "../shared/components/CustomSelect.js";
import "./test-resources.css";

type Resource = {
  id: string;
  kind: "mailbox" | "webhook";
  name: string;
  state: string;
  address: string | null;
  idempotencyKey: string;
  expiresInSeconds: number;
  retryAfterSeconds?: number;
  ownership?: "scry" | "customer";
  connection?: { address: string; passwordCredentialId: string };
};
type Event = {
  id: string;
  title: string;
  receivedAt: string;
  content: unknown;
  secrets: Array<{ kind: string; protectedValueId: string }>;
};
type ReceiptRead = {
  resourceId: string | undefined;
  phase: "idle" | "loading" | "ready" | "failed";
  events: Event[];
};
type Inventory = {
  resources: Resource[];
  capabilities: { mailbox: boolean; webhook: boolean };
  credentials?: Array<{ id: string; displayName: string; state: string }>;
};

/** Shows persisted observations, not provider credentials or an independent
 * pass/fail verdict. Mail HTML is text, never executable dashboard markup. */
export function MissionTestResources({
  missionId,
  readOnly = false,
}: {
  missionId: string;
  readOnly?: boolean;
}) {
  return (
    <MissionTestResourcesPanel
      key={`${missionId}:${readOnly}`}
      missionId={missionId}
      readOnly={readOnly}
    />
  );
}
function MissionTestResourcesPanel({
  missionId,
  readOnly,
}: {
  missionId: string;
  readOnly: boolean;
}) {
  const [inventory, setInventory] = useState<Inventory>();
  const [inventoryFailed, setInventoryFailed] = useState(false);
  const [inventoryRetry, setInventoryRetry] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [receiptRead, setReceiptRead] = useState<ReceiptRead>({
    resourceId: undefined,
    phase: "idle",
    events: [],
  });
  const [receiptRetry, setReceiptRetry] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<"mailbox" | "webhook">();
  const [name, setName] = useState("");
  const [allocation, setAllocation] = useState<string>();
  const [mailboxMode, setMailboxMode] = useState("new");
  const [mailboxAddress, setMailboxAddress] = useState("");
  const [passwordCredential, setPasswordCredential] = useState("choose");
  const eventsRequest = useRef(0);
  useEffect(() => {
    let active = true;
    setInventory(undefined);
    setInventoryFailed(false);
    setSelected(undefined);
    setReceiptRead({ resourceId: undefined, phase: "idle", events: [] });
    setError("");
    void api<Inventory>(`/missions/${missionId}/test-resources`)
      .then((data) => {
        if (active) setInventory(data);
      })
      .catch(() => {
        if (active) setInventoryFailed(true);
      });
    return () => {
      active = false;
    };
  }, [missionId, inventoryRetry]);
  useEffect(() => {
    let active = true;
    const request = ++eventsRequest.current;
    setReceiptRead((previous) => ({
      resourceId: selected,
      phase: selected ? "loading" : "idle",
      events: previous.resourceId === selected ? previous.events : [],
    }));
    if (selected)
      void api<Event[]>(`/test-resources/${selected}/events`)
        .then((data) => {
          if (active && request === eventsRequest.current)
            setReceiptRead({ resourceId: selected, phase: "ready", events: data });
        })
        .catch(() => {
          if (active && request === eventsRequest.current)
            setReceiptRead((previous) => ({ ...previous, phase: "failed" }));
        });
    return () => {
      active = false;
    };
  }, [selected, missionId, receiptRetry]);
  // Bind facts and request state to the selected resource, including the render
  // before its effect starts. Never show a previous mailbox's observations
  // under a new heading, or infer an empty inbox from an unfinished read.
  const events = receiptRead.resourceId === selected ? receiptRead.events : [];
  const eventsLoading =
    Boolean(selected) && (receiptRead.resourceId !== selected || receiptRead.phase === "loading");
  const eventsFailed = receiptRead.resourceId === selected && receiptRead.phase === "failed";
  const current = inventory?.resources.find((r) => r.id === selected);
  async function allocate(resource?: Resource) {
    if (!resource && (!kind || !name.trim())) return;
    const connected = resource
      ? resource.ownership === "customer"
      : kind === "mailbox" && mailboxMode === "existing";
    const connection = resource?.connection ?? {
      address: mailboxAddress.trim().toLowerCase(),
      passwordCredentialId: passwordCredential,
    };
    if (connected && (!connection.address || connection.passwordCredentialId === "choose")) {
      setError("Enter the Mail.tm address and explicitly choose its saved password.");
      return;
    }
    setBusy(true);
    setError("");
    const key = resource?.idempotencyKey ?? allocation ?? crypto.randomUUID();
    setAllocation(key);
    try {
      const result = await post<Resource>(
        `/missions/${missionId}/test-resources${connected ? "/connect-mailbox" : ""}`,
        {
          ...(connected ? connection : { kind: resource?.kind ?? kind }),
          name: resource?.name ?? name.trim(),
          idempotencyKey: key,
          expiresInSeconds: resource?.expiresInSeconds ?? 86400,
        },
      );
      setInventory((data) =>
        data
          ? { ...data, resources: [...data.resources.filter((r) => r.id !== result.id), result] }
          : data,
      );
      setSelected(result.id);
      setKind(undefined);
      setName("");
      setAllocation(undefined);
      setMailboxAddress("");
      setPasswordCredential("choose");
      setMailboxMode("new");
      setStatus(
        result.state === "ready"
          ? "Ready for your test."
          : `Setup is waiting for availability. Try again${result.retryAfterSeconds ? ` in about ${result.retryAfterSeconds} seconds` : " shortly"}.`,
      );
    } catch {
      setError(
        "Setup could not finish yet. Retry this same request; no application result is inferred.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    if (!current) return;
    ++eventsRequest.current;
    setReceiptRead((previous) => ({
      resourceId: current.id,
      phase: "loading",
      events: previous.resourceId === current.id ? previous.events : [],
    }));
    setBusy(true);
    setError("");
    try {
      const data = await post<{
        events: Event[];
        status: string;
        retryAfterSeconds?: number;
        availability?: string;
      }>(`/test-resources/${current.id}/refresh`, {});
      setReceiptRead({ resourceId: current.id, phase: "ready", events: data.events });
      setStatus(
        data.availability === "temporarily_unavailable"
          ? "The message service is temporarily unavailable. Saved observations are unchanged; check again shortly."
          : data.status === "received"
            ? "Received messages loaded. Check again if you expect more."
            : data.status === "closed"
              ? "Scry is no longer checking this resource. Recorded observations remain available."
              : `Waiting for a matching message.${data.retryAfterSeconds ? ` Check again in about ${data.retryAfterSeconds} seconds.` : ""}`,
      );
    } catch {
      setReceiptRead((previous) => ({ ...previous, phase: "failed" }));
      setError(
        "Messages could not be checked right now. Previous observations are unchanged; try again shortly.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function close() {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      const result = await post<Resource>(`/test-resources/${current.id}/close`);
      setInventory((data) =>
        data
          ? { ...data, resources: data.resources.map((r) => (r.id === result.id ? result : r)) }
          : data,
      );
      setStatus(
        result.state === "closed"
          ? current.ownership === "customer"
            ? "Disconnected. Your Mail.tm mailbox and messages have not been deleted."
            : "Closed. Received observations are still available."
          : "Closure is waiting for availability. Retry Close to finish cleanup.",
      );
    } catch {
      setError(
        "Closure could not be confirmed. Saved observations are unchanged. Try again shortly or contact support if this continues.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="test-resources" aria-labelledby="test-resources-heading">
      <header>
        <div>
          <p className="test-resources-eyebrow">Beyond the browser</p>
          <h2 id="test-resources-heading">Emails &amp; webhooks</h2>
          <p>Review what the application sent during this mission.</p>
        </div>
        {!readOnly && inventory && (
          <div className="test-resource-actions">
            <button
              disabled={busy || !inventory.capabilities.mailbox}
              onClick={() => {
                setKind("mailbox");
                setMailboxMode("new");
                setName("Invitation emails");
                setAllocation(undefined);
              }}
            >
              <Plus size={14} /> Test mailbox
            </button>
            <button
              disabled={busy || !inventory.capabilities.webhook}
              onClick={() => {
                setKind("webhook");
                setName("Application notifications");
                setAllocation(undefined);
              }}
            >
              <Plus size={14} /> Webhook listener
            </button>
          </div>
        )}
      </header>
      {readOnly && (
        <p className="test-resource-secret-note">
          Current mission observations are shown below. The report findings describe what was
          reviewed when the report was written.
        </p>
      )}
      {!readOnly &&
        inventory &&
        (!inventory.capabilities.mailbox || !inventory.capabilities.webhook) && (
          <p className="test-resource-secret-note">
            {!inventory.capabilities.mailbox && "Test mailboxes are not configured. "}
            {!inventory.capabilities.webhook && "Webhook capture is not configured. "}An
            administrator must enable these integrations before they can be used.
          </p>
        )}
      {kind && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void allocate();
          }}
        >
          {kind === "mailbox" && (
            <CustomSelect
              label="Mailbox source"
              value={mailboxMode}
              options={[
                { value: "new", label: "Create a disposable mailbox" },
                { value: "existing", label: "Use my Mail.tm mailbox" },
              ]}
              onChange={(value) => {
                setMailboxMode(value);
                setAllocation(undefined);
              }}
              disabled={busy}
            />
          )}
          <label>
            What will this {kind === "mailbox" ? "mailbox" : "listener"} test?
            <input
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          {kind === "mailbox" && mailboxMode === "existing" && (
            <div className="test-mailbox-connection-fields">
              <label>
                Mail.tm email address
                <input
                  type="email"
                  required
                  value={mailboxAddress}
                  maxLength={254}
                  autoComplete="off"
                  onChange={(e) => {
                    setMailboxAddress(e.target.value);
                    setAllocation(undefined);
                  }}
                />
              </label>
              <CustomSelect
                label="Saved mailbox password"
                value={passwordCredential}
                options={[
                  { value: "choose", label: "Choose a password", disabled: true },
                  ...(inventory?.credentials ?? [])
                    .filter((c) => c.state === "active")
                    .map((c) => ({ value: c.id, label: c.displayName })),
                ]}
                onChange={(value) => {
                  setPasswordCredential(value);
                  setAllocation(undefined);
                }}
                disabled={busy}
              />
              <p>
                Save the mailbox password in <a href="/dashboard/settings">Project settings</a>,
                then choose it here. Connecting permits reading existing messages. Disconnecting or
                expiry will never delete your mailbox or its emails.
              </p>
            </div>
          )}
          <button disabled={busy}>
            {busy
              ? "Preparing…"
              : kind === "mailbox" && mailboxMode === "existing"
                ? "Connect mailbox"
                : "Create"}
          </button>
          <button type="button" disabled={busy} onClick={() => setKind(undefined)}>
            Cancel
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {inventoryFailed && (
        <div role="alert">
          <p>Test resources could not be loaded. Saved observations are unchanged.</p>
          <button
            onClick={() => {
              setInventoryFailed(false);
              setInventoryRetry((attempt) => attempt + 1);
            }}
          >
            Retry loading test resources
          </button>
        </div>
      )}
      {!inventory && !inventoryFailed && <p role="status">Loading test resources…</p>}
      {inventory && !inventory.resources.length && (
        <div className="test-resource-empty">
          <Mail size={22} />
          <p>No email or webhook observations yet.</p>
          <small>
            Allocate a test address or listener when the journey needs one. Receipt alone is not
            proof that the full workflow worked.
          </small>
        </div>
      )}
      {!!inventory?.resources.length && (
        <div className="test-resource-layout">
          <nav aria-label="Test mailboxes and webhook listeners">
            {inventory.resources.map((resource) => (
              <button
                key={resource.id}
                disabled={busy}
                aria-pressed={selected === resource.id}
                onClick={() => {
                  setSelected(resource.id);
                  setStatus("");
                  setError("");
                }}
              >
                {resource.kind === "mailbox" ? <Mail size={17} /> : <Webhook size={17} />}
                <span>
                  {resource.name}
                  <small>
                    {resource.state === "ready"
                      ? "Receiving"
                      : resource.state === "pending"
                        ? "Preparing"
                        : resource.state === "closing"
                          ? "Closing"
                          : resource.ownership === "customer"
                            ? "Disconnected"
                            : "Closed"}
                  </small>
                </span>
              </button>
            ))}
          </nav>
          <div className="test-resource-content">
            {!current ? (
              <p>Select a mailbox or listener to review its observations.</p>
            ) : (
              <>
                <div className="test-resource-current">
                  <h3>{current.name}</h3>
                  {current.ownership === "customer" && (
                    <p className="test-resource-secret-note">
                      Your Mail.tm mailbox · Scry only reads messages. Disconnecting does not delete
                      your account or emails.
                    </p>
                  )}
                  {current.address && <code>{current.address}</code>}
                  <div className="test-resource-actions">
                    {!readOnly && (
                      <>
                        {current.state === "pending" ? (
                          <button disabled={busy} onClick={() => void allocate(current)}>
                            Continue setup
                          </button>
                        ) : current.state === "ready" ? (
                          <button disabled={busy} onClick={() => void refresh()}>
                            <RefreshCw size={14} className={busy ? "is-busy" : ""} />
                            Check for messages
                          </button>
                        ) : null}
                        {current.state !== "closed" && (
                          <button disabled={busy} onClick={() => void close()}>
                            {current.ownership === "customer"
                              ? "Disconnect mailbox"
                              : `Close ${current.kind === "mailbox" ? "mailbox" : "listener"}`}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {status && (
                  <p role="status" className="test-resource-status">
                    <Clock3 size={14} />
                    {status}
                  </p>
                )}
                {eventsLoading && <p role="status">Loading received messages…</p>}
                {eventsFailed && (
                  <div role="alert">
                    <p>Received messages could not be loaded. Saved observations are unchanged.</p>
                    <button
                      disabled={busy || eventsLoading}
                      onClick={() => {
                        setReceiptRead((previous) => ({ ...previous, phase: "loading" }));
                        setReceiptRetry((attempt) => attempt + 1);
                      }}
                    >
                      Retry loading messages
                    </button>
                  </div>
                )}
                {!events.length && !eventsLoading && !eventsFailed && (
                  <p>
                    {current.state === "closed"
                      ? "No messages were recorded for this resource."
                      : "No messages recorded yet. Check after the application sends one."}
                  </p>
                )}
                {!!events.length &&
                  events.map((event) => (
                    <details className="test-message" key={event.id}>
                      <summary>
                        <CheckCircle2 size={16} />
                        <span>{event.title}</span>
                        <time>{new Date(event.receivedAt).toLocaleString()}</time>
                      </summary>
                      <MessageContent content={event.content} />
                      {!!event.secrets.length && (
                        <details className="test-message-handoff">
                          <summary>Use protected values in this mission</summary>
                          <p>
                            The links and codes stay private. These opaque references let your
                            testing agent use them in the same Mission and an active Run. Scry
                            checks access and expiry before use; a reference does not confirm that
                            an invitation was accepted.
                          </p>
                          <dl>
                            <dt>Resource reference (resourceId)</dt>
                            <dd>
                              <code>{current.id}</code>
                            </dd>
                            {event.secrets.map((secret, index) => (
                              <div key={secret.protectedValueId}>
                                <dt>
                                  Protected {secret.kind === "link" ? "link" : "code"} {index + 1}
                                </dt>
                                <dd>
                                  <span>protectedValueId: </span>
                                  <code>{secret.protectedValueId}</code>
                                </dd>
                              </div>
                            ))}
                          </dl>
                          <p>
                            The agent can bind the chosen reference with bind_test_message_secret,
                            then use browser_navigate_secret for a link or browser_type_secret for a
                            code. The browser's existing origin limits still apply.
                          </p>
                        </details>
                      )}
                    </details>
                  ))}
              </>
            )}
          </div>
        </div>
      )}
      <footer>
        Test inboxes provided by{" "}
        <a href="https://mail.tm" target="_blank" rel="noopener noreferrer">
          Mail.tm
        </a>
        . Webhook capture provided by{" "}
        <a href="https://hookdeck.com" target="_blank" rel="noopener noreferrer">
          Hookdeck
        </a>
        . Automatic masking is best effort.
      </footer>
    </section>
  );
}
function MessageContent({ content }: { content: unknown }) {
  const message =
    content && typeof content === "object" ? (content as Record<string, unknown>) : undefined;
  if (message && typeof message.text === "string")
    return (
      <div className="test-message-body">
        <p>
          <strong>From:</strong>{" "}
          {String((message.from as { address?: string } | undefined)?.address ?? "Not provided")}
        </p>
        <pre>
          {message.text ||
            "No plain-text body supplied. HTML content is not executed in this view."}
        </pre>
        {message.hasAttachments === true && (
          <small>
            This email includes attachments; attachment inspection is not included here.
          </small>
        )}
      </div>
    );
  return <pre className="test-message-body">{JSON.stringify(content, null, 2)}</pre>;
}
