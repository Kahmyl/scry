import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Fragment, useId } from "react";
import "./custom-select.css";

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  separatorAfter?: boolean;
};

/** Scry's styled select; Radix owns navigation, dismissal and focus restoration. */
export function CustomSelect({
  id,
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  id?: string;
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const labelId = `${triggerId}-label`;
  return (
    <div className="scry-select">
      <Select.Root value={value} onValueChange={onChange} disabled={disabled}>
        <label id={labelId} htmlFor={triggerId} className="scry-select-label">
          {label}
        </label>
        <Select.Trigger id={triggerId} aria-labelledby={labelId} className="scry-select-trigger">
          <Select.Value />
          <Select.Icon asChild>
            <ChevronDown
              className="scry-select-chevron"
              size={16}
              strokeWidth={1.75}
              aria-hidden="true"
            />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            className="scry-select-content"
            aria-label={label}
            position="popper"
            sideOffset={8}
            collisionPadding={12}
          >
            <Select.ScrollUpButton className="scry-select-scroll">
              <ChevronUp size={16} aria-hidden="true" />
            </Select.ScrollUpButton>
            <Select.Viewport className="scry-select-viewport">
              {options.map((option, index) => (
                <Fragment key={option.value}>
                  <Select.Item
                    className="scry-select-item"
                    value={option.value}
                    disabled={option.disabled ?? false}
                  >
                    <Select.ItemText>{option.label}</Select.ItemText>
                    <Select.ItemIndicator className="scry-select-check">
                      <Check size={16} strokeWidth={2} aria-hidden="true" />
                    </Select.ItemIndicator>
                  </Select.Item>
                  {option.separatorAfter && index < options.length - 1 && (
                    <Select.Separator className="scry-select-separator" />
                  )}
                </Fragment>
              ))}
            </Select.Viewport>
            <Select.ScrollDownButton className="scry-select-scroll">
              <ChevronDown size={16} aria-hidden="true" />
            </Select.ScrollDownButton>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}
