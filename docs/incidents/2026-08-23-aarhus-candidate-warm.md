# Aarhus candidate warm incident — 2026-08-23

Status: resolved. Times below are UTC (CEST was UTC+2).

## Impact

The zero-traffic model-35 candidate remained unpromoted while Aarhus could not
complete its first generation build. Production stayed safely on model 33 and
Pages did not deploy. Horsens, Vejle, and Kolding were ready throughout.

## What CI attempted

[Workflow run 32625980604](https://github.com/Gromykko/FRANK/actions/runs/32625980604)
had seven attempts. GitHub did not automatically rerun the job: attempt 1 came
from the push, attempts 2–6 were manual failed-job reruns during investigation,
and attempt 7 was the repository owner's manual failed-job rerun.

Each failed warm job called Aarhus once, waited for the advertised remaining
cooldown, and called it once more. The second call renewed the cooldown to 600
seconds, which no longer fitted inside the script's 13-minute deadline.

| Attempt | Warm started | First Aarhus wait | Actual retry → next wait | Result |
| --- | --- | ---: | --- | --- |
| 1 | 07:38:10 | 219 s | 07:41:52 → 600 s | failed closed |
| 2 | 07:42:34 | 557 s | 07:51:54 → 600 s | failed closed |
| 3 | 07:52:43 | 550 s | 08:01:56 → 600 s | failed closed |
| 4 | 08:03:35 | 500 s | 08:11:59 → 600 s | failed closed |
| 5 | 08:15:49 | 368 s | 08:22:01 → 600 s | failed closed |
| 6 | 08:23:28 | 511 s | 08:32:02 → 600 s | failed closed; investigation reruns stopped |
| 7 | 08:45:32 | none | none | Aarhus ready at 08:45:35 |

That is six outer warm-script retries and 13 Aarhus preview-endpoint calls:
seven initial calls plus one retry in each of attempts 1–6. The candidate itself
allowed one bounded attempt per provider stage in each warm invocation; these
were not rapid in-Worker DMI retries. All failed-job reruns reused candidate
`8a9fd35d-f91d-45fd-955f-0ece2d902139`.

Attempt 6 stopped at 08:32:02. Its next eligible Aarhus call was approximately
08:42:02, but its script deadline was approximately 08:36:29. The warm step in
the owner's next manual rerun began at 08:45:32, returned Aarhus 200 at 08:45:35,
promoted the candidate, and completed Pages deployment at 08:46:18.

## Why the final attempt succeeded

Aarhus was assembled during attempt 7; it was not an existing model-35 assembled
forecast. Raw MET and marine ingredients are deliberately shared across release
generations, and successful ingredient writes are not rolled back when a full
build later fails. Earlier candidate attempts or the still-live production cron
therefore could leave reusable raw ingredients in KV. Historical invocation logs
are required to identify which one wrote the retained Aarhus wave entry.

The final payload still reported `degradedSources: ["waves"]` and
`providerBusy: true`: it combined the available inputs with retained last-good
wave data. This was not a complete DMI recovery and was not an old model-33
assembled payload. Production then reported HTTP 200 on model 35 with all four
locations ready; Kolding was green.

An independent, rate-compliant diagnostic made 1,000 direct Aarhus DMI position
requests: 986 returned HTTP 429, 14 timed out or were aborted, none returned 200,
and no 429 included `Retry-After`. Those requests did not pass through the Worker
and could not write its KV.

## Follow-up

The 25-minute script window and 30-minute Actions limit were a mitigation, not
the fix. The initialization cooldown is now a reader policy: public forecast
requests still receive the original 600-second crowd-control delay, while the
single authenticated, serial deployment warmer receives 90 seconds. The marker
format, its stored 600-second value, and its validation are unchanged. The warm
window is consequently 16 minutes and the Actions job limit is 20
minutes; warming, promotion, and Pages still fail closed if the gate expires.

Ninety seconds balances recovery with provider load. In 16 minutes, one
struggling city gets six to eleven attempts depending on its serial position and
response duration. If all five configured locations each consume the full
30-second caller allowance, six complete serial passes finish in 15 minutes.
A 60-second cooldown would not add another guaranteed all-location pass and
would align every retry with the one-minute cron; 120 seconds would reduce
quick-failure retry opportunities without improving the serial-load bound.

During a deploy, the modelled live-cron paths spend at most 44 external requests
in one invocation, including at most 36 to DMI. One candidate location can spend
at most 13 external requests, including five to DMI, one to MET, and seven in the
warnings pipeline. The warmer is serial. Even pessimistically charging one
whole live-cron event and all five warm calls to the same five-second window is
`44 + (5 x 13) = 109` total requests across six separately bounded
invocations. Per provider that is at most 61 DMI requests, six MET requests,
and 42 warning fetches. DMI's documented fair-use ceiling is
[500 requests per five seconds](https://www.dmi.dk/friedata/dokumentation/basics),
so the deliberately overstated DMI burst is 12.2% of the ceiling; retry delays
and serial warm calls make the real peak lower. MET asks clients exceeding
[20 requests per second](https://docs.api.met.no/doc/TermsOfService.html) to
make an agreement, while this bound is six requests total. Warning feed and
detail responses also use the existing five-minute edge cache. Cloudflare's
subrequest limit remains per invocation: the live event stays at or below 44
and each candidate event at or below 13.
