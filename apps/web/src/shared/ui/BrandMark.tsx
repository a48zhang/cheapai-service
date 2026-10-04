/** The same vector mark is used in the interface and the browser tab. */
export function BrandMark({ className = '' }: { className?: string }) {
  return (
    <img
      src="/favicon.svg"
      alt=""
      aria-hidden="true"
      width={40}
      height={40}
      className={`shrink-0 ${className}`}
    />
  );
}
