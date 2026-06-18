import { Minus, Plus } from 'lucide-react';

const MIN = 0;
const MAX = 60;

interface Props {
    value: number;
    onChange: (value: number) => void;
}

function clamp(n: number): number {
    return Math.min(MAX, Math.max(MIN, Math.floor(n)));
}

/**
 * Stepper for business-day allowance (avoids native number-input spinner/focus quirks).
 */
export default function BusinessDaysControl({ value, onChange }: Props) {
    const safe = clamp(value);

    return (
        <div
            className="analytics-business-days"
            role="group"
            aria-label="Business days from order time before production is late"
        >
            <span className="analytics-business-days__label">Late after</span>
            <div className="analytics-business-days__stepper">
                <button
                    type="button"
                    className="analytics-business-days__btn"
                    aria-label="Fewer business days"
                    disabled={safe <= MIN}
                    onClick={() => onChange(clamp(safe - 1))}
                >
                    <Minus size={16} aria-hidden />
                </button>
                <span className="analytics-business-days__value" aria-live="polite">
                    {safe}
                </span>
                <button
                    type="button"
                    className="analytics-business-days__btn"
                    aria-label="More business days"
                    disabled={safe >= MAX}
                    onClick={() => onChange(clamp(safe + 1))}
                >
                    <Plus size={16} aria-hidden />
                </button>
            </div>
            <span className="analytics-business-days__suffix">
                business days from order time
            </span>
        </div>
    );
}
