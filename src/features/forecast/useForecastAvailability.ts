import { useEffect, useState } from 'react';
import { fetchForecastAvailability } from './availability';
import type { ForecastAvailability } from './availability';

const AVAILABILITY_TIMEOUT_MS = 6_000;

export interface ForecastAvailabilityState {
  availability: ForecastAvailability | null;
  settled: boolean;
}

// Re-read health whenever the selected forecast receives a new Retry-After
// cycle. That keeps partial runtime recovery discoverable without creating a
// second independent polling clock.
export function useForecastAvailability(retryCycleAtMs: number): ForecastAvailabilityState {
  const [state, setState] = useState<ForecastAvailabilityState>({
    availability: null,
    settled: false,
  });

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), AVAILABILITY_TIMEOUT_MS);
    let active = true;

    void fetchForecastAvailability(controller.signal).then((availability) => {
      if (!active) return;
      setState({ availability, settled: true });
    });

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [retryCycleAtMs]);

  return state;
}
