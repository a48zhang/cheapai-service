import { formatUsdPerMillionTokens } from '../lib/model-price';
import './model-display.css';

export function ModelPrice({
  input,
  output,
  multiplier = '1',
  compact = false,
  className = '',
}: {
  input?: string | undefined;
  output?: string | undefined;
  multiplier?: string | undefined;
  compact?: boolean;
  className?: string;
}) {
  const inputPrice = formatUsdPerMillionTokens(input, multiplier);
  const outputPrice = formatUsdPerMillionTokens(output, multiplier);
  const short = (price: string) =>
    price === '价格暂不可用' ? '—' : price.replace(' / 百万 Token', '/m');
  return (
    <span
      className={`model-price ${className}`}
      aria-label={`输入 ${inputPrice}，输出 ${outputPrice}`}
    >
      {compact ? (
        <>
          读 {short(inputPrice)} · 写 {short(outputPrice)}
        </>
      ) : (
        <>
          输入 {inputPrice} · 输出 {outputPrice}
        </>
      )}
    </span>
  );
}
