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

type Preset = {
  id: 'shop' | 'host' | 'service';
  label: string;
  values: {
    inquiries: number;
    unansweredRate: number;
    conversionRate: number;
    averageOrder: number;
    hoursSaved: number;
    hourValue: number;
  };
};

const presets: Preset[] = [
  {
    id: 'shop',
    label: 'Online shop',
    values: { inquiries: 800, unansweredRate: 20, conversionRate: 20, averageOrder: 800, hoursSaved: 40, hourValue: 150 },
  },
  {
    id: 'host',
    label: 'Airbnb host',
    values: { inquiries: 320, unansweredRate: 25, conversionRate: 10, averageOrder: 3500, hoursSaved: 30, hourValue: 250 },
  },
  {
    id: 'service',
    label: 'Service team',
    values: { inquiries: 1500, unansweredRate: 15, conversionRate: 0, averageOrder: 0, hoursSaved: 100, hourValue: 180 },
  },
];

const peso = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  maximumFractionDigits: 0,
});

const number = new Intl.NumberFormat('en-PH', { maximumFractionDigits: 0 });

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

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
  const update = (nextValue: number) => {
    if (Number.isNaN(nextValue)) return;
    onChange(clamp(nextValue, min, max));
  };

  return (
    <div className="roi-field">
      <div className="roi-field__top">
        <label className="roi-field__label" htmlFor={`${id}-number`}>{label}</label>
        <span className="roi-field__input">
          {currency && <span aria-hidden="true">₱</span>}
          <input
            id={`${id}-number`}
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(event) => update(event.currentTarget.valueAsNumber)}
            aria-label={`Set ${label}`}
          />
          {suffix && <span aria-hidden="true">{suffix}</span>}
        </span>
      </div>
      <input
        id={`${id}-range`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => update(Number(event.currentTarget.value))}
        aria-label={`${label}: ${currency ? peso.format(value) : `${number.format(value)}${suffix}`}`}
      />
    </div>
  );
}

function metricClass(value: number) {
  return value >= 0 ? 'roi-metric is-positive' : 'roi-metric is-negative';
}

