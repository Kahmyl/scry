import { LoaderCircle } from "lucide-react";
import "./evidence-loading.css";

/** Indeterminate progress: show activity, never an invented percentage or completion time. */
export function EvidenceLoading({
  label,
  detail,
  layout = "media",
}: {
  label: string;
  detail?: string;
  layout?: "media" | "library";
}) {
  return (
    <div className={`ev-loading ev-loading--${layout}`}>
      <div className="ev-loading-status" role="status">
        <LoaderCircle
          className="ev-loading-spinner"
          size={34}
          strokeWidth={2.25}
          aria-hidden="true"
        />
        <div>
          <strong>{label}</strong>
          {detail && <p>{detail}</p>}
        </div>
      </div>
      {layout === "library" && (
        <div className="ev-loading-cards" aria-hidden="true">
          {[0, 1, 2, 3].map((item) => (
            <div key={item}>
              <span />
              <span />
              <span />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
