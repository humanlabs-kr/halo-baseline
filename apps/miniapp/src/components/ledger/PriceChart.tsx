/**
 * Your price against the market's, month by month.
 *
 * The claim this product makes is that a shopper's prices move against
 * everyone else's over time, and that claim only reads as a line. The screen
 * this replaces printed the same six numbers in a column, where the one thing
 * a column cannot show is whether two series converged.
 *
 * Drawn as an inline SVG rather than a chart library: two polylines and an
 * area is not worth forty kilobytes on a mid-range Android, and a library
 * would bring its own typography and colours into a design system that has
 * exactly two.
 */
export function PriceChart({
  mine,
  market,
  labels,
}: {
  mine: number[];
  market: (number | null)[];
  labels: string[];
}) {
  if (mine.length < 2) return null;

  const all = [...mine, ...market.filter((value): value is number => value !== null)];
  // A floor and a ceiling with room to breathe, so the line never touches the
  // edge of its own box and a flat series does not collapse to a straight line
  // through the middle.
  const low = Math.min(...all);
  const high = Math.max(...all);
  const pad = (high - low) * 0.18 || Math.max(high * 0.05, 1);
  const min = low - pad;
  const max = high + pad;

  const W = 310;
  const H = 132;
  const x = (index: number) => (index / (mine.length - 1)) * W;
  const y = (value: number) => H - ((value - min) / (max - min)) * H;

  const line = (values: (number | null)[]) =>
    values
      .map((value, index) => (value === null ? null : `${x(index)},${y(value).toFixed(1)}`))
      .filter((point): point is string => point !== null)
      .join(' ');



  const last = mine[mine.length - 1]!;

  return (
    <>
      <svg viewBox={`-6 -10 ${W + 12} ${H + 20}`} className="block h-[150px] w-full overflow-visible" aria-hidden>
        <defs>
          <linearGradient id="halo-price-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#00A06A" stopOpacity=".16" />
            <stop offset="1" stopColor="#00A06A" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`0,${H} ${line(mine)} ${W},${H}`} fill="url(#halo-price-fill)" />
        {/* Dashed, and behind. It is the reference the reader is measured
            against, not a second thing they did. */}
        {marketRuns(market).map((run) =>
          run.length === 1 ? (
            <circle key={run[0]!.index} cx={x(run[0]!.index)} cy={y(run[0]!.value)} r="3" fill="#D1D6DB" />
          ) : (
            <polyline
              key={run[0]!.index}
              points={run.map((point) => `${x(point.index)},${y(point.value).toFixed(1)}`).join(' ')}
              fill="none"
              stroke="#D1D6DB"
              strokeWidth="2.5"
              strokeDasharray="5 5"
              strokeLinecap="round"
            />
          ),
        )}
        <polyline points={line(mine)} fill="none" stroke="#00A06A" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={W} cy={y(last)} r="5.5" fill="#fff" stroke="#00A06A" strokeWidth="3" />
      </svg>

      {/* Positioned at the point they label rather than spread by flexbox.
          Six months happen to space evenly; two years do not, and the reader
          would be matching a peak against the wrong month. */}
      <div className="relative mt-2 h-4">
        {ticks(labels.length).map((index) => (
          <span
            key={index}
            className="absolute top-0 text-[11.5px] font-medium whitespace-nowrap text-[#8B95A1]"
            style={{
              left: `${(index / (labels.length - 1)) * 100}%`,
              transform:
                index === 0
                  ? 'none'
                  : index === labels.length - 1
                    ? 'translateX(-100%)'
                    : 'translateX(-50%)',
            }}
          >
            {labels[index]}
          </span>
        ))}
      </div>
    </>
  );
}

/**
 * Which months get a label.
 *
 * Six at most, always including the first and the last. Twenty-four months of
 * labels overlap into a grey smear, and a reader who cannot tell one from
 * another has no axis at all.
 */
function ticks(count: number): number[] {
  if (count <= 6) return Array.from({ length: count }, (_, index) => index);

  const step = (count - 1) / 5;
  return [...new Set(Array.from({ length: 6 }, (_, index) => Math.round(index * step)))];
}

/**
 * The market series split into unbroken runs.
 *
 * A month whose corpus was under the floor has no price, and joining the
 * points either side of it draws a straight segment across the gap that looks
 * exactly like data. Dropping the nulls made it worse: the line appeared to
 * *start* at the first month that had one, so a series with two recent points
 * read as "the market only existed from August".
 *
 * A run of one is drawn as a dot — one month with a price is a fact, and a
 * line needs two.
 */
function marketRuns(market: (number | null)[]): { index: number; value: number }[][] {
  const runs: { index: number; value: number }[][] = [];

  market.forEach((value, index) => {
    if (value === null) return;
    const previous = runs[runs.length - 1];
    if (previous && previous[previous.length - 1]!.index === index - 1) previous.push({ index, value });
    else runs.push([{ index, value }]);
  });

  return runs;
}

export function ChartLegend({ mine, market }: { mine: string; market: string }) {
  return (
    <div className="mt-3 flex gap-4">
      <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[#8B95A1]">
        <i className="inline-block h-[3px] w-3.5 rounded-sm bg-[#00A06A]" />
        {mine}
      </span>
      <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[#8B95A1]">
        <i className="inline-block h-[3px] w-3.5 rounded-sm bg-[#D1D6DB]" />
        {market}
      </span>
    </div>
  );
}
