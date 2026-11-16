import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { scryPromptExamples } from "./assistant-prompts.js";

export function PromptMessage({
  prompt,
  label,
  buttonText = label,
}: {
  prompt: string;
  label: string;
  buttonText?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setError(false);
    } catch {
      setCopied(false);
      setError(true);
    }
  };
  return (
    <div className="connection-prompt-message">
      <pre tabIndex={0} aria-label={label.replace(/^Copy /, "")}>
        {prompt}
      </pre>
      <button
        type="button"
        className="connection-secondary"
        aria-label={label}
        onClick={() => void copy()}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />} {buttonText}
      </button>
      {copied && <span role="status">Copied. Paste it into your assistant chat.</span>}
      {error && <p role="alert">Copy the message above and paste it into your assistant.</p>}
    </div>
  );
}

export function PromptExamples() {
  return (
    <section className="connection-examples panel" aria-labelledby="prompt-examples-heading">
      <div className="connection-section-title">
        <div>
          <h2 id="prompt-examples-heading">Try Scry in your next message</h2>
          <p>
            Once Scry is connected, tell your assistant what you want checked. If you’re already
            working on the app together, keep using that chat—you don’t need to repeat everything.
          </p>
        </div>
      </div>
      <div className="connection-example-grid">
        {scryPromptExamples.map((example) => (
          <article className="connection-example" key={example.id}>
            <h3>{example.title}</h3>
            <p>{example.description}</p>
            {example.id === "full-test" ? (
              <details>
                <summary>Show full test example</summary>
                <PromptMessage
                  prompt={example.prompt}
                  label={`Copy ${example.title.toLowerCase()} example`}
                  buttonText="Copy example"
                />
              </details>
            ) : (
              <PromptMessage
                prompt={example.prompt}
                label={`Copy ${example.title.toLowerCase()} example`}
                buttonText="Copy example"
              />
            )}
          </article>
        ))}
      </div>
      <p className="connection-examples-note">
        Include the app address and environment when they aren’t already in the chat. Name the
        journey or change you care about. Keep passwords in Scry’s protected inputs, outside chat.
      </p>
    </section>
  );
}
