import { useMemo, useState } from 'react';

const MONTHLY_PRICE = 15_000;

type RangeFieldProps = {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  currency?: boolean;
  onChange: (value: number) => void;
};

const peso = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  maximumFractionDigits: 0,
});

const number = new Intl.NumberFormat('en-PH', { maximumFractionDigits: 0 });

function RangeField({
  id,
  label,
  value,
  min,
  max,
  step,
  suffix = '',
  currency = false,
  onChange,
}: RangeFieldProps) {
  const display = currency ? peso.format(value) : `${number.format(value)}${suffix}`;

  return (
    <label className="roi-field" htmlFor={id}>
      <span className="roi-field__label">{label}</span>
      <output className="roi-field__value" htmlFor={id}>{display}</output>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function metricClass(value: number) {
  return value >= 0 ? 'roi-metric is-positive' : 'roi-metric is-negative';
}

export function RoiCalculator() {
  const [inquiries, setInquiries] = useState(800);
  const [unansweredRate, setUnansweredRate] = useState(20);
  const [conversionRate, setConversionRate] = useState(20);
  const [averageOrder, setAverageOrder] = useState(800);
  const [hoursSaved, setHoursSaved] = useState(40);
  const [hourValue, setHourValue] = useState(150);

  const model = useMemo(() => {
    const recoveredInquiries = inquiries * (unansweredRate / 100);
    const recoveredOrders = recoveredInquiries * (conversionRate / 100);
    const recoveredSales = recoveredOrders * averageOrder;
    const timeValue = hoursSaved * hourValue;
    const estimatedValue = recoveredSales + timeValue;
    const monthlyNet = estimatedValue - MONTHLY_PRICE;
    const roi = (monthlyNet / MONTHLY_PRICE) * 100;
    const chartMax = Math.max(MONTHLY_PRICE, estimatedValue, 1);

    const months = Array.from({ length: 13 }, (_, month) => ({
      month,
      value: estimatedValue * month,
      cost: MONTHLY_PRICE * month,
    }));
    const annualMax = Math.max(estimatedValue * 12, MONTHLY_PRICE * 12, 1);
    const x = (month: number) => 42 + (month / 12) * 636;
    const y = (value: number) => 226 - (value / annualMax) * 184;
    const valuePoints = months.map((point) => `${x(point.month)},${y(point.value)}`).join(' ');
    const costPoints = months.map((point) => `${x(point.month)},${y(point.cost)}`).join(' ');

    return {
      recoveredInquiries,
      recoveredOrders,
      recoveredSales,
      timeValue,
      estimatedValue,
      monthlyNet,
      roi,
      valueWidth: `${Math.max(3, (estimatedValue / chartMax) * 100)}%`,
      costWidth: `${Math.max(3, (MONTHLY_PRICE / chartMax) * 100)}%`,
      valuePoints,
      costPoints,
    };
  }, [averageOrder, conversionRate, hourValue, hoursSaved, inquiries, unansweredRate]);

  const roiLabel = `${model.roi >= 0 ? '+' : ''}${number.format(model.roi)}%`;
  const netLabel = `${model.monthlyNet >= 0 ? '+' : '−'}${peso.format(Math.abs(model.monthlyNet))}`;

  return (
    <section id="roi" className="roi-section" aria-labelledby="roi-title">
      <div className="roi-shell">
        <header className="roi-heading">
          <div>
            <span className="roi-eyebrow">One plan. Your numbers.</span>
            <h2 id="roi-title">₱15,000 a month.<br />See what must come back.</h2>
            <p>
              ORIN should earn its place by answering missed demand and reducing routine work.
              Move the inputs to model your own operation.
            </p>
          </div>

          <aside className="price-card" aria-label="ORIN monthly plan">
            <span className="price-card__label">ORIN monthly plan</span>
            <strong>₱15,000</strong>
            <span className="price-card__period">per month</span>
            <ul>
              <li>Messenger inquiry handling</li>
              <li>Voice note and image understanding</li>
              <li>Business-specific answers and handoff</li>
            </ul>
            <a href="https://marvin.orin.work">Book an ORIN walkthrough</a>
          </aside>
        </header>

        <div className="roi-workbench">
          <form className="roi-controls" onSubmit={(event) => event.preventDefault()}>
            <div className="roi-controls__heading">
              <span>Use your actual figures</span>
              <button
                type="button"
                onClick={() => {
                  setInquiries(800);
                  setUnansweredRate(20);
                  setConversionRate(20);
                  setAverageOrder(800);
                  setHoursSaved(40);
                  setHourValue(150);
                }}
              >
                Reset
              </button>
            </div>

            <RangeField id="inquiries" label="Messages received each month" value={inquiries} min={50} max={5000} step={50} onChange={setInquiries} />
            <RangeField id="unanswered" label="Messages missed or answered late" value={unansweredRate} min={0} max={60} step={1} suffix="%" onChange={setUnansweredRate} />
            <RangeField id="conversion" label="Missed messages that become sales" value={conversionRate} min={1} max={60} step={1} suffix="%" onChange={setConversionRate} />
            <RangeField id="average-order" label="Average sale" value={averageOrder} min={100} max={5000} step={100} currency onChange={setAverageOrder} />
            <RangeField id="hours-saved" label="Hours ORIN could save" value={hoursSaved} min={0} max={200} step={5} suffix=" hrs" onChange={setHoursSaved} />
            <RangeField id="hour-value" label="Value of one team hour" value={hourValue} min={50} max={1000} step={25} currency onChange={setHourValue} />
          </form>

          <div className="roi-results" aria-live="polite">
            <p className="roi-formula">
              Missed messages × sales rate × average sale + time saved = estimated monthly value
            </p>
            <div className="roi-metrics">
              <article className="roi-metric">
                <span>Potential monthly value</span>
                <strong>{peso.format(model.estimatedValue)}</strong>
              </article>
              <article className={metricClass(model.monthlyNet)}>
                <span>Net after ₱15,000 fee</span>
                <strong>{netLabel}</strong>
              </article>
              <article className={metricClass(model.roi)}>
                <span>Return on subscription</span>
                <strong>{roiLabel}</strong>
              </article>
            </div>

            <p className="roi-equation">
              <strong>{peso.format(model.estimatedValue)}</strong> estimated monthly value
              <span>−</span>
              <strong>{peso.format(MONTHLY_PRICE)}</strong> ORIN plan
              <span>=</span>
              <strong className={model.monthlyNet >= 0 ? 'is-positive' : 'is-negative'}>{netLabel}</strong> estimated net value
            </p>

            <div className="roi-charts">
              <article className="roi-chart roi-chart--bars">
                <div className="roi-chart__heading">
                  <div>
                    <span>Monthly comparison</span>
                    <strong>Value against price</strong>
                  </div>
                  <small>Break-even is ₱15,000</small>
                </div>
                <div className="bar-row">
                  <div className="bar-row__meta"><span>Estimated value</span><strong>{peso.format(model.estimatedValue)}</strong></div>
                  <div className="bar-track"><span className="bar-fill bar-fill--value" style={{ width: model.valueWidth }} /></div>
                </div>
                <div className="bar-row">
                  <div className="bar-row__meta"><span>ORIN monthly plan</span><strong>{peso.format(MONTHLY_PRICE)}</strong></div>
                  <div className="bar-track"><span className="bar-fill bar-fill--cost" style={{ width: model.costWidth }} /></div>
                </div>
                <dl className="roi-breakdown">
                  <div><dt>Potential recovered sales</dt><dd>{peso.format(model.recoveredSales)}</dd></div>
                  <div><dt>Team time value</dt><dd>{peso.format(model.timeValue)}</dd></div>
                </dl>
              </article>

              <article className="roi-chart roi-chart--line">
                <div className="roi-chart__heading">
                  <div>
                    <span>12-month picture</span>
                    <strong>Cumulative estimate</strong>
                  </div>
                  <div className="chart-legend"><span className="is-value">Value</span><span className="is-cost">Cost</span></div>
                </div>
                <svg viewBox="0 0 720 260" role="img" aria-labelledby="annual-chart-title annual-chart-desc">
                  <title id="annual-chart-title">Twelve-month cumulative value and ORIN cost</title>
                  <desc id="annual-chart-desc">The green line shows the estimated cumulative business value. The gold line shows the cumulative ORIN subscription cost.</desc>
                  {[42, 88, 134, 180, 226].map((row) => <line key={row} x1="42" y1={row} x2="678" y2={row} className="chart-grid" />)}
                  <polyline points={model.costPoints} className="chart-line chart-line--cost" />
                  <polyline points={model.valuePoints} className="chart-line chart-line--value" />
                  {[0, 3, 6, 9, 12].map((month) => (
                    <text key={month} x={42 + (month / 12) * 636} y="252" textAnchor={month === 0 ? 'start' : month === 12 ? 'end' : 'middle'}>
                      {month === 0 ? 'Now' : `${month} mo`}
                    </text>
                  ))}
                </svg>
              </article>
            </div>

            <p className="roi-note">
              Planning estimate, not a guarantee. It models {number.format(model.recoveredInquiries)} recovered inquiries,
              {' '}{number.format(model.recoveredOrders)} potential orders, and the time values you entered.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
