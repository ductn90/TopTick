import styles from './Segmented.module.css'

interface SegmentedProps<T extends string> {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange(value: T): void
  /** `data-testid` prefix; each option gets `<prefix>-<value>`. */
  testId: string
}

/** Segmented control built from native buttons with `aria-pressed`. */
export function Segmented<T extends string>({ label, value, options, onChange, testId }: SegmentedProps<T>): React.JSX.Element {
  return (
    <div className={styles.group} role="group" aria-label={label} data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={styles.option}
          aria-pressed={o.value === value}
          data-testid={`${testId}-${o.value}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