export function RoiCalculator() {
  const [activePreset, setActivePreset] = useState<string>('shop');
  const [inquiries, setInquiries] = useState(800);
  const [unansweredRate, setUnansweredRate] = useState(20);
  const [conversionRate, setConversionRate] = useState(20);
  const [averageOrder, setAverageOrder] = useState(800);
  const [hoursSaved, setHoursSaved] = useState(40);
  const [hourValue, setHourValue] = useState(150);

  const setCustom = (setter: (value: number) => void) => (value: number) => {
    setActivePreset('custom');
    setter(value);
  };

  const applyPreset = (preset: Preset) => {
    setActivePreset(preset.id);
    setInquiries(preset.values.inquiries);
    setUnansweredRate(preset.values.unansweredRate);
    setConversionRate(preset.values.conversionRate);
    setAverageOrder(preset.values.averageOrder);
    setHoursSaved(preset.values.hoursSaved);
    setHourValue(preset.values.hourValue);
  };

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
            <span className="roi-eyebrow">The ₱15,000 ORIN AI plan</span>
            <h2 id="roi-title">Put your numbers on it.</h2>
            <p>
              Start with a business like yours, then edit every value. The model shows what
              ORIN AI must recover or save each month to pay for itself.
            </p>
          </div>

          <aside className="price-card" aria-label="ORIN AI monthly plan">
            <span className="price-card__label">ORIN AI monthly plan</span>
            <strong>₱15,000</strong>
            <span className="price-card__period">per month</span>
            <ul>
              <li>Configured for your channels</li>
              <li>Answers from your business knowledge</li>
              <li>Human handoff and ongoing support</li>
            </ul>
            <a href="https://marvin.orin.work">See ORIN AI on your workflow</a>
          </aside>
        </header>

        <div className="roi-workbench">
          <form className="roi-controls" onSubmit={(event) => event.preventDefault()}>
            <div className="roi-controls__heading">
              <span>Choose a starting point</span>
              <button type="button" onClick={() => applyPreset(presets[0])}>Reset</button>
            </div>

            <div className="roi-presets" aria-label="Calculator starting points">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={activePreset === preset.id ? 'is-active' : ''}
                  aria-pressed={activePreset === preset.id}
                  onClick={() => applyPreset(preset)}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <p className="roi-controls__note">Use the sliders or type an exact number.</p>

            <RangeField id="inquiries" label="Customer messages each month" value={inquiries} min={0} max={10000} step={50} onChange={setCustom(setInquiries)} />
            <RangeField id="unanswered" label="Messages missed or answered late" value={unansweredRate} min={0} max={100} step={1} suffix="%" onChange={setCustom(setUnansweredRate)} />
            <RangeField id="conversion" label="Missed messages that become sales or bookings" value={conversionRate} min={0} max={100} step={1} suffix="%" onChange={setCustom(setConversionRate)} />
            <RangeField id="average-order" label="Average sale or booking" value={averageOrder} min={0} max={50000} step={100} currency onChange={setCustom(setAverageOrder)} />
            <RangeField id="hours-saved" label="Team hours Orin gives back" value={hoursSaved} min={0} max={400} step={5} suffix=" hrs" onChange={setCustom(setHoursSaved)} />
            <RangeField id="hour-value" label="Value of one team hour" value={hourValue} min={0} max={2000} step={25} currency onChange={setCustom(setHourValue)} />
          </form>

          <div className="roi-results" aria-live="polite">
            <p className="roi-formula">
              Missed inquiries × value created + team time returned − ₱15,000
            </p>
            <div className="roi-metrics">
              <article className="roi-metric">
                <span>Estimated value each month</span>
                <strong>{peso.format(model.estimatedValue)}</strong>
              </article>
              <article className={metricClass(model.monthlyNet)}>
                <span>After the ORIN AI plan</span>
                <strong>{netLabel}</strong>
              </article>
              <article className={metricClass(model.roi)}>
                <span>Estimated return</span>
                <strong>{roiLabel}</strong>
              </article>
            </div>

            <p className="roi-equation">
              <strong>{peso.format(model.estimatedValue)}</strong> in monthly value
              <span>−</span>
              <strong>{peso.format(MONTHLY_PRICE)}</strong> for ORIN AI
              <span>=</span>
              <strong className={model.monthlyNet >= 0 ? 'is-positive' : 'is-negative'}>{netLabel}</strong> after the plan
            </p>

            <div className="roi-charts">
              <article className="roi-chart roi-chart--bars">
                <div className="roi-chart__heading">
                  <div>
                    <span>One month</span>
                    <strong>Your estimate against the plan</strong>
                  </div>
                  <small>Break-even is ₱15,000</small>
                </div>
                <div className="bar-row">
                  <div className="bar-row__meta"><span>Your estimate</span><strong>{peso.format(model.estimatedValue)}</strong></div>
                  <div className="bar-track"><span className="bar-fill bar-fill--value" style={{ width: model.valueWidth }} /></div>
                </div>
                <div className="bar-row">
                  <div className="bar-row__meta"><span>ORIN AI plan</span><strong>{peso.format(MONTHLY_PRICE)}</strong></div>
                  <div className="bar-track"><span className="bar-fill bar-fill--cost" style={{ width: model.costWidth }} /></div>
                </div>
                <dl className="roi-breakdown">
                  <div><dt>Sales or bookings recovered</dt><dd>{peso.format(model.recoveredSales)}</dd></div>
                  <div><dt>Team time returned</dt><dd>{peso.format(model.timeValue)}</dd></div>
                </dl>
              </article>

              <article className="roi-chart roi-chart--line">
                <div className="roi-chart__heading">
                  <div>
                    <span>Twelve months</span>
                    <strong>If the monthly estimate holds</strong>
                  </div>
                  <div className="chart-legend"><span className="is-value">Value</span><span className="is-cost">Cost</span></div>
                </div>
                <svg viewBox="0 0 720 260" role="img" aria-labelledby="annual-chart-title annual-chart-desc">
                  <title id="annual-chart-title">Twelve-month estimated value and ORIN AI cost</title>
                  <desc id="annual-chart-desc">The green line shows the cumulative estimate from the values entered. The gold line shows the cumulative ORIN AI subscription cost.</desc>
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
              This is a planning model, not a promise. It uses {number.format(model.recoveredInquiries)} missed inquiries,
              {' '}{number.format(model.recoveredOrders)} possible sales or bookings, and the time values you entered.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
