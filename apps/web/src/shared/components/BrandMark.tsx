/** The identity symbol is decorative wherever the adjacent Scry name identifies it. */
export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <img
      className="scry-mark"
      src="/brand/scry-symbol.svg"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
    />
  );
}
